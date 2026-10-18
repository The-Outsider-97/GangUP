import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanController, type NoticeKind } from '../src/client/controller.js';
import { buildHudModel, formatWaveArithmetic } from '../src/client/hudModel.js';
import { Renderer } from '../src/client/renderer.js';
import { STREAK, sec } from '../src/engine/constants.js';
import { processWave, registerStreakKill } from '../src/engine/economy.js';
import { createSquad } from '../src/engine/squads.js';
import { baselineDirectors, clearSoldiers, fresh, put, stepN } from './helpers.js';

const NONE = { shift: false, ctrl: false };
const SHIFT = { shift: true, ctrl: false };
const CTRL = { shift: false, ctrl: true };

function setup(seed = 80) {
  const m = fresh(seed, 0);
  const notes: [string, NoticeKind][] = [];
  const ctl = new HumanController(m, 0, (t, k) => notes.push([t, k]));
  return { m, ctl, notes };
}

test('W/S/A/D produce throttle and turn; opposing keys cancel; releaseAll stops motion (GDD 15.1)', () => {
  const { m, ctl } = setup();
  const c = m.teams[0].controls;
  ctl.keyDown('KeyW', NONE);
  assert.deepEqual({ ...c }, { throttle: 1, turn: 0 });
  ctl.keyDown('KeyD', NONE);
  assert.deepEqual({ ...c }, { throttle: 1, turn: 1 });
  ctl.keyDown('KeyA', NONE);
  assert.equal(c.turn, 0);
  ctl.keyUp('KeyA'); ctl.keyUp('KeyD'); ctl.keyDown('KeyS', NONE); ctl.keyUp('KeyW');
  assert.deepEqual({ ...c }, { throttle: -1, turn: 0 });
  ctl.releaseAll();
  assert.deepEqual({ ...c }, { throttle: 0, turn: 0 });
  const x0 = m.mainOf(0).x;
  ctl.keyDown('KeyW', NONE);
  stepN(m, 60);
  assert.ok(m.mainOf(0).x > x0 + 1, 'the Main drives forward');
});

test('Q/E set the stance; Tab switches mode; R reloads; left click fires, Shift+click thrusts only with the sword (GDD 15.1)', () => {
  const { m, ctl } = setup();
  const main = m.mainOf(0);
  ctl.keyDown('KeyE', NONE); stepN(m, 2);
  assert.equal(m.teams[0].stance, 'offensive');
  ctl.keyDown('KeyQ', NONE); stepN(m, 2);
  assert.equal(m.teams[0].stance, 'defensive');
  // rifle: left click fires, Shift+click is still a normal shot
  const mag = main.mag;
  ctl.mouseDown(50, 30, 0, NONE); ctl.mouseUp(0);
  stepN(m, 2);
  assert.equal(main.mag, mag - 1);
  assert.equal(main.wantThrust, false);
  ctl.mouseDown(50, 30, 0, SHIFT); ctl.mouseUp(0);
  assert.equal(main.wantThrust, false, 'Shift+click is not a thrust while the rifle is equipped');
  // sword: Tab switches (takes effect on the next tick), click swipes, Shift+click thrusts
  ctl.keyDown('Tab', NONE); stepN(m, 2);
  assert.equal(main.mode, 'sword');
  ctl.mouseDown(50, 30, 0, NONE); assert.equal(main.wantSwipe, true); ctl.mouseUp(0);
  stepN(m, sec(1));
  ctl.mouseDown(50, 30, 0, SHIFT); assert.equal(main.wantThrust, true); ctl.mouseUp(0);
  // reload
  ctl.keyDown('Tab', NONE); stepN(m, 2);
  assert.equal(main.mode, 'rifle');
  ctl.keyDown('KeyR', NONE); stepN(m, 2);
  assert.ok(main.reloadEnd >= 0 || main.mag === 10);
});

test('normal left click never selects; Ctrl+click and Ctrl+drag select soldiers only (GDD 15.1)', () => {
  const { m, ctl } = setup();
  const s = m.soldiers(0)[0];
  ctl.mouseDown(s.x, s.y, 0, NONE); ctl.mouseUp(0);
  assert.equal(ctl.selection.size, 0);
  ctl.mouseDown(s.x, s.y, 0, CTRL);
  assert.deepEqual([...ctl.selection], [s.id]);
  ctl.mouseDown(m.mainOf(0).x, m.mainOf(0).y, 0, CTRL);
  assert.equal(ctl.selection.size, 0, 'the Main is not a squad unit');
  ctl.dragSelect(0, 0, 100, 60, false);
  assert.equal(ctl.selection.size, 4);
  ctl.dragSelect(0, 0, 1, 1, false);
  assert.equal(ctl.selection.size, 0);
});

test('digits select squads; Shift+digit creates/replaces from the selection; empty selection is explained', () => {
  const { m, ctl, notes } = setup();
  ctl.keyDown('Digit2', SHIFT);
  assert.ok(notes.some(([t]) => /selected soldiers/i.test(t)), 'needs a selection');
  ctl.dragSelect(0, 0, 100, 60, false);
  ctl.keyDown('Digit2', SHIFT);
  stepN(m, 2);
  assert.equal(m.teams[0].squads[1].members.length, 4);
  assert.equal(ctl.selectedSquad, 2);
  ctl.keyDown('Digit5', NONE);
  assert.equal(ctl.selectedSquad, 5);
  // replace: select two soldiers into squad 3 — they leave squad 2
  const ids = m.teams[0].squads[1].members.slice(0, 2);
  ctl.selection = new Set(ids);
  ctl.keyDown('Digit3', SHIFT);
  stepN(m, 2);
  assert.deepEqual(m.teams[0].squads[2].members.slice().sort(), ids.slice().sort());
  assert.equal(m.teams[0].squads[1].members.length, 2);
});

test('squad orders: right-click move/rally, Z/X/C/V doctrines, H hold, G formation cycle (GDD 15.1)', () => {
  const { m, ctl, notes } = setup();
  ctl.keyDown('KeyZ', NONE);
  assert.ok(notes.some(([t]) => /select a squad/i.test(t)), 'squad orders need a selected squad');
  createSquad(m, 0, 1, m.soldiers(0).map((s) => s.id));
  ctl.keyDown('Digit1', NONE);
  ctl.mouseDown(40, 20, 2, NONE); stepN(m, 2);
  const sq = m.teams[0].squads[0];
  assert.equal(sq.move.kind, 'Move');
  assert.ok(Math.hypot(sq.move.x - 40, sq.move.y - 20) < 3);
  ctl.mouseDown(20, 40, 2, SHIFT); stepN(m, 2);
  assert.ok(sq.rally && Math.hypot(sq.rally.x - 20, sq.rally.y - 40) < 3);
  for (const [k, d] of [['KeyX', 'Press'], ['KeyC', 'Harass'], ['KeyV', 'Disengage'], ['KeyZ', 'Defend']] as const) {
    ctl.keyDown(k, NONE); stepN(m, 2);
    assert.equal(sq.doctrine, d);
  }
  ctl.keyDown('KeyH', NONE); stepN(m, 2);
  assert.equal(sq.move.kind, 'Hold');
  const seen: string[] = [sq.formation];
  for (let i = 0; i < 3; i++) { ctl.keyDown('KeyG', NONE); stepN(m, 2); seen.push(sq.formation); }
  assert.deepEqual(seen, ['Compact', 'Line', 'Spread', 'Compact']);
});

test('targeting: hidden enemies cannot be designated, visible ones can; F/L modes and Esc (GDD 15.1, 15.3)', () => {
  const { m, ctl } = setup();
  clearSoldiers(m, 0);
  clearSoldiers(m, 1);
  const g = [0, 1, 2].map((i) => m.createSoldier(0, 8 + i, 20 + i * 2, 0));
  const red = m.createSoldier(1, 80, 30, Math.PI);
  createSquad(m, 0, 1, g.slice(0, 2).map((s) => s.id));
  ctl.keyDown('Digit1', NONE);
  stepN(m, 14);
  assert.equal(m.teams[0].teamVisible.has(red.id), false);
  ctl.mouseDown(red.x, red.y, 2, NONE); stepN(m, 2);
  assert.equal(m.teams[0].squads[0].target.kind, 'none', 'a hidden enemy must not become a target');
  // bring it into plain view (open ground, 12 m ahead of the squad leader)
  const lead = g[0];
  put(lead, 20, 20, 0);
  put(red, 32, 20);
  put(m.mainOf(1), 90, 30);
  stepN(m, 14);
  assert.equal(m.teams[0].teamVisible.has(red.id), true);
  ctl.mouseDown(red.x, red.y, 2, NONE); stepN(m, 2);
  assert.equal(m.teams[0].squads[0].target.id, red.id);
  // follow: needs an allied unit outside the squad
  ctl.keyDown('KeyF', NONE);
  assert.equal(ctl.targetMode, 'follow');
  ctl.mouseDown(g[2].x, g[2].y, 2, NONE); stepN(m, 2);
  assert.equal(m.teams[0].squads[0].move.kind, 'Follow');
  assert.equal(m.teams[0].squads[0].move.followId, g[2].id);
  assert.equal(ctl.targetMode, 'none');
  // leader mode + Esc
  ctl.keyDown('KeyL', NONE);
  assert.equal(ctl.targetMode, 'leader');
  assert.equal(ctl.cancel(), true);
  assert.equal(ctl.targetMode, 'none');
  assert.equal(ctl.cancel(), false, 'nothing left to cancel ⇒ the UI opens the menu');
  ctl.keyDown('KeyL', NONE);
  ctl.mouseDown(g[1].x, g[1].y, 2, NONE); stepN(m, 2);
  assert.equal(m.teams[0].squads[0].leader, g[1].id);
});

test('HUD model: streak, wave arithmetic, Last Stand, squad cards and hidden-information rules (GDD 15.2–15.3)', () => {
  const m = fresh(81, 0);
  const d = baselineDirectors(m, [1]);
  let h = buildHudModel(m, 0);
  assert.equal(h.soldiers, 4);
  assert.equal(h.nextWaveBase, 5);
  assert.equal(h.streak.kills, 0);
  assert.equal(h.enemyMain, null);
  stepN(m, sec(10), d);
  h = buildHudModel(m, 0);
  assert.ok(Math.abs(h.nextWave - 10) < 0.05, `wave in ${h.nextWave}`);
  // streak progress / window
  const k = m.mainOf(0);
  m.tick = sec(11);
  registerStreakKill(m, k); registerStreakKill(m, k);
  h = buildHudModel(m, 0);
  assert.equal(h.streak.kills, 2);
  assert.ok(h.streak.windowLeft > 29 && h.streak.windowLeft <= 30);
  registerStreakKill(m, k); registerStreakKill(m, k);
  h = buildHudModel(m, 0);
  assert.equal(h.streak.active, true);
  assert.ok(Math.abs(h.streak.activeLeft - STREAK.duration / 60) < 0.05);
  assert.ok(Math.abs(h.streak.cooldownLeft - STREAK.cooldown / 60) < 0.05);
  assert.equal(h.main.shieldBonus, 5);
  // wave arithmetic text
  m.tick = sec(20);
  processWave(m);
  h = buildHudModel(m, 0);
  assert.match(formatWaveArithmetic(h.lastWave[0]), /Base 5 \+ streak 1 = 6/);
  assert.equal(formatWaveArithmetic({ time: 0, base: 0, ownBonus: 0, enemyPenalty: 0, capacityRoom: 40, spawned: 0, note: '' }), 'Base 0 (Main below 10 %): no reinforcements');
  // squad card never names a hidden target
  const sold = m.soldiers(0).map((s) => s.id);
  createSquad(m, 0, 1, sold);
  const foe = m.soldiers(1)[0];
  m.teams[0].squads[0].target = { kind: 'unit', id: foe.id, x: 0, y: 0 };
  assert.equal(buildHudModel(m, 0).squads[0].target, 'not visible');
  // Last Stand timer
  m.teams[0].collapseStart = m.tick - sec(10);
  assert.ok(Math.abs((buildHudModel(m, 0).lastStand.own ?? -1) - 20) < 0.05);
});

function mockCanvas() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ctx: any = new Proxy({}, {
    get(t: any, p: string) {
      if (p in t) return t[p];
      if (p === 'measureText') return () => ({ width: 10 });
      return (...args: unknown[]) => { calls.push({ fn: p, args }); };
    },
    set(t: any, p: string, v: unknown) { t[p] = v; return true; },
  });
  const canvas: any = { width: 1200, height: 720, getContext: () => ctx, getBoundingClientRect: () => ({ width: 1200, height: 720, left: 0, top: 0 }) };
  return { canvas, calls };
}

test('renderer: draws a full frame, shows only visible enemies, never labels hidden ones (GDD 15.3)', () => {
  const m = fresh(82, 0);
  const d = baselineDirectors(m, [1]);
  const { canvas, calls } = mockCanvas();
  const r = new Renderer(canvas, m, 0);
  r.setFog(false);
  const ctl = new HumanController(m, 0);
  ctl.keyDown('Digit1', NONE);
  stepN(m, 120, d);
  r.draw(ctl);
  const texts = () => calls.filter((c) => c.fn === 'fillText').map((c) => String(c.args[0]));
  assert.ok(texts().includes('YOU'));
  assert.ok(!texts().includes('ENEMY MAIN'), 'enemy Main is out of sight at the start');
  const world = r.toWorld(r.ox + 10 * r.scale, r.oy + 5 * r.scale);
  assert.ok(Math.abs(world.x - 10) < 1e-9 && Math.abs(world.y - 5) < 1e-9);
  // reveal the enemy Main: it must now be drawn, and it must disappear again once hidden
  const red = m.mainOf(1);
  put(m.mainOf(0), 20, 20, 0);
  put(red, 34, 20);
  stepN(m, 14);
  calls.length = 0;
  r.draw(ctl);
  assert.ok(texts().includes('ENEMY MAIN'));
  put(red, 40, 30);
  stepN(m, 14);
  calls.length = 0;
  r.draw(ctl);
  assert.ok(!texts().includes('ENEMY MAIN'), 'hidden again');
  assert.ok(texts().includes('?'), 'a stale marker is shown instead');
  // effects from a long fight never grow without bound
  for (let i = 0; i < 20; i++) { stepN(m, 120, d); r.draw(ctl, i % 2 === 0); }
});
