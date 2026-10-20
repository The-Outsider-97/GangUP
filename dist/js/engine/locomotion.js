import { MAIN, SOLDIER } from './constants.js';
import { angleDiff, clamp, nearestObstacle, rayCircle } from './geom.js';
export const navClass = (a) => (a.kind === 'main' ? 'large' : 'small');
export function turnRateOf(a) {
    return a.kind === 'main' ? MAIN.turnRate : SOLDIER.turnRate;
}
/** Currently-visible enemies for one actor (its own sight list, filtered for the living). */
export function enemiesOf(m, a) {
    const out = [];
    for (const id of a.sees) {
        const e = m.actors.get(id);
        if (e && e.alive)
            out.push(e);
    }
    return out;
}
export function stopMotion(a) {
    a.throttle = 0;
    a.turn = 0;
}
/** Rotate in place towards an absolute heading. Returns the remaining signed error. */
export function faceAngle(a, desired) {
    const err = angleDiff(a.theta, desired);
    a.turn = clamp(err / (turnRateOf(a) * 0.06), -1, 1);
    a.throttle = 0;
    return err;
}
/**
 * Tank-style steering towards a goal (flow-field aware). Rotation and translation are simultaneous; when the goal is
 * close and behind, the actor may back up instead of turning round (backward speed is 70 %).
 * Returns false when the goal is unreachable.
 */
export function steer(m, a, gx, gy, o = {}) {
    const arrive = o.arrive ?? 0.4;
    const d = Math.hypot(gx - a.x, gy - a.y);
    if (d <= arrive) {
        stopMotion(a);
        return true;
    }
    const p = m.nav.nextPoint(navClass(a), a.x, a.y, gx, gy);
    if (!p)
        return false;
    const desired = Math.atan2(p.y - a.y, p.x - a.x);
    const err = angleDiff(a.theta, desired);
    if (o.reverse && d < 2.2 && Math.abs(err) > 2.3) {
        a.turn = 0;
        a.throttle = -clamp((d - arrive) / 1.2, 0.2, 1) * (o.scale ?? 1);
        return true;
    }
    a.turn = clamp(err / (turnRateOf(a) * 0.08), -1, 1);
    const align = Math.abs(err) > 1.3 ? 0 : Math.max(0, Math.cos(err));
    const slow = clamp((d - arrive) / 2.0, 0.15, 1);
    a.throttle = align * slow * (o.scale ?? 1);
    return true;
}
/** Angular half-width within which an aimed shot at the target's centre can still be expected to land. */
export function aimTolerance(target, d) {
    return Math.max(0.035, Math.atan2(target.radius, Math.max(0.5, d)) * 0.85);
}
/** Predicted muzzle-to-target ray: does solid cover or an allied body intersect first? (GDD 5.3, 11.4) */
export function laneState(m, s, t) {
    const ang = Math.atan2(t.y - s.y, t.x - s.x);
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const ox = s.x + dx * s.radius;
    const oy = s.y + dy * s.radius;
    const dT = Math.max(0, Math.hypot(t.x - ox, t.y - oy));
    const reach = Math.max(0, dT - t.radius);
    const tObs = nearestObstacle(m.arena.obstacles, ox, oy, dx, dy, dT);
    if (tObs !== null && tObs < reach + 0.001)
        return 'cover';
    for (const o of m.live) {
        if (o === s || o === t || !o.alive || o.team !== s.team)
            continue;
        const tt = rayCircle(ox, oy, dx, dy, o.x, o.y, o.radius, dT);
        if (tt !== null && tt < reach)
            return 'ally';
    }
    return 'clear';
}
//# sourceMappingURL=locomotion.js.map