import { LAST_STAND, SWORD } from '../../engine/constants.js';
/**
 * Turns what happens in a match into sounds. It only listens (engine events, accepted/rejected human commands, a per-frame look at
 * the player's Main) and never writes to the simulation, so replays and determinism are untouched.
 *
 * The same hidden-information rule as the renderer applies: an enemy is only heard (gunfire, deaths, overloads) while the player's
 * team can see it. The one exception is damage the player suffers, which is always audible.
 */
const LOW_HP = 20;
const CRITICAL_HP = 10;
const LOW_AMMO = 2;
const STRAIN_WARN = SWORD.strainMax * 0.75;
const STRAIN_REARM = SWORD.strainMax * 0.5;
const HUMAN_ORDER = new Set(['SquadMove', 'SquadFollow', 'SquadHold', 'SquadDoctrine', 'SquadFormation', 'SquadTarget', 'SquadLeader', 'SquadRally', 'MainGoal']);
const SQUAD_EDIT = new Set(['CreateSquad', 'DisbandSquad', 'AddToSquad', 'RemoveFromSquad']);
export class GameAudio {
    m;
    team;
    audio;
    dead = false;
    paused = false;
    started = false;
    first = { enemy: false, enemyMain: false };
    prev = { hp: 100, shield: 1, mode: 'rifle', reloading: false, mag: 99, strain: 0, overloaded: false, lowArmed: true, critArmed: true, strainArmed: true, lastStandTick: -1, lastStand: false };
    constructor(m, team, audio) {
        this.m = m;
        this.team = team;
        this.audio = audio;
        m.listeners.push((e) => { if (!this.dead)
            this.onEvent(e); });
        m.commandListeners.push((env, res) => { if (!this.dead)
            this.onCommand(env, res); });
    }
    play(id, o) {
        this.audio.play(id, o);
    }
    // ------------------------------------------------------------------ helpers
    get main() { return this.m.mainOf(this.team); }
    seen(id) {
        const a = this.m.actors.get(id);
        return !!a && (a.team === this.team || this.m.teams[this.team].teamVisible.has(id));
    }
    /** Stereo position and distance falloff of a world point relative to the player's Main. */
    at(x, y, floor = 0.25) {
        const me = this.main;
        const dx = x - me.x, dy = y - me.y;
        return { pan: Math.max(-1, Math.min(1, dx / 35)) * 0.8, volume: Math.max(floor, Math.min(1, 1 - Math.hypot(dx, dy) / 80)) };
    }
    // ------------------------------------------------------------------ engine events
    onEvent(e) {
        const A = (id) => this.m.actors.get(id);
        const me = this.main;
        switch (e.type) {
            case 'shot': {
                const shooter = A(e.actor);
                if (!shooter)
                    return;
                const victim = e.victim !== undefined ? A(e.victim) : undefined;
                const mine = shooter.id === me.id;
                const ally = !mine && shooter.team === this.team;
                const shooterKnown = this.seen(e.actor);
                if (mine)
                    this.play('shoot_main');
                else if (ally)
                    this.play('shoot_ally', this.at(shooter.x, shooter.y));
                else if (shooterKnown)
                    this.play('shoot_enemy', this.at(shooter.x, shooter.y));
                if (!victim) {
                    if (e.result === 'cover' && (shooterKnown || mine))
                        this.play('bullet_cover', this.at(e.x1, e.y1));
                    return;
                }
                if (e.result === 'shield') {
                    if (victim.id === me.id || shooterKnown)
                        this.play('hit_shield_block', this.at(victim.x, victim.y, 0.5));
                }
                else if (e.result === 'body') {
                    if (victim.id === me.id)
                        this.play('got_shot');
                    else if (victim.team === this.team)
                        this.play('ally_hurt', this.at(victim.x, victim.y));
                    else if (mine)
                        this.play('hit_landed');
                    else if (ally)
                        this.play('hit_landed', { volume: 0.4, ...this.at(victim.x, victim.y) });
                }
                break;
            }
            case 'sword': {
                const a = A(e.actor);
                if (!a)
                    return;
                const hits = (e.hits ?? []);
                if (a.id === me.id) {
                    this.play(e.kind === 'thrust' ? 'sword_thrust' : 'sword_swing');
                    if (hits.length)
                        this.play('sword_hit');
                }
                else if (this.seen(a.id)) {
                    this.play('sword_swing', { ...this.at(a.x, a.y), volume: 0.6 * (this.at(a.x, a.y).volume ?? 1) });
                }
                if (hits.includes(me.id))
                    this.play('got_hit_melee');
                break;
            }
            case 'contact': {
                const a = A(e.a), b = A(e.b);
                if (!a || !b)
                    return;
                if (a.id === me.id || b.id === me.id)
                    this.play('got_hit_melee', { volume: 0.7 });
                else if (this.seen(a.id) || this.seen(b.id))
                    this.play('contact_bump', this.at((a.x + b.x) / 2, (a.y + b.y) / 2));
                break;
            }
            case 'overload': {
                if (e.actor === me.id)
                    this.play('overload');
                else if (this.seen(e.actor)) {
                    const a = A(e.actor);
                    this.play('overload_enemy', a ? this.at(a.x, a.y) : undefined);
                }
                break;
            }
            case 'kill': {
                const v = A(e.victim);
                if (!v)
                    return;
                if (v.kind === 'main')
                    this.play(v.team === this.team ? 'main_down_own' : 'main_down_enemy');
                else if (v.team === this.team)
                    this.play('soldier_down_ally', this.at(v.x, v.y));
                else if (this.seen(v.id))
                    this.play('soldier_down_enemy', this.at(v.x, v.y));
                if (e.killer === me.id && v.kind !== 'main')
                    this.play('kill_confirm');
                break;
            }
            case 'heal':
                if (e.actor === me.id)
                    this.play('heal');
                break;
            case 'reloaded':
                if (e.actor === me.id)
                    this.play('reload_finish');
                break;
            case 'wave':
                if (e.team === this.team && e.spawned > 0)
                    this.play('wave_arrival');
                break;
            case 'pickupSpawn':
                this.play('supply_spawn');
                break;
            case 'pickupTaken':
                this.play(e.team === this.team ? 'supply_taken' : 'supply_taken_enemy');
                break;
            case 'streakStart':
                this.play(e.team === this.team ? 'streak_start' : 'streak_enemy_start');
                break;
            case 'streakEnd':
                this.play(e.team === this.team ? 'streak_end' : 'streak_enemy_end');
                break;
            case 'stance':
                if (e.team === this.team)
                    this.play('stance_switch');
                break;
            case 'end': {
                this.audio.setLoop('heartbeat', false);
                this.audio.setLoop('heartbeat_fast', false);
                this.audio.setMusic(null);
                const surrendered = this.m.teams[this.team].surrendered;
                if (e.winner === null || e.winner === undefined)
                    this.play('draw');
                else if (e.winner === this.team)
                    this.play('win');
                else if (!surrendered)
                    this.play('lose'); // the surrender cue already played when the button was pressed
                break;
            }
            default:
                break;
        }
    }
    /** Accepted / rejected orders of the human player. */
    onCommand(env, res) {
        if (env.source !== 'human' || env.team !== this.team)
            return;
        if (!res.ok) {
            this.play('order_denied');
            return;
        }
        if (HUMAN_ORDER.has(env.cmd.t))
            this.play('order_confirm');
        else if (SQUAD_EDIT.has(env.cmd.t))
            this.play('squad_edit');
    }
    // ------------------------------------------------------------------ per-frame state (edge triggered)
    /** Call once per rendered frame. */
    update() {
        if (this.dead || this.m.result.over)
            return;
        const m = this.m, me = this.main, ts = m.teams[this.team];
        if (!this.started) {
            this.started = true;
            this.play('match_start');
        }
        const p = this.prev;
        if (this.paused)
            return;
        if (me.alive) {
            // health thresholds
            if (me.hp < LOW_HP && p.hp >= LOW_HP && p.lowArmed) {
                this.play('hp_low');
                p.lowArmed = false;
            }
            if (me.hp < CRITICAL_HP && p.hp >= CRITICAL_HP && p.critArmed) {
                this.play('hp_critical');
                p.critArmed = false;
            }
            if (me.hp >= LOW_HP + 5) {
                p.lowArmed = true;
                p.critArmed = true;
            }
            else if (me.hp >= CRITICAL_HP + 5)
                p.critArmed = true;
            this.audio.setLoop('heartbeat_fast', me.hp < CRITICAL_HP);
            this.audio.setLoop('heartbeat', me.hp >= CRITICAL_HP && me.hp < LOW_HP);
            p.hp = me.hp;
            // shield
            if (p.shield > 0 && me.shield <= 0)
                this.play('shield_down');
            p.shield = me.shield;
            // weapon handling
            if (me.mode !== p.mode)
                this.play('weapon_switch');
            p.mode = me.mode;
            const reloading = me.reloadEnd >= 0;
            if (reloading && !p.reloading)
                this.play('reload_start');
            p.reloading = reloading;
            if (me.mode === 'rifle') {
                if (me.mag > 0 && me.mag <= LOW_AMMO && p.mag > LOW_AMMO)
                    this.play('low_ammo');
                if (me.wantFire && me.mag <= 0 && !reloading)
                    this.play('empty_click');
                p.mag = me.mag;
            }
            // sword strain: warning on the way up, "recovered" when an overload ends
            if (me.strain >= STRAIN_WARN && p.strainArmed && me.overloadEnd < 0) {
                this.play('strain_warning');
                p.strainArmed = false;
            }
            if (me.strain < STRAIN_REARM)
                p.strainArmed = true;
            const over = me.overloadEnd >= 0;
            if (p.overloaded && !over)
                this.play('strain_recovered');
            p.overloaded = over;
        }
        else {
            this.audio.setLoop('heartbeat', false);
            this.audio.setLoop('heartbeat_fast', false);
        }
        // discovery: the first enemy ever seen, and the first sight of the enemy Main
        if (!this.first.enemy || !this.first.enemyMain) {
            for (const id of ts.teamVisible) {
                const a = m.actors.get(id);
                if (!a || a.team === this.team)
                    continue;
                if (!this.first.enemy) {
                    this.first.enemy = true;
                    this.play('enemy_spotted', this.at(a.x, a.y, 0.6));
                }
                if (a.kind === 'main' && !this.first.enemyMain) {
                    this.first.enemyMain = true;
                    this.play('enemy_main_spotted', this.at(a.x, a.y, 0.6));
                }
            }
        }
        // Last Stand: entering it, then a tick for each of the last 10 seconds before the collapse
        const stand = ts.collapseStart >= 0;
        if (stand && !p.lastStand)
            this.play('last_stand_start');
        p.lastStand = stand;
        if (stand) {
            const left = Math.ceil((LAST_STAND.duration - (m.tick - ts.collapseStart)) / 60);
            if (left <= 10 && left > 0 && left !== p.lastStandTick) {
                p.lastStandTick = left;
                this.play('last_stand_tick');
            }
        }
        else
            p.lastStandTick = -1;
    }
    // ------------------------------------------------------------------ player actions outside the simulation
    setPaused(paused, quiet = false) {
        if (paused === this.paused)
            return;
        this.paused = paused;
        this.audio.duck(paused);
        if (paused) {
            this.audio.setLoop('heartbeat', false);
            this.audio.setLoop('heartbeat_fast', false);
        }
        if (!quiet)
            this.play(paused ? 'pause' : 'resume');
    }
    surrender() {
        this.play('surrender');
    }
    dispose() {
        this.dead = true;
        this.audio.duck(false);
        this.audio.setLoop('heartbeat', false);
        this.audio.setLoop('heartbeat_fast', false);
    }
}
//# sourceMappingURL=gameAudio.js.map