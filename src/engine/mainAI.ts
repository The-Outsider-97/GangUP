import { RIFLE, SWORD } from './constants.js';
import { angleDiff } from './geom.js';
import { aimTolerance, faceAngle, laneState, steer, stopMotion } from './locomotion.js';
import { staleRecord } from './visibility.js';
import { enemyFocus } from './soldierAI.js';
import type { Match } from './match.js';
import type { Actor, MainGoal, Team } from './types.js';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export function defaultMainGoal(m: Match, team: Team): MainGoal {
  const sp = m.arena.mainSpawn[team];
  return { kind: 'HoldNear', x: sp.x + (team === 0 ? 6 : -6), y: sp.y, targetId: -1, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
}

/**
 * Fast local executor for an AI-controlled Main (the SLAI strategic layer chooses *goals*; this layer turns them
 * into tank-control inputs under exactly the same movement, accuracy and visibility rules as the player).
 */
export function thinkMain(m: Match, a: Actor): void {
  const ts = m.teams[a.team];
  let goal = ts.mainGoal;
  if (m.tick > goal.expiresAt) goal = ts.mainGoal = defaultMainGoal(m, a.team);
  a.wantFire = a.wantSwipe = a.wantThrust = a.wantReload = a.wantSwitch = false;

  const visible: Actor[] = [];
  for (const id of ts.teamVisible) {
    const e = m.actors.get(id);
    if (e && e.alive) visible.push(e);
  }
  const nearest = visible.length ? visible.reduce((p, q) => (dist(a, p) <= dist(a, q) ? p : q)) : null;
  let target: Actor | null = null;
  const forced = goal.targetId >= 0 ? m.actors.get(goal.targetId) : undefined;
  if (forced && forced.alive && ts.teamVisible.has(forced.id)) target = forced;
  else {
    const enemyMain = visible.find((e) => e.kind === 'main' && dist(a, e) <= 16);
    target = enemyMain ?? nearest;
    if (target && dist(a, target) > RIFLE.range + 4) target = null;
  }

  // ----- equipment
  const noAmmo = a.mag === 0 && a.reserve === 0;
  if (a.mode === 'rifle' && a.reloadEnd < 0 && a.reserve > 0 && (a.mag === 0 || (!nearest || dist(a, nearest) > 18) && a.mag < RIFLE.main.mag)) a.wantReload = true;

  // ----- melee when cornered, empty, or enemy is on top of the Main
  const near = nearest && dist(a, nearest) - nearest.radius <= SWORD.thrust.reach ? nearest : null;
  if (near && a.strain < 70 && a.overloadEnd < 0 && (noAmmo || dist(a, near) < 1.7) && goal.kind !== 'Retreat') {
    if (a.mode !== 'sword') a.wantSwitch = true;
    else {
      const err = faceAngle(a, Math.atan2(near.y - a.y, near.x - a.x));
      if (Math.abs(err) < 0.25) {
        const count = visible.filter((e) => dist(a, e) - e.radius <= SWORD.swipe.reach).length;
        if (count >= 2) a.wantSwipe = true;
        else a.wantThrust = true;
      }
    }
    return;
  }
  if (a.mode === 'sword' && !(nearest && dist(a, nearest) < 3.5)) a.wantSwitch = true;

  const fireAt = (t: Actor, maxD: number): boolean => {
    const d = dist(a, t);
    const aligned = Math.abs(angleDiff(a.theta, Math.atan2(t.y - a.y, t.x - a.x))) <= aimTolerance(t, d);
    if (aligned && d <= maxD && a.mag > 0 && a.reloadEnd < 0 && laneState(m, a, t) === 'clear') {
      a.wantFire = true;
      return true;
    }
    return false;
  };

  switch (goal.kind) {
    case 'Engage': {
      if (target) {
        const d = dist(a, target);
        if (d > 9.5) {
          steer(m, a, target.x, target.y, { arrive: 8.5 });
          fireAt(target, 13);
        } else if (d < 4.5 && a.mode === 'rifle') {
          // back away while keeping the rifle on target (backward speed is only 70 %)
          const err = faceAngle(a, Math.atan2(target.y - a.y, target.x - a.x));
          a.throttle = -0.8;
          if (Math.abs(err) < 0.2) fireAt(target, RIFLE.range);
        } else {
          const err = faceAngle(a, Math.atan2(target.y - a.y, target.x - a.x));
          if (Math.abs(err) <= aimTolerance(target, d)) fireAt(target, RIFLE.range);
        }
      } else {
        const lk = goal.targetId >= 0 ? staleRecord(m, a.team, goal.targetId) : null;
        const f = lk ?? (dist(a, goal) > 1 ? goal : enemyFocus(m, a.team));
        steer(m, a, f.x, f.y, { arrive: 1.0 });
      }
      break;
    }
    case 'MoveTo': {
      steer(m, a, goal.x, goal.y, { arrive: 0.8, reverse: true });
      if (target) fireAt(target, 14);
      break;
    }
    case 'Retreat': {
      // run with the rear shield towards the threat
      if (dist(a, goal) > 1.0) steer(m, a, goal.x, goal.y, { arrive: 0.8 });
      else {
        const f = nearest ?? enemyFocus(m, a.team);
        faceAngle(a, Math.atan2(f.y - a.y, f.x - a.x) + Math.PI);
      }
      break;
    }
    case 'Resupply': {
      const p = m.pickup ?? goal;
      steer(m, a, p.x, p.y, { arrive: 0.5 });
      if (target) fireAt(target, 12);
      break;
    }
    case 'HoldNear':
    default: {
      if (target && dist(a, target) <= 16) {
        const d = dist(a, target);
        if (dist(a, goal) > 4.5 && d > 10) steer(m, a, goal.x, goal.y, { arrive: 1 });
        else {
          const err = faceAngle(a, Math.atan2(target.y - a.y, target.x - a.x));
          if (Math.abs(err) <= aimTolerance(target, d)) fireAt(target, RIFLE.range);
        }
      } else if (dist(a, goal) > 1.5) steer(m, a, goal.x, goal.y, { arrive: 1, reverse: true });
      else {
        stopMotion(a);
        const f = enemyFocus(m, a.team);
        faceAngle(a, Math.atan2(f.y - a.y, f.x - a.x));
      }
    }
  }
}
