import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHit, attackMultiplier, rifleBaseDamage, shieldProtects } from '../src/engine/combat.js';
import { BACKWARD_FACTOR, LAST_STAND, MAIN, SOLDIER, STREAK, VISION, WAVE, sec } from '../src/engine/constants.js';
import { expireStreaks, processWave, registerStreakKill, streakActive, waveBase } from '../src/engine/economy.js';
import { executeCommand } from '../src/engine/commands.js';
import { speedLimits } from '../src/engine/movement.js';
import { createSquad } from '../src/engine/squads.js';
import { canSee, staleRecord } from '../src/engine/visibility.js';
import { baselineDirectors, checkInvariants, clearSoldiers, fingerprint, fresh, put, stepN } from './helpers.js';

test('wave base follows the Main HP bands, including every boundary (GDD 8.2)', () => {
  const cases: [number, number][] = [[0, 0], [9.99, 0], [10, 3], [39.99, 3], [40, 4], [79.99, 4], [80, 5], [100, 5]];
  for (const [hp, n] of cases) assert.equal(waveBase(hp), n, `hp ${hp}%`);
  assert.equal(WAVE.interval, sec(20));
});

test('rifle damage: 15 up to 2 m, linear falloff to 2 at 18 m, zero beyond (GDD 5.1)', () => {
  assert.equal(rifleBaseDamage(0), 15);
  assert.equal(rifleBaseDamage(2), 15);
  assert.ok(Math.abs(rifleBaseDamage(10) - 8.5) < 1e-9);
  assert.ok(Math.abs(rifleBaseDamage(18) - 2) < 1e-9);
  assert.equal(rifleBaseDamage(18.001), 0);
});

test('speed: F = V×M and B = F×0.7, applied exactly once (GDD 4.2)', () => {
  const m = fresh(3, 0);
  const main = m.mainOf(0);
  const f = speedLimits(m, main);
  assert.equal(f.forward, MAIN.forward);
  assert.ok(Math.abs(f.backward - MAIN.forward * BACKWARD_FACTOR) < 1e-12);
  const ids = m.soldiers(0).map((s) => s.id);
  assert.ok(createSquad(m, 0, 1, ids).ok);
  const s = m.actors.get(ids[0])!;
  m.teams[0].squads[0].doctrine = 'Press';
  assert.ok(Math.abs(speedLimits(m, s).forward - SOLDIER.forward * 0.85) < 1e-12);
  assert.ok(Math.abs(speedLimits(m, s).backward - SOLDIER.forward * 0.85 * 0.7) < 1e-12);
  m.teams[0].squads[0].doctrine = 'Harass';
  assert.ok(Math.abs(speedLimits(m, s).forward - SOLDIER.forward * 1.25) < 1e-12);
});

test('soldier damage multiplier is 0.20 and doctrines scale it (GDD 10.1)', () => {
  const m = fresh(3, 0);
  const ids = m.soldiers(0).map((s) => s.id);
  createSquad(m, 0, 1, ids);
  const s = m.actors.get(ids[0])!;
  assert.equal(attackMultiplier(m, m.mainOf(0)), 1);
  m.teams[0].squads[0].doctrine = 'Defend';
  assert.ok(Math.abs(attackMultiplier(m, s) - 0.2) < 1e-12);
  m.teams[0].squads[0].doctrine = 'Press';
  assert.ok(Math.abs(attackMultiplier(m, s) - 0.23) < 1e-12);
  m.teams[0].squads[0].doctrine = 'Harass';
  assert.ok(Math.abs(attackMultiplier(m, s) - 0.16) < 1e-12);
});

test('rear shield: 120° arc, absorbs damage, overflow passes to the body (GDD 7)', () => {
  const m = fresh(1);
  const v = m.mainOf(0);
  put(v, 50, 30, 0); // facing +x
  const at = (deg: number, d = 10) => [50 + Math.cos((deg * Math.PI) / 180) * d, 30 + Math.sin((deg * Math.PI) / 180) * d] as const;
  assert.equal(shieldProtects(v, ...at(180)), true, 'directly behind');
  assert.equal(shieldProtects(v, ...at(121)), true, 'just inside the rear arc');
  assert.equal(shieldProtects(v, ...at(119)), false, 'just outside the rear arc');
  assert.equal(shieldProtects(v, ...at(0)), false, 'front');
  // behind: shield takes it all
  let ev = applyHit(m, null, v, 10, ...at(180), 'rifle');
  assert.equal(ev.blocked, true);
  assert.equal(v.hp, 100);
  assert.equal(v.shield, 15);
  // front: body takes it all
  ev = applyHit(m, null, v, 10, ...at(0), 'rifle');
  assert.equal(v.hp, 90);
  assert.equal(v.shield, 15);
  // overflow: 15 shield left, 20 incoming from behind => shield 0, body 5
  ev = applyHit(m, null, v, 20, ...at(180), 'rifle');
  assert.equal(v.shield, 0);
  assert.ok(Math.abs(v.hp - 85) < 1e-9);
  // shield gone: rear hits go to the body
  ev = applyHit(m, null, v, 4, ...at(180), 'rifle');
  assert.ok(Math.abs(v.hp - 81) < 1e-9);
  assert.equal(ev.blocked, false);
});

test('Press consumes shield 1.25× without changing body damage (GDD 10.2)', () => {
  const m = fresh(1, 0);
  const ids = m.soldiers(0).map((s) => s.id);
  createSquad(m, 0, 1, ids);
  m.teams[0].squads[0].doctrine = 'Press';
  const v = m.actors.get(ids[0])!;
  put(v, 50, 30, 0);
  v.shield = 8;
  const ev = applyHit(m, null, v, 4, 40, 30, 'rifle'); // from behind
  assert.equal(ev.shield, 5);
  assert.equal(v.shield, 3);
  assert.equal(v.hp, 30);
});

test('kill streak: 4 kills inside 30 s activate; +5 shield; ends after 40 s; 90 s lockout (GDD 9)', () => {
  const m = fresh(1);
  const k = m.mainOf(0);
  for (const t of [0, 600, 1200, 1700]) { m.tick = t; registerStreakKill(m, k); }
  assert.equal(streakActive(m, 0), true);
  assert.equal(k.shieldMax, 30);
  assert.equal(k.shield, 30);
  assert.equal(m.teams[0].streak.activations, 1);
  // kills during active/cooldown are not banked
  m.tick = 1800; registerStreakKill(m, k);
  assert.equal(m.teams[0].streak.kills.length, 0);
  // expires after exactly 40 s
  m.tick = 1700 + STREAK.duration - 1; expireStreaks(m);
  assert.equal(streakActive(m, 0), true);
  m.tick = 1700 + STREAK.duration; expireStreaks(m);
  assert.equal(streakActive(m, 0), false);
  assert.equal(k.shieldMax, MAIN.shield);
  assert.ok(k.shield <= MAIN.shield);
  // still locked out until 90 s after activation
  m.tick = 1700 + STREAK.duration + 10; registerStreakKill(m, k);
  assert.equal(m.teams[0].streak.kills.length, 0);
  m.tick = 1700 + STREAK.cooldown; expireStreaks(m);
  registerStreakKill(m, k);
  assert.equal(m.teams[0].streak.kills.length, 1, 'tracking restarts with an empty queue');
});

test('kill streak: 3 kills, or 4 kills spread over more than 30 s, do not activate', () => {
  const m = fresh(1);
  const k = m.mainOf(0);
  for (const t of [0, 100, 200]) { m.tick = t; registerStreakKill(m, k); }
  assert.equal(streakActive(m, 0), false);
  const m2 = fresh(1);
  for (const t of [0, 900, 1800 + 120, 1800 + 240]) { m2.tick = t; registerStreakKill(m2, m2.mainOf(0)); }
  assert.equal(streakActive(m2, 0), false, 'the first kill aged out of the window');
});

test('wave arithmetic: base, +1 own streak, −1 enemy streak, floor 1, capacity cap, no wave below 10% (GDD 8.2, 9.3)', () => {
  const run = (hp: number, own: boolean, enemy: boolean) => {
    const m = fresh(2);
    clearSoldiers(m);
    m.mainOf(0).hp = hp;
    if (own) { m.teams[0].streak.active = true; m.teams[0].streak.activatedAt = 0; m.teams[0].streak.activeUntil = 10 ** 9; }
    if (enemy) { m.teams[1].streak.active = true; m.teams[1].streak.activatedAt = 0; m.teams[1].streak.activeUntil = 10 ** 9; }
    m.tick = 1200;
    processWave(m);
    return m.teams[0].waves[m.teams[0].waves.length - 1];
  };
  assert.equal(run(100, false, false).adjusted, 5);
  assert.equal(run(100, true, false).adjusted, 6);
  assert.equal(run(100, false, true).adjusted, 4);
  assert.equal(run(100, true, true).adjusted, 5);
  assert.equal(run(20, false, true).adjusted, 2);
  assert.equal(run(15, false, true).spawned, 2);
  const low = run(5, true, false);
  assert.equal(low.base, 0);
  assert.equal(low.spawned, 0);
  // capacity: 48 alive + wave of 5 => only 2 arrive
  const m = fresh(2);
  clearSoldiers(m);
  for (let i = 0; i < 48; i++) m.createSoldier(0, 5 + (i % 8), 8 + Math.floor(i / 8) * 7, 0);
  processWave(m);
  const w = m.teams[0].waves[m.teams[0].waves.length - 1];
  assert.equal(w.capacityRoom, 2);
  assert.equal(w.spawned, 2);
  assert.equal(m.soldiers(0).length, 50);
});

test('vision: range 24 m, 220° FOV, opaque cover (GDD 6)', () => {
  const m = fresh(1);
  const a = m.mainOf(0), b = m.mainOf(1);
  put(a, 20, 20, 0);
  put(b, 40, 20);
  assert.equal(canSee(m, a, b), true, '20 m in the open, straight ahead');
  put(b, 46, 20);
  assert.equal(canSee(m, a, b), false, '26 m is out of range');
  put(b, 10, 20);
  assert.equal(canSee(m, a, b), false, 'behind the observer (outside 220°)');
  put(a, 20, 30, 0);
  put(b, 40, 30);
  assert.equal(canSee(m, a, b), false, 'the mid-field wall blocks the line');
  put(b, 20 + Math.cos(1.9) * 10, 30 + Math.sin(1.9) * 10);
  assert.equal(canSee(m, a, b), true, '109° off-axis is inside the 110° half-angle');
});

test('shared team view and 3 s last-known memory without live tracking (GDD 6.3)', () => {
  const m = fresh(1);
  clearSoldiers(m);
  const a = m.mainOf(0), b = m.mainOf(1);
  put(a, 20, 20, 0);
  put(b, 36, 20);
  stepN(m, 14);
  assert.ok(m.teams[0].teamVisible.has(b.id), 'seen');
  // step behind the wall: no longer visible; a stale record remains for ≤ 3 s at the frozen position
  put(b, 40, 30);
  stepN(m, 14);
  assert.equal(m.teams[0].teamVisible.has(b.id), false);
  const s1 = staleRecord(m, 0, b.id);
  assert.ok(s1 && s1.age <= VISION.lastKnown, 'stale record present');
  assert.ok(Math.hypot(s1!.x - 40, s1!.y - 30) > 1, 'the frozen marker is where the enemy WAS seen, not where it hid');
  put(b, 45, 32); // moves while hidden: the record must NOT follow
  stepN(m, 10);
  const s2 = staleRecord(m, 0, b.id);
  assert.ok(s2 && Math.abs(s2.x - s1!.x) < 1e-9 && Math.abs(s2.y - s1!.y) < 1e-9);
  stepN(m, sec(3.5));
  assert.equal(staleRecord(m, 0, b.id), null, 'forgotten after 3 s');
});

test('command validation: stale generation, expiry, AI surrender, hidden targets (GDD 12.3)', () => {
  const m = fresh(4, 0);
  const ts = m.teams[1];
  ts.aiGeneration = 5;
  const base = { team: 1 as const, issuedAt: 0 };
  assert.deepEqual(executeCommand(m, { ...base, source: 'slai', generation: 4, cmd: { t: 'Stance', stance: 'offensive' } }), { ok: false, reason: 'stale-generation' });
  // an AI source may never command the human-controlled team
  assert.equal(executeCommand(m, { team: 0, issuedAt: 0, source: 'baseline', cmd: { t: 'Stance', stance: 'offensive' } }).reason, 'forbidden-authority');
  assert.equal(executeCommand(m, { ...base, source: 'slai', generation: 5, cmd: { t: 'Surrender' } }).reason, 'ai-surrender-disabled');
  m.tick = 100;
  assert.equal(executeCommand(m, { ...base, source: 'baseline', expiresAt: 50, cmd: { t: 'Stance', stance: 'offensive' } }).reason, 'expired');
  assert.equal(executeCommand(m, { ...base, source: 'baseline', expiresAt: 500, cmd: { t: 'Stance', stance: 'offensive' } }).ok, true);
  // a human cannot designate an enemy that is not currently visible
  const h = fresh(4, 0);
  const ids = h.soldiers(0).map((s) => s.id);
  assert.ok(executeCommand(h, { source: 'human', team: 0, issuedAt: 0, cmd: { t: 'CreateSquad', slot: 1, members: ids } }).ok);
  const enemy = h.soldiers(1)[0];
  const r = executeCommand(h, { source: 'human', team: 0, issuedAt: 0, cmd: { t: 'SquadTarget', slot: 1, kind: 'unit', id: enemy.id } });
  assert.deepEqual(r, { ok: false, reason: 'hidden-target' });
  // squad full
  assert.equal(executeCommand(h, { source: 'human', team: 0, issuedAt: 0, cmd: { t: 'CreateSquad', slot: 2, members: Array.from({ length: 11 }, (_, i) => 100 + i) } }).reason, 'squad-full');
});

test('human surrender ends the match with the enemy winning (GDD 2.4)', () => {
  const m = fresh(4, 0);
  m.submit({ source: 'human', team: 0, issuedAt: 0, cmd: { t: 'Surrender' } });
  stepN(m, 2);
  assert.equal(m.result.over, true);
  assert.equal(m.result.winner, 1);
  assert.match(m.result.reason, /surrender/i);
});

test('Last Stand: Main < 10 HP with zero soldiers for 30 s loses; recovery resets the timer (GDD 11)', () => {
  const m = fresh(6);
  clearSoldiers(m, 0);
  put(m.mainOf(1), 92, 30);
  put(m.mainOf(0), 8, 30);
  m.mainOf(0).hp = 5;
  stepN(m, sec(29));
  assert.equal(m.result.over, false);
  assert.ok(m.teams[0].collapseStart >= 0);
  m.mainOf(0).hp = 50; // condition breaks
  stepN(m, 2);
  assert.equal(m.teams[0].collapseStart, -1, 'timer reset');
  m.mainOf(0).hp = 5;
  clearSoldiers(m, 0);
  stepN(m, LAST_STAND.duration + 5);
  assert.equal(m.result.over, true);
  assert.equal(m.result.winner, 1);
});

test('same-tick Last Stand collapse for both sides is a draw (GDD 11, R12)', () => {
  const m = fresh(6);
  clearSoldiers(m);
  m.mainOf(0).hp = 5;
  m.mainOf(1).hp = 5;
  stepN(m, LAST_STAND.duration + 5);
  assert.equal(m.result.over, true);
  assert.equal(m.result.winner, null);
});

test('determinism: same seed ⇒ identical state; different seed ⇒ different (GDD 17.3)', () => {
  const run = (seed: number) => {
    const m = fresh(seed);
    const d = baselineDirectors(m);
    stepN(m, sec(45), d);
    return fingerprint(m);
  };
  assert.equal(run(5), run(5));
  assert.notEqual(run(5), run(6));
});

test('50 v 50 stress: invariants hold and the tick stays inside the 60 Hz budget', () => {
  const m = fresh(9);
  const d = baselineDirectors(m);
  for (const team of [0, 1] as const) {
    const z = m.arena.zones[team];
    let n = m.soldiers(team).length;
    for (let i = 0; n < 50; i++, n++) m.createSoldier(team, z.x0 + 1 + (i % 8) * 1.1, z.y0 + 1 + Math.floor(i / 8) * 1.4, team === 0 ? 0 : Math.PI);
  }
  assert.equal(m.soldiers(0).length, 50);
  assert.equal(m.soldiers(1).length, 50);
  const t0 = performance.now();
  let ticks = 0;
  for (let s = 0; s < 40 && !m.result.over; s++) {
    stepN(m, 60, d);
    ticks += 60;
    const bad = checkInvariants(m);
    assert.deepEqual(bad, [], `t=${s}s`);
  }
  const msPerTick = (performance.now() - t0) / Math.max(1, ticks);
  console.log(`  50v50: ${msPerTick.toFixed(2)} ms/tick over ${ticks} ticks`);
  assert.ok(msPerTick < 10, `avg tick ${msPerTick.toFixed(2)} ms`);
});

test('full baseline matches reach a terminal state with all invariants intact', () => {
  for (const seed of [31, 32, 33]) {
    const m = fresh(seed);
    const d = baselineDirectors(m);
    let guard = 0;
    while (!m.result.over && m.tick < sec(420)) {
      stepN(m, 120, d);
      if (++guard % 5 === 0) assert.deepEqual(checkInvariants(m), [], `seed ${seed} t=${m.tick / 60}`);
    }
    assert.deepEqual(checkInvariants(m), []);
  }
});

test('both Mains dying on the same tick is a draw; the survivor of a single death wins immediately (R1.2, R11.2)', () => {
  const m = fresh(90);
  clearSoldiers(m);
  const a = m.mainOf(0), b = m.mainOf(1);
  put(a, 50, 30, 0);
  put(b, 50.9, 30, Math.PI);
  a.hp = b.hp = 3;
  a.shield = b.shield = 0; // unshielded body/body contact: 5 HP to each (R6.3)
  stepN(m, 5);
  assert.equal(m.result.over, true);
  assert.equal(m.result.winner, null, m.result.reason);
  assert.match(m.result.reason, /same tick/i);

  const m2 = fresh(91);
  clearSoldiers(m2);
  put(m2.mainOf(0), 50, 30, 0);
  put(m2.mainOf(1), 50.9, 30, Math.PI);
  m2.mainOf(0).hp = 3; m2.mainOf(0).shield = 0;
  m2.mainOf(1).hp = 60; m2.mainOf(1).shield = 0;
  stepN(m2, 5);
  assert.equal(m2.result.over, true);
  assert.equal(m2.result.winner, 1);
  assert.equal(m2.mainOf(1).alive, true);
});

test('streak credit: only direct soldier kills by a living Main qualify (R8.1)', () => {
  const m = fresh(92, 0);
  clearSoldiers(m);
  const main = m.mainOf(0);
  const credit = () => m.teams[0].streak.kills.length;
  // a Main kill of an enemy soldier at 5 m, point blank, no shield exposure → credited
  const victim = m.createSoldier(1, 50 + 5, 30, 0);
  put(main, 50, 30, 0);
  put(m.mainOf(1), 95, 55);
  victim.hp = 1;
  victim.shield = 0;
  for (let i = 0; i < 40 && victim.alive; i++) { m.mainAction(0, 'fire'); m.step(); }
  if (victim.alive) assert.fail('test setup: the shot never landed');
  assert.equal(credit(), 1);
  // an enemy soldier killed by a Green SOLDIER does not count
  const ally = m.createSoldier(0, 30, 20, 0);
  const v2 = m.createSoldier(1, 36, 20, 0);
  v2.hp = 0.001;
  v2.shield = 0;
  const before = credit();
  for (let i = 0; i < 200 && v2.alive; i++) { ally.wantFire = true; m.step(); }
  assert.equal(v2.alive, false, 'test setup: the soldier killed it');
  assert.equal(credit(), before, 'soldier kills never count toward the Main streak');
});
