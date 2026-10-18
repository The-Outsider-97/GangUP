import { AIDirector } from '../src/ai/director.js';
import { Match } from '../src/engine/match.js';
import type { Actor, Team } from '../src/engine/types.js';

export function fresh(seed = 1, human: Team | null = null): Match {
  return new Match({ seed, humanTeam: human });
}

/** Remove the starting soldiers so a test controls exactly who is on the field. */
export function clearSoldiers(m: Match, team?: Team): void {
  for (const a of m.live) if (a.kind === 'soldier' && (team === undefined || a.team === team)) { a.alive = false; a.hp = 0; }
  m.live = m.live.filter((a) => a.alive);
}

export function put(a: Actor, x: number, y: number, theta = a.theta): void {
  a.x = a.px = x;
  a.y = a.py = y;
  a.theta = theta;
}

export function stepN(m: Match, n: number, directors: AIDirector[] = []): void {
  for (let i = 0; i < n && !m.result.over; i++) {
    for (const d of directors) d.poll(m);
    m.step();
  }
}

export function baselineDirectors(m: Match, teams: Team[] = [0, 1]): AIDirector[] {
  return teams.map((t) => {
    const d = new AIDirector(t, { difficulty: 'hard', mode: 'baseline', baseUrl: '', deadlineMs: 400 });
    d.attach(m);
    return d;
  });
}

/** Cheap state fingerprint (FNV-1a over quantised positions, HP and counters). */
export function fingerprint(m: Match): string {
  let h = 2166136261;
  const mix = (n: number) => { h ^= Math.round(n * 1000) | 0; h = Math.imul(h, 16777619) >>> 0; };
  mix(m.tick);
  for (const a of m.actors.values()) { mix(a.id); mix(a.x); mix(a.y); mix(a.theta); mix(a.hp); mix(a.shield); mix(a.mag); mix(a.alive ? 1 : 0); }
  for (const t of m.teams) { mix(t.soldiersSpawned); mix(t.streak.activations); }
  return h.toString(16);
}

export function checkInvariants(m: Match): string[] {
  const bad: string[] = [];
  let soldiers = [0, 0];
  for (const a of m.actors.values()) {
    if (![a.x, a.y, a.theta, a.hp, a.shield].every(Number.isFinite)) bad.push(`non-finite actor ${a.id}`);
    if (!a.alive) continue;
    if (a.kind === 'soldier') soldiers[a.team]++;
    if (a.x < 0 || a.y < 0 || a.x > m.arena.width || a.y > m.arena.height) bad.push(`actor ${a.id} outside arena (${a.x.toFixed(2)},${a.y.toFixed(2)})`);
    if (a.hp > a.hpMax + 1e-6 || a.hp <= 0) bad.push(`actor ${a.id} hp ${a.hp}`);
    if (a.shield < -1e-9 || a.shield > a.shieldMax + 1e-6) bad.push(`actor ${a.id} shield ${a.shield}/${a.shieldMax}`);
    for (const o of m.arena.obstacles) {
      const cx = Math.max(o.x0, Math.min(a.x, o.x1)), cy = Math.max(o.y0, Math.min(a.y, o.y1));
      const pen = a.radius - Math.hypot(a.x - cx, a.y - cy);
      if (pen > 0.05) bad.push(`actor ${a.id} penetrates cover by ${pen.toFixed(3)}`);
    }
  }
  if (soldiers[0] > 50 || soldiers[1] > 50) bad.push(`soldier cap exceeded ${soldiers}`);
  return bad;
}
