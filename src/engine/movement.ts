import { BACKWARD_FACTOR, DOCTRINE, DT, MAIN, SOLDIER } from './constants.js';
import { clamp, wrapAngle } from './geom.js';
import type { Match } from './match.js';
import type { Actor } from './types.js';

/** Active doctrine speed multiplier M (default 1.00; Press 0.85; Harass 1.25). GDD 4.2 */
export function doctrineSpeedMult(m: Match, a: Actor): number {
  if (a.kind === 'main' || a.squadSlot === 0) return 1;
  const sq = m.teams[a.team].squads[a.squadSlot - 1];
  return DOCTRINE[sq.doctrine].speed;
}

/** Exact speed calculation order (GDD 4.2): F = V x M ; B = F x 0.70 ; sign applied last. */
export function speedLimits(m: Match, a: Actor): { forward: number; backward: number } {
  const V = a.kind === 'main' ? MAIN.forward : SOLDIER.forward;
  const M = doctrineSpeedMult(m, a);
  const F = V * M;
  const B = F * BACKWARD_FACTOR; // the 30 % penalty is applied exactly once
  return { forward: F, backward: B };
}

/** Integrate tank-style motion for one tick. Collision resolution runs afterwards for all actors. */
export function stepMovement(m: Match, a: Actor): void {
  const base = a.kind === 'main' ? MAIN : SOLDIER;
  const { forward, backward } = speedLimits(m, a);
  const throttle = clamp(a.throttle, -1, 1);
  const target = throttle >= 0 ? throttle * forward : throttle * backward;
  const dv = base.accel * DT; // braking uses the same magnitude (4.3)
  a.speed += clamp(target - a.speed, -dv, dv);
  a.speed = clamp(a.speed, -backward, forward); // congestion never raises top speed
  const turn = clamp(a.turn, -1, 1);
  a.theta = wrapAngle(a.theta + turn * base.turnRate * DT); // speed modifier does not change angular speed
  a.x += Math.cos(a.theta) * a.speed * DT;
  a.y += Math.sin(a.theta) * a.speed * DT;
}
