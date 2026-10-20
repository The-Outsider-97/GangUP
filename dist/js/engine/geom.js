/** Geometry helpers shared by line of sight, hitscan, melee, collision and pathfinding. */
/** Slab tolerance. Rects are widened by this so a ray grazing a shared corner cannot slip between
 *  two touching walls (GDD 6.5: no sight/shots through diagonal corner contacts). */
const SLAB_EPS = 1e-7;
export const TAU = Math.PI * 2;
export function wrapAngle(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0)
        a += TAU;
    return a - Math.PI;
}
/** Shortest signed rotation from a to b, in (-PI, PI]. */
export function angleDiff(a, b) {
    return wrapAngle(b - a);
}
export function dist(ax, ay, bx, by) {
    return Math.hypot(bx - ax, by - ay);
}
export function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}
/**
 * Ray (origin + unit direction) vs. rectangle. Returns entry distance t in [0, maxT] or null.
 * An origin inside the rect returns 0.
 */
export function rayRect(ox, oy, dx, dy, r, maxT) {
    let tmin = 0;
    let tmax = maxT;
    // X slab
    if (Math.abs(dx) < 1e-12) {
        if (ox < r.x0 - SLAB_EPS || ox > r.x1 + SLAB_EPS)
            return null;
    }
    else {
        let t1 = (r.x0 - SLAB_EPS - ox) / dx;
        let t2 = (r.x1 + SLAB_EPS - ox) / dx;
        if (t1 > t2)
            [t1, t2] = [t2, t1];
        if (t1 > tmin)
            tmin = t1;
        if (t2 < tmax)
            tmax = t2;
        if (tmin > tmax)
            return null;
    }
    // Y slab
    if (Math.abs(dy) < 1e-12) {
        if (oy < r.y0 - SLAB_EPS || oy > r.y1 + SLAB_EPS)
            return null;
    }
    else {
        let t1 = (r.y0 - SLAB_EPS - oy) / dy;
        let t2 = (r.y1 + SLAB_EPS - oy) / dy;
        if (t1 > t2)
            [t1, t2] = [t2, t1];
        if (t1 > tmin)
            tmin = t1;
        if (t2 < tmax)
            tmax = t2;
        if (tmin > tmax)
            return null;
    }
    return tmin;
}
/** Nearest intersection of a ray with a circle, t in [0,maxT]; origin inside returns 0. */
export function rayCircle(ox, oy, dx, dy, cx, cy, rad, maxT) {
    const fx = ox - cx;
    const fy = oy - cy;
    const c = fx * fx + fy * fy - rad * rad;
    if (c <= 0)
        return 0;
    const b = fx * dx + fy * dy; // dir is unit
    if (b > 0)
        return null; // moving away
    const disc = b * b - c;
    if (disc < 0)
        return null;
    const t = -b - Math.sqrt(disc);
    return t <= maxT ? Math.max(0, t) : null;
}
/** Nearest opaque obstacle hit along a ray, or null. */
export function nearestObstacle(rects, ox, oy, dx, dy, maxT) {
    let best = null;
    for (let i = 0; i < rects.length; i++) {
        const t = rayRect(ox, oy, dx, dy, rects[i], maxT);
        if (t !== null && (best === null || t < best))
            best = t;
    }
    return best;
}
/** True if the open segment (x0,y0)-(x1,y1) is blocked by any rect. */
export function segmentBlocked(rects, x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9)
        return false;
    const ux = dx / len;
    const uy = dy / len;
    for (let i = 0; i < rects.length; i++) {
        if (rayRect(x0, y0, ux, uy, rects[i], len) !== null)
            return true;
    }
    return false;
}
/** Segment clearance for a body of radius `rad` (rects inflated). */
export function segmentClearForRadius(rects, x0, y0, x1, y1, rad) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9)
        return true;
    const ux = dx / len;
    const uy = dy / len;
    for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        const infl = { x0: r.x0 - rad, y0: r.y0 - rad, x1: r.x1 + rad, y1: r.y1 + rad };
        if (rayRect(x0, y0, ux, uy, infl, len) !== null)
            return false;
    }
    return true;
}
/** Push a circle out of a rectangle. Returns the correction vector or null when not overlapping. */
export function circleRectPush(cx, cy, rad, r) {
    const nx = clamp(cx, r.x0, r.x1);
    const ny = clamp(cy, r.y0, r.y1);
    let dx = cx - nx;
    let dy = cy - ny;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rad * rad)
        return null;
    if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        const k = (rad - d) / d;
        return { x: dx * k, y: dy * k };
    }
    // center inside the rect: push out along the shallowest axis
    const left = cx - r.x0;
    const right = r.x1 - cx;
    const up = cy - r.y0;
    const down = r.y1 - cy;
    const m = Math.min(left, right, up, down);
    if (m === left)
        return { x: -(left + rad), y: 0 };
    if (m === right)
        return { x: right + rad, y: 0 };
    if (m === up)
        return { x: 0, y: -(up + rad) };
    return { x: 0, y: down + rad };
}
export function pointInRect(x, y, r, pad = 0) {
    return x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad;
}
//# sourceMappingURL=geom.js.map