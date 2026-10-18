import { LAST_STAND, MAIN, STREAK, SQUAD, SUPPLY, SWORD, WAVE, ticksToSec } from '../engine/constants.js';
import { streakActive, waveBase, livingSoldiers } from '../engine/economy.js';
import { livingMembers } from '../engine/squads.js';
function phaseOf(t) {
    return t < 120 ? 'Early' : t < 300 ? 'Middle' : 'Late';
}
function describeTarget(m, team, kind, id) {
    if (kind === 'none')
        return '—';
    if (kind === 'area')
        return 'area';
    if (kind === 'squad')
        return `squad ${id}`;
    const a = m.actors.get(id);
    if (!a || !a.alive)
        return 'lost';
    // exact identity only while visible; otherwise an explicit "not visible" so the card never leaks hidden positions
    if (!m.teams[team].teamVisible.has(id) && a.team !== team)
        return 'not visible';
    return a.kind === 'main' ? 'enemy Main' : `unit ${id}`;
}
export function buildHudModel(m, team) {
    const ts = m.teams[team];
    const en = m.teams[(1 - team)];
    const main = m.actors.get(ts.mainId);
    const tick = m.tick;
    const t = ticksToSec(tick);
    const shieldBonus = streakActive(m, team) ? STREAK.shieldBonus : 0;
    const nextWave = ticksToSec(WAVE.interval - (tick % WAVE.interval));
    const curBase = main.alive ? waveBase((100 * main.hp) / main.hpMax) : 0;
    const nextSupply = ticksToSec(SUPPLY.interval - (tick % SUPPLY.interval));
    const win = ts.streak.kills.filter((k) => tick - k < STREAK.window);
    const sActive = streakActive(m, team);
    const eActive = streakActive(m, (1 - team));
    const squads = ts.squads.map((sq) => {
        const ms = livingMembers(m, sq);
        if (!ms.length) {
            return { slot: sq.slot, size: 0, hpPct: 0, status: 'empty', doctrine: sq.doctrine, formation: sq.formation, objective: '—', target: '—', activity: 'idle', blocked: false, leader: -1 };
        }
        const hp = ms.reduce((p, a) => p + a.hp / a.hpMax, 0) / ms.length;
        const retreating = ms.filter((a) => a.ai.task === 'Retreating' || a.ai.withdrawing).length;
        const engaged = ms.filter((a) => a.ai.task === 'Engaging' || a.ai.task === 'Harassing').length;
        const moving = ms.filter((a) => a.ai.task === 'Moving' || a.ai.task === 'Following').length;
        const activity = retreating * 2 >= ms.length ? 'retreating' : engaged > 0 ? 'engaged' : moving > 0 ? 'moving' : 'idle';
        const objective = sq.move.kind === 'Move' ? `move (${sq.move.x.toFixed(0)}, ${sq.move.y.toFixed(0)})` : sq.move.kind === 'Follow' ? `follow ${sq.move.followId}` : sq.move.kind === 'Hold' ? 'hold' : 'none';
        return {
            slot: sq.slot,
            size: ms.length,
            hpPct: Math.round(hp * 100),
            status: hp > 0.6 ? 'ok' : hp > 0.3 ? 'hurt' : 'critical',
            doctrine: sq.doctrine,
            formation: sq.formation,
            objective,
            target: describeTarget(m, team, sq.target.kind, sq.target.id),
            activity,
            blocked: sq.blockedCount > 0,
            leader: sq.leader,
        };
    });
    const lastStandLeft = (id) => {
        const s = m.teams[id];
        if (s.collapseStart < 0)
            return null;
        return Math.max(0, ticksToSec(LAST_STAND.duration - (tick - s.collapseStart)));
    };
    const enemyMainActor = m.actors.get(en.mainId);
    const enemyMainVisible = enemyMainActor.alive && ts.teamVisible.has(enemyMainActor.id);
    let visSoldiers = 0;
    for (const id of ts.teamVisible) {
        const a = m.actors.get(id);
        if (a && a.alive && a.kind === 'soldier')
            visSoldiers++;
    }
    const waveLine = (w) => ({
        time: ticksToSec(w.tick),
        base: w.base,
        ownBonus: w.ownBonus,
        enemyPenalty: w.enemyPenalty,
        capacityRoom: w.capacityRoom,
        spawned: w.spawned,
        note: w.note,
    });
    return {
        time: t,
        phase: phaseOf(t),
        main: {
            alive: main.alive,
            hp: main.hp,
            hpMax: main.hpMax,
            shield: main.shield,
            shieldMax: main.shieldMax,
            shieldBonus,
            mode: main.mode,
            mag: main.mag,
            reserve: main.reserve,
            reloading: main.reloadEnd >= 0 && tick < main.reloadEnd,
            strain: main.strain,
            strainMax: SWORD.strainMax,
            overloadLeft: main.overloadEnd >= 0 && tick < main.overloadEnd ? ticksToSec(main.overloadEnd - tick) : 0,
        },
        stance: ts.stance,
        soldiers: livingSoldiers(m, team),
        enemySoldiersVisible: visSoldiers,
        enemyMain: enemyMainVisible ? { hp: enemyMainActor.hp, shield: enemyMainActor.shield } : null,
        nextWave,
        nextWaveBase: curBase,
        supplyIn: m.pickup ? 0 : nextSupply,
        pickupOnMap: !!m.pickup,
        streak: {
            kills: sActive ? STREAK.kills : win.length,
            need: STREAK.kills,
            windowLeft: win.length && !sActive ? ticksToSec(STREAK.window - (tick - win[0])) : 0,
            active: sActive,
            activeLeft: sActive ? ticksToSec(ts.streak.activeUntil - tick) : 0,
            cooldownLeft: ts.streak.cooldownUntil > tick ? ticksToSec(ts.streak.cooldownUntil - tick) : 0,
            enemyActive: eActive,
            enemyActiveLeft: eActive ? ticksToSec(en.streak.activeUntil - tick) : 0,
        },
        lastStand: { own: lastStandLeft(team), enemy: lastStandLeft((1 - team)) },
        squads,
        lastWave: ts.waves.slice(-3).reverse().map(waveLine),
    };
}
/** The arithmetic line shown at each wave: Base N, own streak +1, enemy streak −1, capacity effect, soldiers received. */
export function formatWaveArithmetic(w) {
    if (w.base === 0)
        return 'Base 0 (Main below 10 %): no reinforcements';
    const adj = Math.max(1, w.base + w.ownBonus - w.enemyPenalty);
    const cap = w.capacityRoom < adj ? `capacity room ${w.capacityRoom}` : 'capacity ok';
    return `Base ${w.base} ${w.ownBonus ? '+ streak 1 ' : ''}${w.enemyPenalty ? '− enemy streak 1 ' : ''}= ${adj}; ${cap}; received ${w.spawned}`;
}
export const HUD_CONSTANTS = { mainHp: MAIN.hp, squadSlots: SQUAD.slots };
//# sourceMappingURL=hudModel.js.map