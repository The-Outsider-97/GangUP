import { HARASS, LOCAL_AI, RIFLE, SQUAD, SWORD } from './constants.js';
import { bodyguardPosition, fallbackPoint, memberSlot, squadOf } from './squads.js';
import { aimTolerance, enemiesOf, faceAngle, laneState, steer, stopMotion } from './locomotion.js';
import { angleDiff, clamp } from './geom.js';
import type { Match } from './match.js';
import type { Actor, Squad, TaskState, Team } from './types.js';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

interface Role {
  ax: number;
  ay: number;
  leash: number;
  kind: 'squad' | 'guard' | 'reserveDef' | 'reserveOff';
}

/** Best estimate of where the enemy is, from the team's legitimate shared view only (no hidden information). */
export function enemyFocus(m: Match, team: Team): { x: number; y: number } {
  const ts = m.teams[team];
  const main = m.actors.get(ts.mainId)!;
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (const id of ts.teamVisible) {
    const e = m.actors.get(id);
    if (!e || !e.alive) continue;
    const d = dist(e, main);
    if (d < bd) { bd = d; best = { x: e.x, y: e.y }; }
  }
  if (best) return best;
  for (const lk of ts.lastKnown.values()) {
    const d = dist(lk, main);
    if (d < bd) { bd = d; best = { x: lk.x, y: lk.y }; }
  }
  if (best) return best;
  const sp = m.arena.mainSpawn[1 - team];
  return { x: m.arena.width / 2 + (sp.x - m.arena.width / 2) * 0.25, y: sp.y };
}

function roleOf(m: Match, s: Actor, sq: Squad | null, main: Actor): Role {
  const ts = m.teams[s.team];
  if (sq) {
    const p = memberSlot(m, s) ?? { x: main.x, y: main.y };
    return { ax: p.x, ay: p.y, leash: SQUAD.guardRadius, kind: 'squad' };
  }
  if (s.ai.bodyguard) {
    const idx = Math.max(0, ts.bodyguards.indexOf(s.id));
    const p = bodyguardPosition(m, s.team, idx, Math.max(1, ts.bodyguards.length));
    return { ax: p.x, ay: p.y, leash: 3.5, kind: 'guard' };
  }
  if (ts.stance === 'defensive') {
    const ang = s.id * 2.39996;
    return { ax: main.x + Math.cos(ang) * 5.5, ay: main.y + Math.sin(ang) * 5.5, leash: SQUAD.guardRadius, kind: 'reserveDef' };
  }
  const f = enemyFocus(m, s.team);
  const dx = f.x - main.x;
  const dy = f.y - main.y;
  const len = Math.hypot(dx, dy) || 1;
  const lat = ((s.id % 5) - 2) * 1.6;
  return {
    ax: main.x + (dx / len) * 8 + (-dy / len) * lat,
    ay: main.y + (dy / len) * 8 + (dx / len) * lat,
    leash: 12,
    kind: 'reserveOff',
  };
}

function chooseTarget(m: Match, s: Actor, sq: Squad | null, enemies: Actor[]): Actor | null {
  const cands = enemies.filter((e) => dist(s, e) <= RIFLE.range + 2);
  if (!cands.length) return null;
  const pref = sq?.target;
  const score = (e: Actor): number => {
    const d = dist(s, e);
    let sc = -d;
    if (e.kind === 'main') sc += 14;
    if (e.hp < e.hpMax * 0.4) sc += 6;
    if (pref && pref.kind !== 'none') {
      if (pref.kind === 'unit' && e.id === pref.id) sc += 200;
      else if (pref.kind === 'area' && Math.hypot(e.x - pref.x, e.y - pref.y) <= 6) sc += 40;
      else if (pref.kind === 'squad') {
        const anchor = m.actors.get(pref.id);
        if (anchor && Math.hypot(e.x - anchor.x, e.y - anchor.y) <= 6) sc += 60;
      }
    }
    return sc;
  };
  const ranked = cands.map((e) => ({ e, sc: score(e) })).sort((a, b) => b.sc - a.sc || a.e.id - b.e.id);
  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    if (laneState(m, s, ranked[i].e) !== 'clear') ranked[i].sc -= 40; // blocking risk
  }
  ranked.sort((a, b) => b.sc - a.sc || a.e.id - b.e.id);
  const cur = s.ai.targetId >= 0 ? ranked.find((r) => r.e.id === s.ai.targetId) : undefined;
  // selection hysteresis (0.5 s) reduces thrashing; an immediately threatening, much better target overrides it
  if (cur && m.tick - s.ai.targetSince < LOCAL_AI.targetHysteresis && ranked[0].sc - cur.sc < 60) return cur.e;
  const pick = ranked[0].e;
  if (pick.id !== s.ai.targetId) {
    s.ai.targetId = pick.id;
    s.ai.targetSince = m.tick;
  }
  return pick;
}

/** Move towards a goal with bounded replanning: on failure hold/regroup and retry with exponential back-off. */
function moveTo(m: Match, s: Actor, gx: number, gy: number, o: { arrive?: number; reverse?: boolean } = {}): boolean {
  const ai = s.ai;
  if (ai.blocked && m.tick < ai.blockedUntil) {
    stopMotion(s);
    ai.task = 'Regrouping';
    return false;
  }
  ai.goalX = gx;
  ai.goalY = gy;
  const ok = steer(m, s, gx, gy, o);
  if (!ok) {
    ai.blocked = true;
    ai.blockedFails++;
    ai.blockedUntil = m.tick + Math.min(LOCAL_AI.retryMax, LOCAL_AI.retryBase * 2 ** (ai.blockedFails - 1));
    stopMotion(s);
    ai.task = 'Regrouping';
    return false;
  }
  // stuck detection: no progress for 1.5 s while trying to move => treat as path failure
  if (m.tick - ai.progressTick >= 90) {
    const moved = Math.hypot(s.x - ai.progressX, s.y - ai.progressY);
    const far = Math.hypot(gx - s.x, gy - s.y) > (o.arrive ?? 0.4) + 1;
    ai.progressTick = m.tick;
    ai.progressX = s.x;
    ai.progressY = s.y;
    if (far && moved < 0.35 && Math.abs(s.throttle) > 0.2) {
      ai.blockedFails++;
      if (ai.blockedFails >= 3) {
        ai.blocked = true;
        ai.blockedUntil = m.tick + Math.min(LOCAL_AI.retryMax, LOCAL_AI.retryBase * 2 ** (ai.blockedFails - 1));
        stopMotion(s);
        ai.task = 'Regrouping';
        return false;
      }
    } else if (moved >= 0.35) {
      ai.blockedFails = 0;
    }
  }
  ai.blocked = false;
  return true;
}

function ownZonePoint(m: Match, s: Actor): { x: number; y: number } {
  const z = m.arena.zones[s.team];
  return { x: clamp(s.x, z.x0 + 0.8, z.x1 - 0.8), y: clamp(s.y, z.y0 + 0.8, z.y1 - 0.8) };
}

/** Face and (if legal) fire at a target. Returns true when the soldier is aligned within tolerance. */
function aimAndFire(m: Match, s: Actor, t: Actor, canFire: boolean): boolean {
  const d = dist(s, t);
  const desired = Math.atan2(t.y - s.y, t.x - s.x);
  const err = faceAngle(s, desired);
  const aligned = Math.abs(err) <= aimTolerance(t, d);
  if (aligned && canFire && s.mag > 0 && s.reloadEnd < 0 && m.tick + LOCAL_AI.controllerInterval >= s.nextFireTick && d <= RIFLE.range) {
    const lane = laneState(m, s, t);
    if (lane === 'clear') s.wantFire = true;
    else if (lane === 'ally') {
      // hold fire and choose an offset rather than spend a bullet
      s.turn = s.id % 2 ? 1 : -1;
      s.throttle = 0.6;
    }
  }
  return aligned;
}

/** One local-controller update for one soldier (10–30 Hz). */
export function thinkSoldier(m: Match, s: Actor): void {
  const ai = s.ai;
  const ts = m.teams[s.team];
  const main = m.actors.get(ts.mainId)!;
  const sq = squadOf(m, s);
  const doctrine = sq ? sq.doctrine : 'Defend';
  s.wantFire = s.wantSwipe = s.wantThrust = s.wantReload = s.wantSwitch = false;

  const enemies = enemiesOf(m, s);
  const role = roleOf(m, s, sq, main);
  const noAmmo = s.mag === 0 && s.reserve === 0;
  const refillReady = m.tick - ai.lastRefillTick >= 1200;

  // ----- equipment (parallel to movement): reload without changing the movement obligation
  if (s.mode === 'rifle' && s.reloadEnd < 0) {
    if (s.mag === 0 && s.reserve > 0) s.wantReload = true;
    else if (!enemies.length && s.mag < RIFLE.soldier.mag && s.reserve > 0) s.wantReload = true;
  }

  let task: TaskState = 'Idle';
  const dAnchor = Math.hypot(role.ax - s.x, role.ay - s.y);

  // ----- Disengage: initiate nothing, return to the fallback point
  if (doctrine === 'Disengage') {
    const fb = sq ? fallbackPoint(m, s.team, sq) : { x: main.x, y: main.y };
    if (s.mode === 'sword') s.wantSwitch = true;
    moveTo(m, s, fb.x, fb.y, { arrive: 1.2 });
    ai.task = ai.blocked ? 'Regrouping' : 'Retreating';
    return;
  }

  // ----- out of ammunition: retreat to resupply (or melee, by doctrine and danger)
  const nearest = enemies.length ? enemies.reduce((p, q) => (dist(s, p) <= dist(s, q) ? p : q)) : null;
  if (noAmmo && refillReady && !(nearest && dist(s, nearest) < 2.5 && doctrine === 'Press')) {
    if (s.mode === 'sword') s.wantSwitch = true;
    const z = ownZonePoint(m, s);
    moveTo(m, s, z.x, z.y, { arrive: 0.5 });
    ai.task = ai.blocked ? 'Regrouping' : 'Retreating';
    return;
  }

  // ----- melee (sword multiplier stays 0.20)
  const meleeTarget = nearest && dist(s, nearest) - nearest.radius <= SWORD.thrust.reach ? nearest : null;
  const meleeNow = !!meleeTarget && (noAmmo || dist(s, meleeTarget) < (doctrine === 'Press' ? 1.8 : 1.3));
  if (meleeNow && s.strain < 80 && s.overloadEnd < 0) {
    if (s.mode !== 'sword') s.wantSwitch = true;
    else {
      const d = dist(s, meleeTarget!);
      const err = faceAngle(s, Math.atan2(meleeTarget!.y - s.y, meleeTarget!.x - s.x));
      if (Math.abs(err) < 0.3) {
        const near = enemies.filter((e) => dist(s, e) - e.radius <= SWORD.swipe.reach).length;
        if (near >= 2) s.wantSwipe = true;
        else if (d - meleeTarget!.radius <= SWORD.thrust.reach) s.wantThrust = true;
      }
    }
    ai.task = 'Engaging';
    return;
  }
  if (s.mode === 'sword' && !(nearest && dist(s, nearest) < 3.5)) s.wantSwitch = true;

  // ----- engagement logic by doctrine
  const target = chooseTarget(m, s, sq, enemies);

  const guardAnchorD = (t: Actor) => Math.hypot(t.x - role.ax, t.y - role.ay);
  let engaged = false;

  if (doctrine === 'Defend') {
    if (target && guardAnchorD(target) <= role.leash) {
      // counterattack within the guard radius, but never chase indefinitely beyond it
      engaged = true;
      task = 'Engaging';
      const d = dist(s, target);
      if (d > 10 && dAnchor <= role.leash) {
        moveTo(m, s, target.x, target.y, { arrive: 9 });
        const aligned = Math.abs(angleDiff(s.theta, Math.atan2(target.y - s.y, target.x - s.x))) <= aimTolerance(target, d);
        if (aligned && d <= 14 && laneState(m, s, target) === 'clear' && s.mag > 0 && s.reloadEnd < 0) s.wantFire = true;
      } else aimAndFire(m, s, target, true);
    } else if (target && dAnchor <= 2.5 && dist(s, target) <= RIFLE.range) {
      engaged = true;
      task = 'Guarding';
      aimAndFire(m, s, target, true); // hold position and fire along the lane
    }
  } else if (doctrine === 'Press') {
    if (target) {
      engaged = true;
      task = 'Engaging';
      const d = dist(s, target);
      if (d > 6.5) {
        moveTo(m, s, target.x, target.y, { arrive: 6 });
        const aligned = Math.abs(angleDiff(s.theta, Math.atan2(target.y - s.y, target.x - s.x))) <= aimTolerance(target, d);
        if (aligned && d <= 13 && laneState(m, s, target) === 'clear' && s.mag > 0 && s.reloadEnd < 0) s.wantFire = true;
      } else aimAndFire(m, s, target, true);
    }
  } else if (doctrine === 'Harass') {
    if (ai.withdrawing) {
      const opp = m.actors.get(ai.lastOpponentId);
      if (!opp || !opp.alive || dist(s, opp) >= HARASS.withdrawDistance + 0.5) {
        ai.withdrawing = false; // engagement timer resets only after the withdrawal completes
        ai.engagementStart = -1;
        ai.hitsInEngagement = 0;
      } else {
        const dx = s.x - opp.x;
        const dy = s.y - opp.y;
        const len = Math.hypot(dx, dy) || 1;
        const f = m.nav.nearestFree('small', s.x + (dx / len) * 8, s.y + (dy / len) * 8) ?? { x: role.ax, y: role.ay };
        moveTo(m, s, f.x, f.y, { arrive: 0.5 });
        engaged = true;
        task = 'Retreating';
      }
    }
    if (!ai.withdrawing && target) {
      engaged = true;
      task = 'Harassing';
      if (ai.engagementStart < 0) {
        ai.engagementStart = m.tick;
        ai.hitsInEngagement = 0;
      }
      ai.lastOpponentId = target.id;
      if (ai.hitsInEngagement >= HARASS.maxHits || m.tick - ai.engagementStart >= HARASS.maxEngagement) {
        ai.withdrawing = true; // withdraw after two hits or 3 s, whichever comes first
      } else {
        const d = dist(s, target);
        if (d > 9.5) {
          moveTo(m, s, target.x, target.y, { arrive: 9 });
          const aligned = Math.abs(angleDiff(s.theta, Math.atan2(target.y - s.y, target.x - s.x))) <= aimTolerance(target, d);
          if (aligned && d <= 14 && laneState(m, s, target) === 'clear' && s.mag > 0 && s.reloadEnd < 0) s.wantFire = true;
        } else aimAndFire(m, s, target, true);
      }
    }
    if (!engaged && !target && ai.engagementStart >= 0 && m.tick - ai.engagementStart > HARASS.maxEngagement * 2) {
      ai.engagementStart = -1;
      ai.hitsInEngagement = 0;
    }
  } else {
    // unassigned soldiers use Defend-equivalent behaviour on their role anchor
    if (target && dAnchor <= role.leash + 2 && dist(s, target) <= RIFLE.range) {
      engaged = true;
      task = 'Engaging';
      const d = dist(s, target);
      if (d > 11 && guardAnchorD(target) <= role.leash + 4) moveTo(m, s, target.x, target.y, { arrive: 9 });
      else aimAndFire(m, s, target, true);
    }
  }

  // ----- movement obligation when not engaged: go to the role anchor / squad destination
  if (!engaged) {
    const reverse = dAnchor < 2.2;
    if (dAnchor > 0.7) {
      moveTo(m, s, role.ax, role.ay, { arrive: 0.5, reverse });
      if (!ai.blocked) {
        task = sq
          ? sq.move.kind === 'Follow'
            ? 'Following'
            : sq.move.kind === 'Move'
              ? 'Moving'
              : 'Guarding'
          : role.kind === 'reserveOff'
            ? 'Seeking'
            : 'Moving';
      } else task = 'Regrouping';
    } else {
      stopMotion(s);
      ai.blocked = false;
      ai.blockedFails = 0;
      // face the likely threat direction while idle
      const f = enemyFocus(m, s.team);
      const err = angleDiff(s.theta, Math.atan2(f.y - s.y, f.x - s.x));
      if (Math.abs(err) > 0.25) s.turn = clamp(err / (0.25 * 4), -1, 1) * 0.5;
      task = sq ? 'Guarding' : role.kind === 'guard' ? 'Guarding' : 'Idle';
    }
  }
  ai.task = task;
  if (!target) ai.targetId = -1;
}
