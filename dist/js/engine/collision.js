import { CONTACT, DT } from './constants.js';
import { applyContact } from './combat.js';
import { circleRectPush, clamp } from './geom.js';
const CELL = 2;
const key = (cx, cy) => cx * 4096 + cy;
/**
 * Collision resolution (GDD 4.3, 7.4): no tunnelling through walls, deterministic separation ordered by stable
 * actor ID, one damage event per distinct enemy contact, and effective speed reduced when congested (never raised).
 */
export function resolveCollisions(m) {
    const live = m.live.filter((a) => a.alive);
    const grid = new Map();
    for (const a of live) {
        const k = key(Math.floor(a.x / CELL), Math.floor(a.y / CELL));
        let cell = grid.get(k);
        if (!cell)
            grid.set(k, (cell = []));
        cell.push(a);
    }
    const neighbours = (a) => {
        const out = [];
        const cx = Math.floor(a.x / CELL);
        const cy = Math.floor(a.y / CELL);
        for (let ix = cx - 1; ix <= cx + 1; ix++)
            for (let iy = cy - 1; iy <= cy + 1; iy++) {
                const c = grid.get(key(ix, iy));
                if (c)
                    for (const o of c)
                        if (o.id > a.id)
                            out.push(o);
            }
        out.sort((p, q) => p.id - q.id);
        return out;
    };
    for (let iter = 0; iter < 3; iter++) {
        for (const a of live) {
            for (const b of neighbours(a)) {
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let d = Math.hypot(dx, dy);
                const rs = a.radius + b.radius;
                if (d >= rs)
                    continue;
                if (iter === 0 && a.team !== b.team)
                    handleContact(m, a, b);
                if (d < 1e-6) {
                    dx = Math.cos(a.id * 2.399963);
                    dy = Math.sin(a.id * 2.399963);
                    d = 1;
                }
                const pen = rs - Math.hypot(b.x - a.x, b.y - a.y);
                const nx = dx / d;
                const ny = dy / d;
                a.x -= nx * pen * 0.5;
                a.y -= ny * pen * 0.5;
                b.x += nx * pen * 0.5;
                b.y += ny * pen * 0.5;
            }
        }
        for (const a of live) {
            for (const o of m.arena.obstacles) {
                const p = circleRectPush(a.x, a.y, a.radius, o);
                if (p) {
                    a.x += p.x;
                    a.y += p.y;
                }
            }
            a.x = clamp(a.x, a.radius, m.arena.width - a.radius);
            a.y = clamp(a.y, a.radius, m.arena.height - a.radius);
        }
    }
    // Effective speed: congestion can slow units but never raises their top speed.
    for (const a of live) {
        const ex = a.x - a.px;
        const ey = a.y - a.py;
        const veff = (ex * Math.cos(a.theta) + ey * Math.sin(a.theta)) / DT;
        if (a.speed >= 0)
            a.speed = clamp(veff, 0, a.speed);
        else
            a.speed = clamp(veff, a.speed, 0);
    }
    rearmContacts(m);
}
function pairKey(a, b) {
    return Math.min(a.id, b.id) * 1_000_000 + Math.max(a.id, b.id);
}
/** Enemy contact: damage only on a distinct initial contact, then again after 1 s AND a 0.1 m separation. */
function handleContact(m, a, b) {
    const k = pairKey(a, b);
    const st = m.contactPairs.get(k);
    if (st && !(st.armed && m.tick - st.last >= CONTACT.pairCooldown))
        return;
    m.contactPairs.set(k, { last: m.tick, armed: false });
    applyContact(m, a, b);
}
function rearmContacts(m) {
    for (const [k, st] of m.contactPairs) {
        const ida = Math.floor(k / 1_000_000);
        const idb = k % 1_000_000;
        const a = m.actors.get(ida);
        const b = m.actors.get(idb);
        if (!a || !b || !a.alive || !b.alive) {
            m.contactPairs.delete(k);
            continue;
        }
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > a.radius + b.radius + CONTACT.rearmSeparation) {
            st.armed = true;
            if (m.tick - st.last >= CONTACT.pairCooldown)
                m.contactPairs.delete(k);
        }
    }
}
//# sourceMappingURL=collision.js.map