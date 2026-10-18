import { applyHealing, tryFire, trySword, tryReload, switchMode, expireTimers } from './combat.js';
import { makeArena } from './arena.js';
import { DT, LAST_STAND, LOCAL_AI, MAIN, RIFLE, SOLDIER, SQUAD, SQUAD_CONTROL_INTERVAL, START_SOLDIERS, SUPPLY, WAVE, } from './constants.js';
import { resolveCollisions } from './collision.js';
import { executeCommand } from './commands.js';
import { expireStreaks, processSupply, processWave, registerStreakKill } from './economy.js';
import { defaultMainGoal, thinkMain } from './mainAI.js';
import { stepMovement } from './movement.js';
import { NavGrid } from './pathfinding.js';
import { Rng, deriveSeed } from './rng.js';
import { thinkSoldier } from './soldierAI.js';
import { newSquad, onActorDeath, squadControl } from './squads.js';
import { refreshVisibility } from './visibility.js';
const KEY_EVENTS = new Set(['kill', 'wave', 'streakStart', 'streakEnd', 'pickupSpawn', 'pickupTaken', 'end', 'stance', 'overload']);
function blankAI() {
    return {
        task: 'Idle',
        targetId: -1,
        targetSince: 0,
        nextThink: 0,
        blocked: false,
        blockedUntil: 0,
        blockedFails: 0,
        engagementStart: -1,
        hitsInEngagement: 0,
        withdrawing: false,
        lastOpponentId: -1,
        lastRefillTick: -1_000_000,
        bodyguard: false,
        goalX: 0,
        goalY: 0,
        progressTick: 0,
        progressX: 0,
        progressY: 0,
    };
}
/**
 * The authoritative GangUP simulation. A fixed 60 Hz step; nothing outside tick() may advance physics or apply
 * damage. Tick order follows GDD 17.2 exactly.
 */
export class Match {
    arena;
    nav;
    seed;
    config;
    rngSpread;
    rngSpawn;
    tick = 0;
    actors = new Map();
    /** living actors in stable ID order (dead actors stay reachable via `actors` for ID lookups) */
    live = [];
    teams;
    damageLog = [];
    contactPairs = new Map();
    pickup = null;
    result = { over: false, winner: null, reason: '', tick: 0 };
    listeners = [];
    /** notified for every executed command with its validation result (used by the AI director for feedback) */
    commandListeners = [];
    replay;
    idCounter = 1;
    seqCounter = 0;
    queue = [];
    commandLog = [];
    constructor(config) {
        this.config = config;
        this.seed = config.seed >>> 0;
        this.rngSpread = new Rng(deriveSeed(this.seed, 'spread'));
        this.rngSpawn = new Rng(deriveSeed(this.seed, 'spawn'));
        this.arena = makeArena();
        this.nav = new NavGrid(this.arena);
        this.replay = { version: 1, seed: this.seed, config: { humanTeam: config.humanTeam }, inputs: [], events: [] };
        const mkTeam = (id) => ({
            id,
            mainId: -1,
            stance: 'defensive', // default stance is Defensive (14.1)
            squads: Array.from({ length: SQUAD.slots }, (_, i) => newSquad(i + 1)),
            bodyguards: [],
            bodyguardLockoutUntil: 0,
            streak: { active: false, kills: [], activatedAt: -1, activeUntil: -1, cooldownUntil: -1, activations: 0 },
            teamVisible: new Set(),
            lastKnown: new Map(),
            mainGoal: { kind: 'HoldNear', x: 0, y: 0, targetId: -1, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER },
            collapseStart: -1,
            surrendered: false,
            humanControlled: config.humanTeam === id,
            controls: { throttle: 0, turn: 0 },
            waves: [],
            aiGeneration: 0,
            soldiersSpawned: 0,
        });
        this.teams = [mkTeam(0), mkTeam(1)];
        for (const t of [0, 1])
            this.initTeam(t);
    }
    // ------------------------------------------------------------------ construction helpers
    nextSeq() {
        return ++this.seqCounter;
    }
    blankActor(team, kind, x, y, theta) {
        const base = kind === 'main' ? MAIN : SOLDIER;
        const spec = kind === 'main' ? RIFLE.main : RIFLE.soldier;
        const a = {
            id: this.idCounter++, // IDs are never recycled within a match
            team,
            kind,
            x,
            y,
            px: x,
            py: y,
            theta,
            speed: 0,
            radius: base.radius,
            hp: base.hp,
            hpMax: base.hp,
            shield: base.shield,
            shieldMax: base.shield,
            alive: true,
            deathTick: -1,
            mode: 'rifle',
            mag: spec.mag,
            reserve: spec.carry - spec.mag, // Main 10/40, soldier 6/18
            nextFireTick: 0,
            reloadEnd: -1,
            nextSwordTick: 0,
            strain: 0,
            lastSwordAttempt: -1_000_000,
            overloadEnd: -1,
            lastCombatTick: -1_000_000,
            lastHealTick: -1_000_000,
            throttle: 0,
            turn: 0,
            wantFire: false,
            wantSwipe: false,
            wantThrust: false,
            wantReload: false,
            wantSwitch: false,
            squadSlot: 0,
            sees: [],
            eligibleHeal: 0,
            stats: { shots: 0, hits: 0, damageDealt: 0, kills: 0 },
            ai: blankAI(),
        };
        this.actors.set(a.id, a);
        this.live.push(a);
        return a;
    }
    createSoldier(team, x, y, theta) {
        const a = this.blankActor(team, 'soldier', x, y, theta);
        this.teams[team].soldiersSpawned++;
        this.emit('spawn', { actor: a.id, team });
        return a;
    }
    initTeam(team) {
        const sp = this.arena.mainSpawn[team];
        const main = this.blankActor(team, 'main', sp.x, sp.y, sp.theta);
        this.teams[team].mainId = main.id;
        this.teams[team].mainGoal = defaultMainGoal(this, team);
        const dir = team === 0 ? 1 : -1;
        const offsets = [[3.2, -3.4], [3.2, 3.4], [5.4, -1.7], [5.4, 1.7]];
        for (let i = 0; i < START_SOLDIERS; i++) {
            this.createSoldier(team, sp.x + dir * offsets[i][0], sp.y + offsets[i][1], sp.theta);
        }
    }
    // ------------------------------------------------------------------ queries
    getActor(id) {
        return this.actors.get(id);
    }
    mainOf(team) {
        return this.actors.get(this.teams[team].mainId);
    }
    soldiers(team) {
        return this.live.filter((a) => a.alive && a.team === team && a.kind === 'soldier');
    }
    get timeSec() {
        return this.tick * DT;
    }
    emit(type, data = {}) {
        const e = { tick: this.tick, type, ...data };
        for (const l of this.listeners)
            l(e);
        if (KEY_EVENTS.has(type))
            this.replay.events.push(e);
    }
    // ------------------------------------------------------------------ input
    /** Queue a validated command; it is applied at tick step 2 in submission order. */
    submit(env) {
        this.queue.push(env);
        if (env.source === 'human')
            this.replay.inputs.push({ tick: this.tick, team: env.team, kind: 'cmd', data: env.cmd });
    }
    /** Held-key movement for a human Main: throttle -1..1 (S..W) and turn -1..1 (A..D). */
    setControls(team, throttle, turn) {
        const c = this.teams[team].controls;
        if (c.throttle !== throttle || c.turn !== turn) {
            c.throttle = throttle;
            c.turn = turn;
            this.replay.inputs.push({ tick: this.tick, team, kind: 'ctl', data: { throttle, turn } });
        }
    }
    /** One-shot Main action from the player (rifle fire / swipe / thrust / reload / mode switch). */
    mainAction(team, action) {
        const a = this.mainOf(team);
        if (!a.alive || !this.teams[team].humanControlled)
            return;
        this.replay.inputs.push({ tick: this.tick, team, kind: 'act', data: action });
        if (action === 'fire')
            a.wantFire = true;
        else if (action === 'swipe')
            a.wantSwipe = true;
        else if (action === 'thrust')
            a.wantThrust = true;
        else if (action === 'reload')
            a.wantReload = true;
        else
            a.wantSwitch = true;
    }
    // ------------------------------------------------------------------ the tick (GDD 17.2)
    step() {
        if (this.result.over)
            return;
        const t = this.tick;
        this.damageLog = [];
        // (1) expire buffs and cooldowns
        expireStreaks(this);
        for (const a of this.live)
            if (a.alive)
                expireTimers(this, a);
        // (2) validate commands and sample movement inputs; run controllers
        const pending = this.queue;
        this.queue = [];
        for (const env of pending) {
            if (env.issuedAt > t) {
                this.queue.push(env); // not due yet (reaction latency)
                continue;
            }
            const r = executeCommand(this, env);
            for (const l of this.commandListeners)
                l(env, r);
            if (this.commandLog.length < 4000)
                this.commandLog.push({ tick: t, team: env.team, source: env.source, cmd: env.cmd.t, ok: r.ok, reason: r.reason });
        }
        for (const ts of this.teams) {
            const main = this.actors.get(ts.mainId);
            if (!main.alive)
                continue;
            if (ts.humanControlled) {
                main.throttle = ts.controls.throttle;
                main.turn = ts.controls.turn;
            }
            else if ((t + main.id) % LOCAL_AI.controllerInterval === 0)
                thinkMain(this, main);
        }
        if (t % SQUAD_CONTROL_INTERVAL === 0)
            squadControl(this);
        for (const a of this.live) {
            if (a.alive && a.kind === 'soldier' && (a.id + t) % LOCAL_AI.controllerInterval === 0)
                thinkSoldier(this, a);
        }
        // (3) movement, rotation and collision
        for (const a of this.live) {
            if (!a.alive)
                continue;
            a.px = a.x;
            a.py = a.y;
            stepMovement(this, a);
        }
        resolveCollisions(this);
        // (4) refresh visibility and validate attacks against present geometry
        refreshVisibility(this);
        for (const a of this.live) {
            if (!a.alive)
                continue;
            if (a.wantSwitch) {
                switchMode(a);
                a.wantSwitch = false;
            }
            if (a.wantReload) {
                tryReload(this, a);
                a.wantReload = false;
            }
            // (5) damage and shield interception happen inside the attack calls, in stable actor-ID order
            if (a.wantFire) {
                tryFire(this, a);
                a.wantFire = false;
            }
            if (a.wantSwipe) {
                trySword(this, a, 'swipe');
                a.wantSwipe = false;
            }
            if (a.wantThrust) {
                trySword(this, a, 'thrust');
                a.wantThrust = false;
            }
        }
        // (6) mark deaths and determine kill attribution (all deaths this tick are simultaneous)
        const dying = this.live.filter((a) => a.alive && a.hp <= 0);
        const kills = [];
        for (const v of dying) {
            const contrib = new Map();
            for (const e of this.damageLog) {
                if (e.victim !== v.id || e.kind === 'collision' || e.attacker < 0)
                    continue;
                const cur = contrib.get(e.attacker);
                if (cur)
                    cur.applied += e.applied;
                else
                    contrib.set(e.attacker, { applied: e.applied, seq: e.seq });
            }
            let killer = null;
            let best = -1;
            let bestSeq = Infinity;
            for (const [id, c] of [...contrib.entries()].sort((p, q) => p[0] - q[0])) {
                // largest applied body damage; ties by damage-event sequence, then actor ID
                if (c.applied > best + 1e-9 || (Math.abs(c.applied - best) <= 1e-9 && c.seq < bestSeq)) {
                    best = c.applied;
                    bestSeq = c.seq;
                    killer = this.actors.get(id) ?? null;
                }
            }
            kills.push({ victim: v, killer });
        }
        for (const { victim, killer } of kills) {
            victim.alive = false;
            victim.hp = 0;
            victim.deathTick = t;
            victim.sees = [];
            victim.throttle = victim.turn = 0;
            victim.wantFire = victim.wantSwipe = victim.wantThrust = victim.wantReload = victim.wantSwitch = false;
            victim.ai.task = 'Defeated';
            if (killer)
                killer.stats.kills++;
            onActorDeath(this, victim);
            this.emit('kill', { victim: victim.id, victimKind: victim.kind, team: victim.team, killer: killer ? killer.id : -1 });
        }
        // Main defeat is terminal immediately; both Mains in one tick is a draw (before any healing/wave) (14.5)
        const m0 = this.mainOf(0);
        const m1 = this.mainOf(1);
        if (!m0.alive && !m1.alive)
            this.finish(null, 'Both Mains were defeated on the same tick', t);
        else if (!m0.alive)
            this.finish(1, 'Green Main defeated', t);
        else if (!m1.alive)
            this.finish(0, 'Red Main defeated', t);
        if (!this.result.over) {
            // (7) eligible healing for surviving Mains (death determination already complete)
            for (const a of this.live)
                applyHealing(this, a);
            // (8) streak activation from valid credited soldier kills
            for (const { victim, killer } of kills) {
                if (victim.kind !== 'soldier' || !killer || killer.kind !== 'main' || !killer.alive || killer.team === victim.team)
                    continue;
                registerStreakKill(this, killer);
            }
            // (9) reinforcement waves and supply
            if (t > 0 && t % WAVE.interval === 0)
                processWave(this);
            processSupply(this, t > 0 && t % SUPPLY.interval === 0);
            // (10) Last Stand Collapse and surrender
            this.evaluateTerminal(t);
        }
        else {
            for (const a of this.live)
                a.eligibleHeal = 0;
        }
        // (11) bookkeeping for the next tick
        this.live = this.live.filter((a) => a.alive);
        this.tick++;
    }
    evaluateTerminal(t) {
        const collapsed = [false, false];
        for (const ts of this.teams) {
            const main = this.actors.get(ts.mainId);
            const soldiers = this.live.filter((a) => a.alive && a.team === ts.id && a.kind === 'soldier').length;
            const cond = main.alive && main.hp < LAST_STAND.hpBelow && soldiers === 0;
            if (cond) {
                if (ts.collapseStart < 0)
                    ts.collapseStart = t;
                if (t - ts.collapseStart >= LAST_STAND.duration)
                    collapsed[ts.id] = true;
            }
            else
                ts.collapseStart = -1; // resets whenever either condition becomes false
        }
        const surrendered = [this.teams[0].surrendered, this.teams[1].surrendered];
        if (surrendered[0] && surrendered[1])
            this.finish(null, 'Both sides surrendered', t);
        else if (surrendered[0])
            this.finish(1, 'Green surrendered', t);
        else if (surrendered[1])
            this.finish(0, 'Red surrendered', t);
        else if (collapsed[0] && collapsed[1])
            this.finish(null, 'Both sides suffered Last Stand Collapse', t);
        else if (collapsed[0])
            this.finish(1, 'Green suffered Last Stand Collapse', t);
        else if (collapsed[1])
            this.finish(0, 'Red suffered Last Stand Collapse', t);
    }
    finish(winner, reason, t) {
        this.result = { over: true, winner, reason, tick: t };
        this.queue = []; // terminal state cancels future commands and spawning
        this.emit('end', { winner, reason });
    }
    /** Run n ticks (convenience for headless use). */
    run(n) {
        for (let i = 0; i < n && !this.result.over; i++)
            this.step();
    }
}
//# sourceMappingURL=match.js.map