import {
  CONTACT,
  DOCTRINE,
  DT,
  HEAL,
  MAIN,
  MOVING_SPEED_THRESHOLD,
  RIFLE,
  SHIELD,
  SOLDIER,
  SPREAD_DEG,
  SWORD,
  deg,
} from './constants.js';
import { angleDiff, nearestObstacle, rayCircle, segmentBlocked, clamp } from './geom.js';
import type { Match } from './match.js';
import type { Actor } from './types.js';

export type DamageKind = 'rifle' | 'sword' | 'collision';

export interface DamageEvent {
  seq: number;
  tick: number;
  attacker: number; // -1 for collision-less environment
  victim: number;
  kind: DamageKind;
  /** body HP actually removed (overkill excluded) */
  applied: number;
  /** body damage including overkill */
  body: number;
  shield: number;
  blocked: boolean;
}

// ------------------------------------------------------------------ helpers
export function rifleSpec(a: Actor) {
  return a.kind === 'main' ? RIFLE.main : RIFLE.soldier;
}

/** Rifle damage by hit distance (GDD 5.1): 15 for d<=2; 15 - 13(d-2)/16 for 2<d<=18; 0 beyond. */
export function rifleBaseDamage(d: number): number {
  if (d > RIFLE.range) return 0;
  if (d <= RIFLE.closeRange) return RIFLE.closeDamage;
  return RIFLE.closeDamage - (RIFLE.falloffDrop * (d - RIFLE.closeRange)) / RIFLE.falloffSpan;
}

export function attackMultiplier(m: Match, a: Actor): number {
  if (a.kind === 'main') return MAIN.damageMult;
  const sq = a.squadSlot ? m.teams[a.team].squads[a.squadSlot - 1] : null;
  return SOLDIER.damageMult * (sq ? DOCTRINE[sq.doctrine].damage : 1);
}

/** Incoming shield-durability multiplier k (Press = 1.25, applied to shield loss, never to body damage). */
export function shieldConsumption(m: Match, v: Actor): number {
  if (v.kind === 'main' || v.squadSlot === 0) return 1;
  const sq = m.teams[v.team].squads[v.squadSlot - 1];
  return DOCTRINE[sq.doctrine].shieldTaken;
}

/** The rear shield covers a 120-degree arc: dot(f, i) <= -0.5 and shield HP > 0 (GDD 7.1, R6.1). */
export function shieldProtects(def: Actor, ox: number, oy: number): boolean {
  if (def.shield <= 0) return false;
  const dx = ox - def.x;
  const dy = oy - def.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return false;
  const dot = (Math.cos(def.theta) * dx + Math.sin(def.theta) * dy) / len;
  return dot <= SHIELD.arcDot;
}

export function isMoving(a: Actor): boolean {
  return Math.abs(a.speed) > MOVING_SPEED_THRESHOLD;
}

export function canInitiate(m: Match, a: Actor): boolean {
  if (a.kind === 'main' || a.squadSlot === 0) return true;
  return DOCTRINE[m.teams[a.team].squads[a.squadSlot - 1].doctrine].canInitiate;
}

// ------------------------------------------------------------------ damage application
/**
 * Resolve one raw damage hit through the target's directional shield (GDD 7.2).
 * For a blocked hit of raw damage D with shield multiplier k, the attempted shield loss is kD; the shield
 * absorbs fraction min(1, shield/(kD)) of D and the remainder reaches the body.
 */
export function applyHit(
  m: Match,
  attacker: Actor | null,
  victim: Actor,
  raw: number,
  ox: number,
  oy: number,
  kind: DamageKind,
): DamageEvent {
  let body = raw;
  let shieldLoss = 0;
  let blocked = false;
  if (raw > 0 && shieldProtects(victim, ox, oy)) {
    blocked = true;
    const k = shieldConsumption(m, victim);
    const attempted = k * raw;
    const frac = Math.min(1, victim.shield / attempted);
    shieldLoss = Math.min(victim.shield, attempted);
    body = raw * (1 - frac);
    victim.shield = Math.max(0, victim.shield - shieldLoss);
  }
  const applied = Math.min(body, Math.max(0, victim.hp));
  victim.hp -= body;
  victim.lastCombatTick = m.tick; // damage received resets regeneration
  const ev: DamageEvent = {
    seq: m.nextSeq(),
    tick: m.tick,
    attacker: attacker ? attacker.id : -1,
    victim: victim.id,
    kind,
    applied,
    body,
    shield: shieldLoss,
    blocked,
  };
  m.damageLog.push(ev);
  if (attacker) {
    attacker.stats.hits++;
    attacker.stats.damageDealt += applied;
    if (attacker.kind === 'soldier') attacker.ai.hitsInEngagement++;
    if (attacker.kind === 'main' && applied > 0 && (kind === 'rifle' || kind === 'sword')) {
      attacker.eligibleHeal += applied; // only body HP actually removed counts (7.5)
    }
  }
  return ev;
}

// ------------------------------------------------------------------ rifle
export function tryReload(m: Match, a: Actor): boolean {
  const spec = rifleSpec(a);
  if (a.mode !== 'rifle' || a.reloadEnd >= 0 || a.mag >= spec.mag || a.reserve <= 0) return false;
  a.reloadEnd = m.tick + spec.reload;
  return true;
}

export function completeReloads(m: Match, a: Actor): void {
  if (a.reloadEnd >= 0 && m.tick >= a.reloadEnd) {
    const spec = rifleSpec(a);
    const move = Math.min(spec.mag - a.mag, a.reserve);
    a.mag += move;
    a.reserve -= move;
    a.reloadEnd = -1;
    m.emit('reloaded', { actor: a.id });
  }
}

export function cancelReload(a: Actor): void {
  a.reloadEnd = -1; // reserve rounds are only moved at completion, so nothing is lost
}

export function switchMode(a: Actor): void {
  a.mode = a.mode === 'rifle' ? 'sword' : 'rifle';
  cancelReload(a); // a weapon switch cancels reload (5.4); cooldowns persist
}

/**
 * Fire the rifle: validate state, consume one round, sample seeded uniform spread, raycast 18 m and resolve
 * the nearest collision with cover / allied body / enemy shield / enemy body (GDD 5.3).
 */
export function tryFire(m: Match, a: Actor): boolean {
  if (!a.alive || a.mode !== 'rifle') return false;
  if (m.tick < a.nextFireTick || a.reloadEnd >= 0 || a.mag <= 0) return false;
  if (!canInitiate(m, a)) return false;
  const spec = rifleSpec(a);
  a.mag -= 1; // missed and ally-blocked shots still consume ammunition (R3.4)
  a.nextFireTick = m.tick + spec.interval; // cooldown persists across weapon changes
  a.lastCombatTick = m.tick; // attack attempt resets shield regeneration even on a miss
  a.stats.shots++;
  const moving = isMoving(a);
  const half = deg(
    a.kind === 'main' ? (moving ? SPREAD_DEG.mainMoving : SPREAD_DEG.mainStill) : moving ? SPREAD_DEG.soldierMoving : SPREAD_DEG.soldierStill,
  );
  const ang = a.theta + m.rngSpread.signed(half); // uniform signed angular deviation
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const ox = a.x + Math.cos(a.theta) * a.radius;
  const oy = a.y + Math.sin(a.theta) * a.radius;

  const tObs = nearestObstacle(m.arena.obstacles, ox, oy, dx, dy, RIFLE.range);
  let best: Actor | null = null;
  let bestT = Infinity;
  for (const o of m.live) {
    if (o === a || !o.alive) continue;
    const t = rayCircle(ox, oy, dx, dy, o.x, o.y, o.radius, RIFLE.range);
    if (t !== null && t < bestT) {
      bestT = t;
      best = o;
    }
  }
  if (tObs !== null && (best === null || tObs <= bestT + 0.001)) {
    // solid cover wins ties within 1 mm (6.5)
    m.emit('shot', { actor: a.id, x0: ox, y0: oy, x1: ox + dx * tObs, y1: oy + dy * tObs, result: 'cover' });
    return true;
  }
  if (!best) {
    m.emit('shot', { actor: a.id, x0: ox, y0: oy, x1: ox + dx * RIFLE.range, y1: oy + dy * RIFLE.range, result: 'miss' });
    return true;
  }
  if (best.team === a.team) {
    // allies absorb shots harmlessly (friendly damage is off)
    m.emit('shot', { actor: a.id, x0: ox, y0: oy, x1: ox + dx * bestT, y1: oy + dy * bestT, result: 'ally', victim: best.id });
    return true;
  }
  const raw = rifleBaseDamage(bestT) * attackMultiplier(m, a);
  const ev = applyHit(m, a, best, raw, a.x, a.y, 'rifle');
  m.emit('shot', {
    actor: a.id,
    x0: ox,
    y0: oy,
    x1: ox + dx * bestT,
    y1: oy + dy * bestT,
    result: ev.blocked ? 'shield' : 'body',
    victim: best.id,
    dmg: raw,
  });
  return true;
}

// ------------------------------------------------------------------ sword
export type SwordKind = 'swipe' | 'thrust';

export function swordAvailable(m: Match, a: Actor): boolean {
  return a.mode === 'sword' && a.overloadEnd < 0 && m.tick >= a.nextSwordTick;
}

export function trySword(m: Match, a: Actor, kind: SwordKind): boolean {
  if (!a.alive || !swordAvailable(m, a) || !canInitiate(m, a)) return false;
  const spec = SWORD[kind];
  a.nextSwordTick = m.tick + SWORD.cooldown; // shared cooldown; one swing cannot hit twice
  a.lastSwordAttempt = m.tick;
  a.lastCombatTick = m.tick;
  cancelReload(a); // a sword attack cancels reload (5.4)

  const candidates: { o: Actor; d: number }[] = [];
  for (const o of m.live) {
    if (!o.alive || o.team === a.team) continue;
    const d = Math.hypot(o.x - a.x, o.y - a.y);
    if (d - o.radius > spec.reach) continue;
    const dir = Math.atan2(o.y - a.y, o.x - a.x);
    const angRad = d > o.radius ? Math.asin(Math.min(1, o.radius / d)) : Math.PI;
    if (Math.abs(angleDiff(a.theta, dir)) > spec.sector / 2 + angRad) continue;
    if (segmentBlocked(m.arena.obstacles, a.x, a.y, o.x, o.y)) continue; // separated by solid geometry
    candidates.push({ o, d });
  }
  candidates.sort((p, q) => p.d - q.d || p.o.id - q.o.id);
  const picked = candidates.slice(0, spec.maxVictims);
  const mult = attackMultiplier(m, a);
  let hit = false;
  for (const { o } of picked) {
    const raw = spec.damage * mult;
    applyHit(m, a, o, raw, a.x, a.y, 'sword'); // shield interception counts as a successful hit
    hit = true;
  }
  m.emit('sword', { actor: a.id, kind, hits: picked.map((p) => p.o.id) });
  if (hit) {
    a.strain = Math.min(SWORD.strainMax, a.strain + spec.strain); // once per attack attempt
    if (a.strain >= SWORD.strainMax) {
      a.overloadEnd = m.tick + SWORD.overload;
      m.emit('overload', { actor: a.id });
    }
  }
  return true;
}

// ------------------------------------------------------------------ per-tick maintenance (tick step 1)
export function expireTimers(m: Match, a: Actor): void {
  completeReloads(m, a);
  if (a.overloadEnd >= 0 && m.tick >= a.overloadEnd) {
    a.overloadEnd = -1;
    a.strain = SWORD.overloadResetStrain;
  } else if (a.overloadEnd < 0 && a.strain > 0 && m.tick - a.lastSwordAttempt >= SWORD.recoveryDelay) {
    a.strain = Math.max(0, a.strain - SWORD.recoveryRate * DT);
  }
  if (a.shield < a.shieldMax && m.tick - a.lastCombatTick >= SHIELD.regenDelay) {
    const rate = a.kind === 'main' ? SHIELD.mainRegen : SHIELD.soldierRegen;
    a.shield = Math.min(a.shieldMax, a.shield + rate * DT);
  }
}

// ------------------------------------------------------------------ contact damage (7.4, R6.3)
export function applyContact(m: Match, a: Actor, b: Actor): void {
  // a's shield is "valid" when the opposing body is inside a's rear arc, likewise for b
  const aShield = shieldProtects(a, b.x, b.y);
  const bShield = shieldProtects(b, a.x, a.y);
  const hit = (v: Actor, shieldValid: boolean, other: Actor) => {
    if (shieldValid) {
      const loss = Math.min(v.shield, CONTACT.shieldDamage);
      v.shield -= loss;
      v.lastCombatTick = m.tick;
      m.damageLog.push({ seq: m.nextSeq(), tick: m.tick, attacker: other.id, victim: v.id, kind: 'collision', applied: 0, body: 0, shield: loss, blocked: true });
    } else {
      const applied = Math.min(CONTACT.bodyDamage, Math.max(0, v.hp));
      v.hp -= CONTACT.bodyDamage;
      v.lastCombatTick = m.tick;
      m.damageLog.push({ seq: m.nextSeq(), tick: m.tick, attacker: other.id, victim: v.id, kind: 'collision', applied, body: CONTACT.bodyDamage, shield: 0, blocked: false });
    }
  };
  // Shield vs body: shield loses 1; the exposed body loses 5. Shield vs shield: each loses 1.
  // Rule: a side whose rear shield faces the opponent pays 1 shield HP; a side exposed pays 5 body HP.
  hit(a, aShield, b);
  hit(b, bShield, a);
  m.emit('contact', { a: a.id, b: b.id, aShield, bShield });
}

// ------------------------------------------------------------------ healing (tick step 7)
/**
 * A surviving Main heals from enemy body HP its own rifle/sword actually removed this tick (never shield, collision,
 * assists, overkill). Threshold uses HP after incoming damage but before healing. One grant per second. (GDD 7.5)
 */
export function applyHealing(m: Match, a: Actor): void {
  const elig = a.eligibleHeal;
  a.eligibleHeal = 0;
  if (a.kind !== 'main' || !a.alive || elig <= 0) return;
  if (m.tick - a.lastHealTick < HEAL.cooldown) return;
  const heal = a.hp <= HEAL.lowThreshold ? Math.min(HEAL.lowFraction * elig, HEAL.lowCap) : Math.min(HEAL.highFraction * elig, HEAL.highCap);
  const before = a.hp;
  a.hp = clamp(a.hp + heal, 0, a.hpMax);
  a.lastHealTick = m.tick;
  if (a.hp > before) m.emit('heal', { actor: a.id, amount: a.hp - before });
}

