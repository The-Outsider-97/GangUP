import { VISION } from './constants.js';
import { angleDiff, dist, segmentBlocked } from './geom.js';
import type { Match } from './match.js';
import type { Actor, Team } from './types.js';

const SAMPLE_ANGLES: number[] = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);

/**
 * Deterministic perception geometry (GDD 6.1, R4.1).
 * The target is visible when at least one of nine sample points (centre + eight boundary points placed just inside
 * the collider) is within range, inside the 220-degree forward FOV and joined to the observer centre by an
 * unobstructed ray. Only solid cover blocks vision; bodies do not.
 */
export function canSee(m: Match, obs: Actor, tgt: Actor): boolean {
  const d = dist(obs.x, obs.y, tgt.x, tgt.y);
  if (d > VISION.range + tgt.radius) return false;
  const half = VISION.fov / 2;
  const obstacles = m.arena.obstacles;
  const test = (px: number, py: number): boolean => {
    const pd = dist(obs.x, obs.y, px, py);
    if (pd > VISION.range) return false;
    if (pd > 1e-9 && Math.abs(angleDiff(obs.theta, Math.atan2(py - obs.y, px - obs.x))) > half) return false;
    return !segmentBlocked(obstacles, obs.x, obs.y, px, py);
  };
  if (test(tgt.x, tgt.y)) return true;
  const r = tgt.radius * VISION.sampleInset;
  for (const a of SAMPLE_ANGLES) {
    if (test(tgt.x + Math.cos(a) * r, tgt.y + Math.sin(a) * r)) return true;
  }
  return false;
}

/** Refresh individual sight lists on each actor's (staggered) perception tick, then rebuild shared team views. */
export function refreshVisibility(m: Match): void {
  const n = VISION.perceptionInterval;
  // ids sighted by an observer that actually refreshed THIS tick, per team: only these may update last-known positions
  const fresh: [Set<number>, Set<number>] = [new Set(), new Set()];
  for (const a of m.live) {
    if (!a.alive) continue;
    if ((a.id % n) !== (m.tick % n)) continue;
    const seen: number[] = [];
    for (const e of m.live) {
      if (!e.alive || e.team === a.team) continue;
      if (canSee(m, a, e)) seen.push(e.id);
    }
    a.sees = seen;
    for (const id of seen) fresh[a.team].add(id);
  }
  for (const team of [0, 1] as Team[]) updateTeamView(m, team, fresh[team]);
}

/** A team's shared view is the union of its living members' current sightings (6.4). */
function updateTeamView(m: Match, team: Team, fresh: Set<number>): void {
  const ts = m.teams[team];
  const union = new Set<number>();
  for (const a of m.live) {
    if (!a.alive || a.team !== team) continue;
    for (const id of a.sees) {
      const e = m.actors.get(id);
      if (e && e.alive) union.add(id);
    }
  }
  ts.teamVisible = union;
  // A sighting is up to 5 ticks old between an observer's refreshes. The last-known record is stamped only when an
  // observer really looked this tick, so it can never capture where an enemy went after it left view (GDD 6.3, 15.3).
  for (const id of union) {
    if (fresh.has(id) || !ts.lastKnown.has(id)) {
      const e = m.actors.get(id)!;
      ts.lastKnown.set(id, { id, x: e.x, y: e.y, observedAt: m.tick });
    }
  }
  for (const [id, lk] of ts.lastKnown) {
    if (union.has(id)) continue;
    const e = m.actors.get(id);
    if (!e || !e.alive || m.tick - lk.observedAt > VISION.lastKnown) ts.lastKnown.delete(id); // expired => unknown
  }
}

export function isVisibleToTeam(m: Match, team: Team, id: number): boolean {
  return m.teams[team].teamVisible.has(id);
}

/** Frozen last-known position, never an auto-attack target (6.3). Null when currently visible, expired or unknown. */
export function staleRecord(m: Match, team: Team, id: number): { x: number; y: number; age: number } | null {
  if (m.teams[team].teamVisible.has(id)) return null;
  const lk = m.teams[team].lastKnown.get(id);
  if (!lk) return null;
  const age = m.tick - lk.observedAt;
  if (age > VISION.lastKnown) return null;
  return { x: lk.x, y: lk.y, age };
}
