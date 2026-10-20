import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AIDirector, recordControllers } from '../src/ai/director.js';
import { newEpisodeId } from '../src/ai/episode.js';
import { Match } from '../src/engine/match.js';
import { toEnvelope, translateAction } from '../src/ai/actions.js';
import { buildObservation } from '../src/ai/observation.js';
import { scriptedPolicy } from '../src/ai/scripted.js';
import type { AIAction } from '../src/ai/schema.js';
import { VISION, sec } from '../src/engine/constants.js';
import { Rng } from '../src/engine/rng.js';
import type { Command, Team } from '../src/engine/types.js';
import { baselineDirectors, checkInvariants, fresh, stepN } from './helpers.js';

test('observations contain only what the team may know and bump the generation (GDD 12.2, R10)', () => {
  const m = fresh(41);
  const d = baselineDirectors(m);
  let lastGen = 0;
  let samples = 0;
  for (let i = 0; i < 12; i++) {
    stepN(m, 600, d);
    for (const team of [0, 1] as Team[]) {
      const obs = buildObservation(m, team, 'normal', 400);
      const ts = m.teams[team];
      for (const e of obs.enemies.visible) assert.ok(ts.teamVisible.has(e.id), 'visible list ⊆ team view');
      for (const lk of obs.enemies.lastKnown) {
        assert.ok(!ts.teamVisible.has(lk.id), 'stale entries are not currently visible');
        assert.ok(lk.age <= VISION.lastKnown / 60 + 1e-9, 'stale entries are at most 3 s old');
      }
      const allowed = new Set([...obs.enemies.visible.map((e) => e.id), ...obs.enemies.lastKnown.map((e) => e.id)]);
      const enemyIds = [...m.actors.values()].filter((a) => a.team !== team).map((a) => a.id);
      const json = JSON.stringify({ ...obs, terrain: undefined });
      for (const id of enemyIds) {
        if (allowed.has(id)) continue;
        assert.ok(!new RegExp(`"(id|target|actor)":${id}[,}]`).test(json), `hidden enemy ${id} leaked into the observation`);
      }
      assert.ok(obs.generation > 0);
      samples++;
    }
    const g = m.teams[0].aiGeneration;
    assert.ok(g > lastGen);
    lastGen = g;
    if (m.result.over) break;
  }
  assert.ok(samples >= 6);
});

test('baseline policy outputs are well-formed and almost always accepted by the engine', () => {
  const m = fresh(42);
  const ds = baselineDirectors(m);
  stepN(m, sec(150), ds);
  for (const d of ds) {
    const s = d.stats;
    assert.ok(s.decisions > 20);
    assert.ok(s.actionsApplied > 50, `applied ${s.actionsApplied}`);
    assert.ok(s.actionsRejected <= 0.2 * (s.actionsApplied + s.actionsRejected), `rejected ${s.actionsRejected} of ${s.actionsApplied + s.actionsRejected}`);
  }
  const obs = buildObservation(m, 0, 'hard', 400);
  for (const a of scriptedPolicy(obs)) assert.equal(translateAction(a, m.teams[0].mainId).ok, true, JSON.stringify(a));
});

const junk = (r: Rng, depth = 0): unknown => {
  const pool: unknown[] = [NaN, Infinity, -Infinity, -1, 0, 1, 2, 9, 10, 11, 1e9, -1e9, 0.5, '', 'x', 'Press', 'Line', 'defensive', null, undefined, true, [], {}, [1, 2, 3], [NaN], { x: NaN, y: 1 }, { x: 50, y: 30 }, { x: -50, y: 900 }, { id: 3 }, { id: 2.5 }, { kind: 'unit', id: 99999 }];
  const v = pool[Math.floor(r.next() * pool.length)];
  return depth < 1 && r.next() < 0.1 ? { nested: junk(r, depth + 1) } : v;
};

test('fuzz: arbitrary AI/human commands never crash the engine or break its invariants (GDD 12.4, R10.2)', () => {
  const names = ['SetStance', 'CreateSquad', 'DisbandSquad', 'MoveSquad', 'FollowUnit', 'HoldPosition', 'SetDoctrine', 'SetFormation', 'SetTarget', 'SetLeader', 'SetRally', 'MainGoal', 'Nuke', 42 as unknown as string];
  for (const seed of [1, 2, 3]) {
    const r = new Rng(900 + seed);
    const m = fresh(60 + seed, 0);
    const baseline = baselineDirectors(m, [1]);
    let accepted = 0, rejected = 0;
    m.commandListeners.push((_e, res) => { if (res.ok) accepted++; else rejected++; });
    for (let tick = 0; tick < 1500; tick++) {
      for (let k = 0; k < 3; k++) {
        const ts = m.teams[1];
        const a: Record<string, unknown> = { command: names[Math.floor(r.next() * names.length)], generation: r.next() < 0.5 ? ts.aiGeneration : junk(r), issuedAt: m.tick, expiresAt: r.next() < 0.8 ? m.tick + 300 : junk(r) };
        for (const f of ['squad', 'actor', 'target', 'destination', 'doctrine', 'formation', 'stance', 'goal', 'members']) if (r.next() < 0.5) a[f] = junk(r);
        if (r.next() < 0.3) a.squad = 1 + Math.floor(r.next() * 9);
        if (r.next() < 0.3) a.members = m.soldiers(1).slice(0, 12).map((s) => s.id).filter(() => r.next() < 0.6);
        if (r.next() < 0.2) a.actor = m.teams[1].mainId;
        const t = translateAction(a as unknown as AIAction, ts.mainId);
        if (t.ok) m.submit(toEnvelope(a as unknown as AIAction, 1, t.cmd, r.next() < 0.5 ? 'slai' : 'baseline', m.tick));
      }
      if (tick % 7 === 0) {
        // raw, possibly malformed, human-side commands go through the same validation
        const cmds: Command[] = [
          { t: 'SquadMove', slot: Math.floor(r.next() * 12) - 1, x: r.next() * 140 - 20, y: r.next() * 80 - 10 },
          { t: 'CreateSquad', slot: 1 + Math.floor(r.next() * 9), members: m.soldiers(0).map((s) => s.id).filter(() => r.next() < 0.5) },
          { t: 'SquadTarget', slot: 1 + Math.floor(r.next() * 9), kind: 'unit', id: Math.floor(r.next() * 60) },
          { t: 'SquadFollow', slot: 1 + Math.floor(r.next() * 9), targetId: Math.floor(r.next() * 60) },
          { t: 'SquadLeader', slot: 1 + Math.floor(r.next() * 9), soldierId: Math.floor(r.next() * 60) },
          { t: 'SquadDoctrine', slot: 1 + Math.floor(r.next() * 9), doctrine: ['Defend', 'Press', 'Harass', 'Disengage', 'Bogus'][Math.floor(r.next() * 5)] as never },
        ];
        m.submit({ source: 'human', team: 0, cmd: cmds[Math.floor(r.next() * cmds.length)], issuedAt: m.tick });
      }
      for (const d of baseline) d.poll(m);
      m.step();
      if (tick % 150 === 0) assert.deepEqual(checkInvariants(m), [], `seed ${seed} tick ${tick}`);
      if (m.result.over) break;
    }
    assert.deepEqual(checkInvariants(m), []);
    assert.ok(rejected > 0 && accepted > 0, `fuzz exercised both paths (accepted ${accepted}, rejected ${rejected})`);
  }
});

test('director falls back to the scripted policy when SLAI is unreachable and the game never stalls (GDD 12.3, R10.3)', async () => {
  const m = fresh(70);
  const dirs = ([0, 1] as Team[]).map((t) => {
    const d = new AIDirector(t, { difficulty: 'hard', mode: t === 1 ? 'slai' : 'baseline', baseUrl: 'http://127.0.0.1:1', deadlineMs: 300 });
    d.attach(m);
    return d;
  });
  const t0 = performance.now();
  while (!m.result.over && m.tick < sec(40)) {
    for (const d of dirs) if (d.due(m)) await d.decideNow(m);
    m.step();
  }
  const s = dirs[1].stats;
  assert.equal(s.degraded, true);
  assert.ok(s.errors + s.timeouts > 0);
  assert.ok(s.fallbackDecisions > 10, `fallback decisions ${s.fallbackDecisions}`);
  assert.ok(s.actionsApplied > 10, 'fallback orders were actually executed');
  assert.ok(performance.now() - t0 < 30000);
});

function mock(handler: (body: string, res: any) => void): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req: any, res: any) => {
      let body = '';
      req.on('data', (c: any) => (body += c));
      req.on('end', () => handler(body, res));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
  });
}

test('director survives malformed, slow and stale SLAI responses', async () => {
  const run = async (handler: (body: string, res: any) => void, seconds = 12, deadline = 150) => {
    const srv = await mock(handler);
    const m = fresh(71);
    const d = new AIDirector(1, { difficulty: 'hard', mode: 'slai', baseUrl: srv.url, deadlineMs: deadline });
    d.attach(m);
    const d0 = new AIDirector(0, { difficulty: 'hard', mode: 'baseline', baseUrl: '', deadlineMs: 400 });
    d0.attach(m);
    while (m.tick < sec(seconds)) {
      if (d0.due(m)) await d0.decideNow(m);
      if (d.due(m)) await d.decideNow(m);
      m.step();
    }
    srv.close();
    assert.deepEqual(checkInvariants(m), []);
    return d.stats;
  };
  const garbage = await run((_b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{not json'); });
  assert.ok(garbage.errors > 0 && garbage.degraded && garbage.fallbackDecisions > 0, JSON.stringify(garbage));
  const wrongSchema = await run((_b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ schema: 'nope', actions: [] })); });
  assert.ok(wrongSchema.invalid > 0 && wrongSchema.degraded);
  const slow = await run((_b, res) => { setTimeout(() => { try { res.writeHead(200); res.end('{}'); } catch { /* closed */ } }, 1500); }, 6);
  assert.ok(slow.timeouts > 0 && slow.degraded, JSON.stringify(slow));
  const err500 = await run((_b, res) => { res.writeHead(500); res.end('boom'); });
  assert.ok(err500.errors > 0 && err500.fallbackDecisions > 0);
  // a valid-looking response for the WRONG generation is discarded, not executed
  const stale = await run((_b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ schema: 'gangup.act.v1', generation: -5, actions: [{ command: 'SetStance', stance: 'offensive', generation: -5, issuedAt: 0, expiresAt: 10 ** 9 }] })); });
  assert.ok(stale.stale > 0, JSON.stringify(stale));
  assert.equal(stale.actionsApplied, 0);
});

test('every game has an episode id that reaches the observation and the replay (never affects the simulation)', () => {
  const a = new Match({ seed: 5, humanTeam: null, episodeId: 'ep-A' });
  const b = new Match({ seed: 5, humanTeam: null, episodeId: 'ep-B' });
  assert.equal(buildObservation(a, 1, 'normal', 400).episode, 'ep-A');
  assert.equal(a.replay.config.episodeId, 'ep-A');
  assert.equal(fresh(9).episodeId, 'seed-9');
  assert.notEqual(newEpisodeId(), newEpisodeId());
  // the same seed with another id plays out identically
  const da = baselineDirectors(a);
  const db = baselineDirectors(b);
  stepN(a, 900, da);
  stepN(b, 900, db);
  assert.equal(JSON.stringify(a.replay.events), JSON.stringify(b.replay.events));
});

test('the replay records who controlled each team and which path served the AI', () => {
  const m = fresh(12, 0);
  const d = new AIDirector(1, { difficulty: 'hard', mode: 'slai', baseUrl: '', deadlineMs: 400 });
  d.attach(m);
  d.stats.decisions = 10;
  d.stats.ok = 7;
  d.stats.fallbackDecisions = 3;
  d.stats.lastPolicy = 'tdp-x';
  d.stats.lastDecisionId = 'ep:1:600:3';
  recordControllers(m, [d]);
  const c = m.replay.config.controllers!;
  assert.deepEqual(c[0], { team: 0, kind: 'human' });
  assert.equal(c[1].kind, 'slai');
  assert.equal(c[1].slaiAnswered, 7);
  assert.equal(c[1].fallbackDecisions, 3);
  assert.equal(c[1].lastDecisionId, 'ep:1:600:3');
});

test('finish() reports a finished match to SLAI exactly once, and only if SLAI actually played', async () => {
  const bodies: any[] = [];
  const srv = await mock((b, res) => { bodies.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"reward":1}'); });
  const mk = (mode: 'slai' | 'baseline') => new AIDirector(1, { difficulty: 'hard', mode, baseUrl: srv.url, deadlineMs: 400 });
  const over = (): Match => { const m = new Match({ seed: 3, humanTeam: null, episodeId: 'ep-fin' }); m.result = { over: true, winner: 1, reason: 'test', tick: 5 }; return m; };

  const unplayed = mk('slai'); // SLAI never answered: nothing to learn from
  assert.equal(await unplayed.finish(over()), null);
  const baseline = mk('baseline');
  baseline.stats.ok = 5;
  assert.equal(await baseline.finish(over()), null);
  const running = mk('slai');
  running.stats.ok = 5;
  assert.equal(await running.finish(new Match({ seed: 3, humanTeam: null })), null); // not over yet
  assert.equal(bodies.length, 0);

  const d = mk('slai');
  d.stats.ok = 5;
  const m = over();
  assert.deepEqual(await d.finish(m), { reward: 1 });
  assert.equal(await d.finish(m), null); // once
  assert.deepEqual(bodies, [{ seed: 3, team: 1, winner: 1, episode: 'ep-fin' }]);
  srv.close();
});

test('finish() never throws when the service is down', async () => {
  const d = new AIDirector(1, { difficulty: 'hard', mode: 'slai', baseUrl: 'http://127.0.0.1:9', deadlineMs: 400 });
  d.stats.ok = 1;
  const m = new Match({ seed: 3, humanTeam: null });
  m.result = { over: true, winner: null, reason: 'draw', tick: 1 };
  assert.equal(await d.finish(m, 500), null);
});
