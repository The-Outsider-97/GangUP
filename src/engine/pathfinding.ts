import { LOCAL_AI } from './constants.js';
import type { Arena } from './arena.js';
import { circleRectPush, segmentClearForRadius } from './geom.js';

export type NavClass = 'small' | 'large';
const RADII: Record<NavClass, number> = { small: 0.42, large: 0.6 };
const SQRT2 = Math.SQRT2;
const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

/**
 * Grid navigation with cached flow fields (one Dijkstra per distinct goal cell). Planning is bounded by a
 * deterministic expansion budget (the reproducible stand-in for GDD 11.6's 150 ms wall-clock budget); an
 * unreachable goal returns null so the caller can enter Hold/Regroup and retry with bounded back-off.
 */
export class NavGrid {
  readonly w: number;
  readonly h: number;
  private blocked: Record<NavClass, Uint8Array>;
  private cache = new Map<string, Float64Array>();

  constructor(private arena: Arena) {
    this.w = Math.ceil(arena.width);
    this.h = Math.ceil(arena.height);
    this.blocked = { small: this.buildBlocked(RADII.small), large: this.buildBlocked(RADII.large) };
  }

  private buildBlocked(rad: number): Uint8Array {
    const out = new Uint8Array(this.w * this.h);
    for (let cy = 0; cy < this.h; cy++)
      for (let cx = 0; cx < this.w; cx++) {
        const x = cx + 0.5;
        const y = cy + 0.5;
        let b = x < rad || y < rad || x > this.arena.width - rad || y > this.arena.height - rad;
        if (!b) for (const o of this.arena.obstacles) if (circleRectPush(x, y, rad, o)) { b = true; break; }
        out[cy * this.w + cx] = b ? 1 : 0;
      }
    return out;
  }

  cell(x: number, y: number): [number, number] {
    return [Math.min(this.w - 1, Math.max(0, Math.floor(x))), Math.min(this.h - 1, Math.max(0, Math.floor(y)))];
  }

  isBlocked(cls: NavClass, cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return true;
    return this.blocked[cls][cy * this.w + cx] === 1;
  }

  /** Nearest walkable cell centre to a point (BFS by ring), or null. */
  nearestFree(cls: NavClass, x: number, y: number, maxR = 6): { x: number; y: number } | null {
    const [cx, cy] = this.cell(x, y);
    if (!this.isBlocked(cls, cx, cy)) return { x: cx + 0.5, y: cy + 0.5 };
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.isBlocked(cls, cx + dx, cy + dy)) continue;
          const px = cx + dx + 0.5;
          const py = cy + dy + 0.5;
          const d = Math.hypot(px - x, py - y);
          if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && best && (py < best.y || (py === best.y && px < best.x)))) {
            bd = d;
            best = { x: px, y: py };
          }
        }
      if (best) return best;
    }
    return null;
  }

  private field(cls: NavClass, gcx: number, gcy: number): Float64Array {
    const key = cls + ':' + gcx + ',' + gcy;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const n = this.w * this.h;
    const dist = new Float64Array(n).fill(Infinity);
    const heapD: number[] = [];
    const heapI: number[] = [];
    const push = (d: number, i: number) => {
      let k = heapD.length;
      heapD.push(d);
      heapI.push(i);
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heapD[p] <= heapD[k]) break;
        [heapD[p], heapD[k]] = [heapD[k], heapD[p]];
        [heapI[p], heapI[k]] = [heapI[k], heapI[p]];
        k = p;
      }
    };
    const pop = (): [number, number] => {
      const d = heapD[0];
      const i = heapI[0];
      const ld = heapD.pop()!;
      const li = heapI.pop()!;
      if (heapD.length) {
        heapD[0] = ld;
        heapI[0] = li;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          const r = l + 1;
          let s = k;
          if (l < heapD.length && heapD[l] < heapD[s]) s = l;
          if (r < heapD.length && heapD[r] < heapD[s]) s = r;
          if (s === k) break;
          [heapD[s], heapD[k]] = [heapD[k], heapD[s]];
          [heapI[s], heapI[k]] = [heapI[k], heapI[s]];
          k = s;
        }
      }
      return [d, i];
    };
    const gi = gcy * this.w + gcx;
    dist[gi] = 0;
    push(0, gi);
    let expansions = 0;
    while (heapD.length && expansions < LOCAL_AI.pathBudgetExpansions * 4) {
      const [d, i] = pop();
      if (d > dist[i]) continue;
      expansions++;
      const cx = i % this.w;
      const cy = (i / this.w) | 0;
      for (const [dx, dy, c] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (this.isBlocked(cls, nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (this.isBlocked(cls, cx + dx, cy) || this.isBlocked(cls, cx, cy + dy))) continue; // no corner cutting
        const ni = ny * this.w + nx;
        const nd = d + c;
        if (nd < dist[ni]) {
          dist[ni] = nd;
          push(nd, ni);
        }
      }
    }
    if (this.cache.size >= 96) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, dist);
    return dist;
  }

  /** Walking distance in metres (approximate, 1 m cells) from a point to a goal, or Infinity. */
  pathDistance(cls: NavClass, x: number, y: number, gx: number, gy: number): number {
    const g = this.nearestFree(cls, gx, gy);
    if (!g) return Infinity;
    const [gcx, gcy] = this.cell(g.x, g.y);
    const f = this.field(cls, gcx, gcy);
    const s = this.nearestFree(cls, x, y, 3);
    if (!s) return Infinity;
    const [scx, scy] = this.cell(s.x, s.y);
    return f[scy * this.w + scx] + Math.hypot(s.x - x, s.y - y);
  }

  reachable(cls: NavClass, x: number, y: number, gx: number, gy: number): boolean {
    return Number.isFinite(this.pathDistance(cls, x, y, gx, gy));
  }

  /**
   * Next steering point towards a goal. Returns the goal itself when the straight line is clear, otherwise the
   * farthest clear point along the flow-field gradient. Null when the goal is unreachable.
   */
  nextPoint(cls: NavClass, x: number, y: number, gx: number, gy: number): { x: number; y: number } | null {
    const rad = RADII[cls] - 0.05;
    if (segmentClearForRadius(this.arena.obstacles, x, y, gx, gy, rad)) return { x: gx, y: gy };
    const g = this.nearestFree(cls, gx, gy);
    if (!g) return null;
    const [gcx, gcy] = this.cell(g.x, g.y);
    const f = this.field(cls, gcx, gcy);
    let [cx, cy] = this.cell(x, y);
    let cur = f[cy * this.w + cx];
    if (!Number.isFinite(cur)) {
      // standing in an inflated margin: step to the best finite neighbour ring
      let best = Infinity;
      let bx = cx;
      let by = cy;
      for (let r = 1; r <= 2 && !Number.isFinite(best); r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
            const v = f[ny * this.w + nx];
            if (v < best) { best = v; bx = nx; by = ny; }
          }
      if (!Number.isFinite(best)) return null;
      cx = bx;
      cy = by;
      cur = best;
    }
    let out: { x: number; y: number } | null = null;
    for (let step = 0; step < 14; step++) {
      let bd = cur;
      let bx = -1;
      let by = -1;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (this.isBlocked(cls, nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (this.isBlocked(cls, cx + dx, cy) || this.isBlocked(cls, cx, cy + dy))) continue;
        const v = f[ny * this.w + nx];
        if (v < bd) { bd = v; bx = nx; by = ny; }
      }
      if (bx < 0) break;
      const px = bx + 0.5;
      const py = by + 0.5;
      if (step > 0 && !segmentClearForRadius(this.arena.obstacles, x, y, px, py, rad)) break;
      out = { x: px, y: py };
      cx = bx;
      cy = by;
      cur = bd;
      if (cur === 0) break;
    }
    return out ?? { x: cx + 0.5, y: cy + 0.5 };
  }
}
