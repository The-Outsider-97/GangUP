import { DOCTRINE, FORMATION_SPACING, SQUAD, STREAK, SUPPLY, VISION, WAVE, ticksToSec } from '../engine/constants.js';
import { streakActive, waveBase } from '../engine/economy.js';
import { livingMembers, squadCentroid } from '../engine/squads.js';
import { OBS_SCHEMA } from './schema.js';
/** Build the team-legal observation. Increments the team's observation generation counter. */
export function buildObservation(m, team, difficulty, deadlineMs) {
    const ts = m.teams[team];
    const gen = ++ts.aiGeneration;
    const main = m.mainOf(team);
    const soldiers = m.soldiers(team);
    const own = soldiers.map((s) => ({
        id: s.id,
        x: s.x,
        y: s.y,
        theta: s.theta,
        hp: s.hp,
        shield: s.shield,
        squad: s.squadSlot,
        guard: s.ai.bodyguard,
        ammo: s.mag + s.reserve,
        task: s.ai.task,
    }));
    const squads = ts.squads.map((sq) => {
        const ms = livingMembers(m, sq);
        const c = squadCentroid(m, sq);
        return {
            slot: sq.slot,
            members: ms.map((a) => a.id),
            leader: sq.leader,
            move: { kind: sq.move.kind, x: sq.move.x, y: sq.move.y, followId: sq.move.followId },
            doctrine: sq.doctrine,
            formation: sq.formation,
            target: { ...sq.target },
            blocked: sq.blockedCount,
            centroid: c,
            avgHp: ms.length ? ms.reduce((p, a) => p + a.hp / a.hpMax, 0) / ms.length : 0,
            avgAmmo: ms.length ? ms.reduce((p, a) => p + a.mag + a.reserve, 0) / ms.length : 0,
        };
    });
    const visible = [...ts.teamVisible]
        .map((id) => m.actors.get(id))
        .filter((e) => e && e.alive)
        .sort((p, q) => p.id - q.id)
        .map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y, theta: e.theta, hp: e.hp, shield: e.shield }));
    const lastKnown = [...ts.lastKnown.values()]
        .filter((lk) => !ts.teamVisible.has(lk.id) && m.tick - lk.observedAt <= VISION.lastKnown)
        .sort((p, q) => p.id - q.id)
        .map((lk) => ({ id: lk.id, x: lk.x, y: lk.y, age: ticksToSec(m.tick - lk.observedAt) }));
    const st = ts.streak;
    const nextWave = WAVE.interval - (m.tick % WAVE.interval);
    const nextPickup = m.pickup ? 0 : SUPPLY.interval - (m.tick % SUPPLY.interval);
    const used = new Set(ts.squads.filter((s) => s.members.length).map((s) => s.slot));
    const z = m.arena.zones[team];
    const ez = m.arena.zones[1 - team];
    return {
        schema: OBS_SCHEMA,
        version: '0.3',
        seed: m.seed,
        tick: m.tick,
        time: ticksToSec(m.tick),
        generation: gen,
        team,
        difficulty,
        own: {
            main: {
                id: main.id, x: main.x, y: main.y, theta: main.theta, hp: main.hp, shield: main.shield, alive: main.alive,
                mode: main.mode, ammo: main.mag + main.reserve, mag: main.mag, strain: main.strain, shieldMax: main.shieldMax,
            },
            soldiers: own,
            soldierCount: soldiers.length,
            stance: ts.stance,
            streak: {
                active: streakActive(m, team),
                remaining: st.active ? ticksToSec(Math.max(0, st.activeUntil - m.tick)) : 0,
                cooldown: st.cooldownUntil >= 0 ? ticksToSec(Math.max(0, st.cooldownUntil - m.tick)) : 0,
                killsInWindow: st.kills.filter((k) => m.tick - k <= STREAK.window).length,
            },
        },
        squads,
        unassigned: soldiers.filter((s) => s.squadSlot === 0).map((s) => s.id),
        enemies: { visible, lastKnown, enemyStreakActive: streakActive(m, (1 - team)) },
        terrain: {
            width: m.arena.width,
            height: m.arena.height,
            obstacles: m.arena.obstacles.map((o) => ({ ...o })),
            supply: { ...m.arena.supply },
            zone: { x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1 },
            enemyZone: { x0: ez.x0, y0: ez.y0, x1: ez.x1, y1: ez.y1 },
        },
        resources: {
            pickup: m.pickup ? { x: m.pickup.x, y: m.pickup.y } : null,
            nextPickupIn: ticksToSec(nextPickup),
            nextWaveIn: ticksToSec(nextWave),
            waveBase: main.alive ? waveBase((100 * main.hp) / main.hpMax) : 0,
        },
        legal: {
            stances: ['defensive', 'offensive'],
            doctrines: Object.keys(DOCTRINE),
            formations: Object.keys(FORMATION_SPACING),
            mainGoals: ['Engage', 'MoveTo', 'Retreat', 'HoldNear', 'Resupply'],
            freeSlots: Array.from({ length: SQUAD.slots }, (_, i) => i + 1).filter((s) => !used.has(s)),
            maxSquadSize: SQUAD.maxMembers,
        },
        budget: { deadlineMs, maxActions: 24 },
    };
}
//# sourceMappingURL=observation.js.map