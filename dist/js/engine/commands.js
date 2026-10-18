import { SQUAD } from './constants.js';
import { isFree } from './arena.js';
import { addToSquad, createSquad, disbandSquad, followWouldCycle, removeFromSquad, squadCentroid } from './squads.js';
const bad = (reason) => ({ ok: false, reason });
const finite = (...v) => v.every((n) => typeof n === 'number' && Number.isFinite(n));
/** Snap a clicked point out of cover; null when it cannot be made walkable. */
function walkable(m, x, y) {
    if (!finite(x, y) || x < 0 || y < 0 || x > m.arena.width || y > m.arena.height)
        return null;
    if (isFree(m.arena, x, y, 0.4))
        return { x, y };
    return m.nav.nearestFree('small', x, y, 3);
}
/**
 * Validate and apply one command. Every output of a human or AI source goes through the same legality checks
 * (ownership, visibility, authority, reachability, freshness) — the engine never trusts a controller (GDD 12.3, R10.2).
 */
export function executeCommand(m, env) {
    if (m.result.over)
        return bad('match-over');
    const team = env.team;
    const ts = m.teams[team];
    const main = m.actors.get(ts.mainId);
    if (!main.alive)
        return bad('main-defeated'); // a defeated character cannot issue new commands
    if (env.source === 'human') {
        if (!ts.humanControlled)
            return bad('not-human-team');
    }
    else {
        if (ts.humanControlled)
            return bad('forbidden-authority');
        if (env.expiresAt !== undefined && m.tick > env.expiresAt)
            return bad('expired');
        if (env.source === 'slai' && env.generation !== ts.aiGeneration)
            return bad('stale-generation');
        if (env.cmd.t === 'Surrender')
            return bad('ai-surrender-disabled'); // R1.2
    }
    const c = env.cmd;
    switch (c.t) {
        case 'Stance':
            if (c.stance !== 'defensive' && c.stance !== 'offensive')
                return bad('bad-stance');
            ts.stance = c.stance; // policy changes immediately; bodyguard reassignment obeys its 1 s lockout
            m.emit('stance', { team, stance: c.stance });
            return { ok: true };
        case 'CreateSquad':
            return createSquad(m, team, c.slot, c.members ?? []);
        case 'DisbandSquad':
            return disbandSquad(m, team, c.slot);
        case 'AddToSquad':
            return addToSquad(m, team, c.slot, c.members ?? []);
        case 'RemoveFromSquad':
            return removeFromSquad(m, team, c.members ?? []);
        case 'Surrender':
            ts.surrendered = true;
            return { ok: true };
        case 'MainGoal': {
            const g = c.goal;
            if (!['Engage', 'MoveTo', 'Retreat', 'HoldNear', 'Resupply'].includes(g.kind))
                return bad('bad-goal');
            if (g.targetId >= 0 && !ts.teamVisible.has(g.targetId))
                return bad('hidden-target'); // no concealed IDs
            const p = walkable(m, g.x, g.y);
            if (!p)
                return bad('bad-destination');
            ts.mainGoal = { kind: g.kind, x: p.x, y: p.y, targetId: g.targetId, issuedAt: m.tick, expiresAt: env.expiresAt ?? m.tick + 600 };
            return { ok: true };
        }
        default:
            break;
    }
    // ---- squad-scoped commands
    const slot = c.slot;
    if (!Number.isInteger(slot) || slot < 1 || slot > SQUAD.slots)
        return bad('bad-slot');
    const sq = ts.squads[slot - 1];
    if (!sq.members.length)
        return bad('empty-squad');
    switch (c.t) {
        case 'SquadMove': {
            const p = walkable(m, c.x, c.y);
            if (!p)
                return bad('bad-destination');
            const cen = squadCentroid(m, sq);
            if (!m.nav.reachable('small', cen.x, cen.y, p.x, p.y))
                return bad('unreachable'); // last valid destination preserved
            sq.move = { kind: 'Move', x: p.x, y: p.y, followId: -1, orient: Math.atan2(p.y - cen.y, p.x - cen.x) };
            sq.rally = { x: p.x, y: p.y };
            break;
        }
        case 'SquadFollow': {
            const t = m.actors.get(c.targetId);
            if (!t || !t.alive || t.team !== team)
                return bad('bad-follow-target');
            if (sq.members.includes(t.id))
                return bad('self-follow');
            if (followWouldCycle(m, team, slot, t.id))
                return bad('follow-cycle');
            sq.move = { kind: 'Follow', x: 0, y: 0, followId: t.id, orient: t.theta };
            break;
        }
        case 'SquadHold': {
            const cen = squadCentroid(m, sq);
            sq.move = { kind: 'Hold', x: cen.x, y: cen.y, followId: -1, orient: sq.move.orient };
            break;
        }
        case 'SquadDoctrine':
            if (!['Defend', 'Press', 'Harass', 'Disengage'].includes(c.doctrine))
                return bad('bad-doctrine');
            sq.doctrine = c.doctrine;
            break;
        case 'SquadFormation':
            if (!['Compact', 'Line', 'Spread'].includes(c.formation))
                return bad('bad-formation');
            sq.formation = c.formation;
            break;
        case 'SquadTarget': {
            if (c.kind === 'none')
                sq.target = { kind: 'none', id: -1, x: 0, y: 0 };
            else if (c.kind === 'area') {
                const p = walkable(m, c.x ?? NaN, c.y ?? NaN);
                if (!p)
                    return bad('bad-destination');
                sq.target = { kind: 'area', id: -1, x: p.x, y: p.y };
            }
            else if (c.kind === 'unit' || c.kind === 'squad') {
                const id = c.id ?? -1;
                const t = m.actors.get(id);
                if (!t || !t.alive || t.team === team)
                    return bad('bad-target');
                if (!ts.teamVisible.has(id))
                    return bad('hidden-target'); // hidden enemies cannot be designated
                sq.target = { kind: c.kind, id, x: t.x, y: t.y };
            }
            else
                return bad('bad-target-kind');
            break;
        }
        case 'SquadLeader':
            if (!sq.members.includes(c.soldierId))
                return bad('not-a-member');
            sq.leader = c.soldierId;
            break;
        case 'SquadRally': {
            const p = walkable(m, c.x, c.y);
            if (!p)
                return bad('bad-destination');
            sq.rally = p;
            break;
        }
        default:
            return bad('unknown-command');
    }
    sq.lastOrderTick = m.tick;
    return { ok: true };
}
//# sourceMappingURL=commands.js.map