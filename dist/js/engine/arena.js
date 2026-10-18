import { ARENA } from './constants.js';
import { circleRectPush, pointInRect } from './geom.js';
const mirror = (r) => ({ x0: ARENA.width - r.x1, y0: r.y0, x1: ARENA.width - r.x0, y1: r.y1 });
/** The v0.3 prototype arena: a mirrored map with a central obstructed region that allows
 *  flanking along both lateral lanes (GDD Figure 1) and one central supply point. */
export function makeArena() {
    const half = [
        { x0: 16, y0: 27, x1: 18, y1: 33 }, // base guard cover
        { x0: 22, y0: 10, x1: 26, y1: 14 }, // north flank pillar
        { x0: 22, y0: 46, x1: 26, y1: 50 }, // south flank pillar
        { x0: 30, y0: 24, x1: 33, y1: 36 }, // mid-field wall
        { x0: 38, y0: 6, x1: 41, y1: 16 }, // north approach wall
        { x0: 38, y0: 44, x1: 41, y1: 54 }, // south approach wall
    ];
    const centre = [
        { x0: 44, y0: 12, x1: 56, y1: 21 }, // central north block
        { x0: 44, y0: 39, x1: 56, y1: 48 }, // central south block
    ];
    const obstacles = [...half, ...half.map(mirror), ...centre];
    return {
        width: ARENA.width,
        height: ARENA.height,
        obstacles,
        mainSpawn: [
            { x: 8, y: 30, theta: 0 },
            { x: ARENA.width - 8, y: 30, theta: Math.PI },
        ],
        zones: [
            { x0: 3, y0: 6, x1: 13, y1: 54 },
            { x0: ARENA.width - 13, y0: 6, x1: ARENA.width - 3, y1: 54 },
        ],
        supply: { x: ARENA.width / 2, y: ARENA.height / 2 },
    };
}
/** True when a circle fits inside the arena without touching solid cover. */
export function isFree(arena, x, y, r) {
    if (x < r || y < r || x > arena.width - r || y > arena.height - r)
        return false;
    for (const o of arena.obstacles) {
        if (circleRectPush(x, y, r, o))
            return false;
    }
    return true;
}
export function inZone(z, x, y) {
    return pointInRect(x, y, z);
}
//# sourceMappingURL=arena.js.map