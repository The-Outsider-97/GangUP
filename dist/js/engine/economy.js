import { MAIN, MAX_SOLDIERS, SOLDIER, STREAK, SUPPLY, WAVE, RIFLE } from './constants.js';
import { inZone, isFree } from './arena.js';
/** Exhaustive health bands (GDD 8.1): [0,10) 0; [10,40) 3; [40,80) 4; [80,100] 5. Dead Main => 0. */
export function waveBase(hpPercent) {
    for (const b of WAVE.bands)
        if (hpPercent >= b.lo && hpPercent < b.hi)
            return b.n;
    return 0;
}
export function livingSoldiers(m, team) {
    let n = 0;
    for (const a of m.live)
        if (a.alive && a.team === team && a.kind === 'soldier')
            n++;
    return n;
}
export function streakActive(m, team) {
    const s = m.teams[team].streak;
    return s.active && m.tick >= s.activatedAt && m.tick < s.activeUntil;
}
/** Place up to `count` soldiers at valid, unoccupied points of the team's reinforcement zone (GDD 8.3). */
function placeSoldiers(m, team, count) {
    const zone = m.arena.zones[team];
    const theta = m.arena.mainSpawn[team].theta;
    let placed = 0;
    for (let i = 0; i < count; i++) {
        let ok = false;
        for (let attempt = 0; attempt < 48 && !ok; attempt++) {
            const x = m.rngSpawn.range(zone.x0 + 0.8, zone.x1 - 0.8);
            const y = m.rngSpawn.range(zone.y0 + 0.8, zone.y1 - 0.8);
            if (!isFree(m.arena, x, y, SOLDIER.radius + 0.15))
                continue;
            let clear = true;
            for (const o of m.live) {
                if (!o.alive)
                    continue;
                if (Math.hypot(o.x - x, o.y - y) < o.radius + SOLDIER.radius + 0.15) {
                    clear = false;
                    break;
                }
            }
            if (!clear)
                continue;
            m.createSoldier(team, x, y, theta);
            ok = true;
        }
        if (!ok)
            break; // blocked: spawn what fits, discard the rest (no accumulation)
        placed++;
    }
    return placed;
}
/** Scheduled reinforcement wave for both teams: B, +1 own streak, -1 enemy streak, floor 1, cap 50-N. (GDD 8.2, 9.3) */
export function processWave(m) {
    for (const team of [0, 1]) {
        const ts = m.teams[team];
        const main = m.actors.get(ts.mainId);
        const base = main.alive ? waveBase((100 * main.hp) / main.hpMax) : 0;
        const bonus = streakActive(m, team) ? 1 : 0;
        const penalty = streakActive(m, (1 - team)) ? 1 : 0;
        const adjusted = base > 0 ? Math.max(1, base + bonus - penalty) : 0;
        const n = livingSoldiers(m, team);
        const room = Math.max(0, MAX_SOLDIERS - n);
        const want = Math.min(adjusted, room);
        const spawned = want > 0 ? placeSoldiers(m, team, want) : 0;
        const note = base === 0 ? 'Main below 10%: no reinforcements' : spawned < adjusted ? (room < adjusted ? 'capacity cap' : 'spawn area blocked') : 'full wave';
        const rep = { tick: m.tick, team, base, ownBonus: bonus, enemyPenalty: penalty, adjusted, capacityRoom: room, spawned, note };
        ts.waves.push(rep);
        if (ts.waves.length > 30)
            ts.waves.shift();
        m.emit('wave', { ...rep });
    }
}
/** Central supply pickup (GDD 14.3): appears at t=30,60,90… only if none remains; one Main collects it. */
export function processSupply(m, spawnNow) {
    if (spawnNow && !m.pickup) {
        m.pickup = { x: m.arena.supply.x, y: m.arena.supply.y, spawnedAt: m.tick };
        m.emit('pickupSpawn', {});
    }
    if (m.pickup) {
        let best = null;
        let bd = Infinity;
        for (const t of m.teams) {
            const a = m.actors.get(t.mainId);
            if (!a.alive)
                continue;
            const total = a.mag + a.reserve;
            if (total >= RIFLE.main.carry)
                continue; // nothing to gain; the pickup is not wasted
            const d = Math.hypot(a.x - m.pickup.x, a.y - m.pickup.y);
            if (d <= SUPPLY.pickupRadius + a.radius && d < bd) {
                bd = d;
                best = a;
            }
        }
        if (best) {
            const gain = Math.min(SUPPLY.mainRestore, RIFLE.main.carry - (best.mag + best.reserve));
            best.reserve += gain;
            m.pickup = null;
            m.emit('pickupTaken', { actor: best.id, team: best.team, gain });
        }
    }
    // soldiers refill six reserve rounds at their own reinforcement zone, once per soldier per 20 s
    for (const s of m.live) {
        if (!s.alive || s.kind !== 'soldier')
            continue;
        if (m.tick - s.ai.lastRefillTick < SUPPLY.soldierRefillCooldown)
            continue;
        if (!inZone(m.arena.zones[s.team], s.x, s.y))
            continue;
        const cap = RIFLE.soldier.carry;
        const total = s.mag + s.reserve;
        if (total >= cap)
            continue;
        s.reserve += Math.min(SUPPLY.soldierRefill, cap - total);
        s.ai.lastRefillTick = m.tick;
    }
}
// ------------------------------------------------------------------ kill streak (GDD 9, R8)
export function expireStreaks(m) {
    for (const ts of m.teams) {
        const st = ts.streak;
        if (st.active && m.tick >= st.activeUntil) {
            st.active = false;
            const main = m.actors.get(ts.mainId);
            main.shieldMax = MAIN.shield; // maximum returns to 25 and current is clamped; no body damage results
            main.shield = Math.min(main.shield, main.shieldMax);
            m.emit('streakEnd', { team: ts.id });
        }
        if (st.cooldownUntil >= 0 && m.tick >= st.cooldownUntil) {
            st.cooldownUntil = -1; // tracking resumes with an empty queue
            st.kills = [];
        }
    }
}
export function registerStreakKill(m, killer) {
    const ts = m.teams[killer.team];
    const st = ts.streak;
    if (st.active || (st.cooldownUntil >= 0 && m.tick < st.cooldownUntil))
        return; // no banking during lockout
    st.kills.push(m.tick);
    while (st.kills.length && m.tick - st.kills[0] > STREAK.window)
        st.kills.shift();
    if (st.kills.length >= STREAK.kills) {
        st.active = true;
        st.activatedAt = m.tick;
        st.activeUntil = m.tick + STREAK.duration; // [t0, t0+40 s)
        st.cooldownUntil = m.tick + STREAK.cooldown; // [t0, t0+90 s)
        st.kills = [];
        st.activations++;
        killer.shieldMax = MAIN.shield + STREAK.shieldBonus;
        killer.shield = Math.min(killer.shieldMax, killer.shield + STREAK.shieldBonus);
        m.emit('streakStart', { team: killer.team });
    }
}
//# sourceMappingURL=economy.js.map