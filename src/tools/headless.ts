/**
 * Headless match runner: scripted-vs-scripted or SLAI-vs-scripted self-play for balance, regression and
 * training-data collection (GDD 18.2).
 *
 *   tsx src/tools/headless.ts --matches 20 --max-sec 600 --mode baseline
 *   tsx src/tools/headless.ts --matches 10 --mode slai --url http://127.0.0.1:8765 --log data/obs.jsonl
 */
import { AIDirector, type DecisionRecord } from '../ai/director.js';
import { Match } from '../engine/match.js';
import type { Team } from '../engine/types.js';
import * as fs from 'node:fs';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

export interface MatchSummary {
  seed: number;
  winner: Team | null;
  reason: string;
  seconds: number;
  timedOut: boolean;
  soldiers: [number, number];
  spawned: [number, number];
  mainHp: [number, number];
  streaks: [number, number];
  kills: [number, number];
}

export async function runMatch(opts: {
  seed: number;
  maxSec: number;
  modes: ['slai' | 'baseline', 'slai' | 'baseline'];
  url: string;
  difficulty: 'easy' | 'normal' | 'hard';
  onDecision?: (r: DecisionRecord) => void;
  swapped?: boolean;
}): Promise<{ summary: MatchSummary; match: Match; directors: AIDirector[] }> {
  const m = new Match({ seed: opts.seed, humanTeam: null });
  const directors = ([0, 1] as Team[]).map((t) => {
    const d = new AIDirector(t, { difficulty: opts.difficulty, mode: opts.modes[t], baseUrl: opts.url, deadlineMs: 1500 });
    d.attach(m);
    if (opts.onDecision) d.onDecision = opts.onDecision;
    return d;
  });
  const maxTicks = Math.round(opts.maxSec * 60);
  while (!m.result.over && m.tick < maxTicks) {
    for (const d of directors) if (d.due(m)) await d.decideNow(m);
    m.step();
  }
  const timedOut = !m.result.over;
  const kills: [number, number] = [0, 0];
  for (const a of m.actors.values()) if (a.kind === 'main') kills[a.team] = a.stats.kills;
  return {
    match: m,
    directors,
    summary: {
      seed: opts.seed,
      winner: m.result.winner,
      reason: timedOut ? 'timeout' : m.result.reason,
      seconds: (timedOut ? m.tick : m.result.tick) / 60,
      timedOut,
      soldiers: [m.soldiers(0).length, m.soldiers(1).length],
      spawned: [m.teams[0].soldiersSpawned, m.teams[1].soldiersSpawned],
      mainHp: [Math.round(m.mainOf(0).hp), Math.round(m.mainOf(1).hp)],
      streaks: [m.teams[0].streak.activations, m.teams[1].streak.activations],
      kills,
    },
  };
}

async function main() {
  const n = Number(arg('matches', '10'));
  const maxSec = Number(arg('max-sec', '600'));
  const mode = arg('mode', 'baseline') as 'baseline' | 'slai';
  const url = arg('url', 'http://127.0.0.1:8765');
  const difficulty = arg('difficulty', 'hard') as 'easy' | 'normal' | 'hard';
  const logPath = arg('log', '');
  const seed0 = Number(arg('seed', '1'));
  const slaiTeam = Number(arg('slai-team', '1')) as Team;
  const log = logPath ? logPath : null;
  const wins = [0, 0];
  let draws = 0;
  let timeouts = 0;
  let secs = 0;
  for (let i = 0; i < n; i++) {
    const seed = seed0 + i;
    // alternate sides each match so that spawn-side bias is measured separately from policy strength
    const swap = i % 2 === 1;
    const sl = (swap ? 1 - slaiTeam : slaiTeam) as Team;
    const modes: ['slai' | 'baseline', 'slai' | 'baseline'] = mode === 'slai' ? (sl === 0 ? ['slai', 'baseline'] : ['baseline', 'slai']) : ['baseline', 'baseline'];
    const buf: DecisionRecord[] = [];
    const { summary } = await runMatch({ seed, maxSec, modes, url, difficulty, onDecision: log ? (r) => buf.push(r) : undefined });
    if (log) {
      const outcome = summary.winner === null ? 'draw' : 'win';
      const lines: string[] = [];
      for (const r of buf) {
        // terrain is static public information: replaced by a reference to keep self-play logs small
        const obs = { ...r.observation, terrain: { ref: 'arena-v1' } };
        lines.push(JSON.stringify({ seed, team: r.team, tick: r.tick, source: r.source, obs, actions: r.actions, winner: summary.winner, outcome }));
      }
      fs.appendFileSync(log, lines.join('\n') + '\n'); // synchronous: baseline-only runs never yield to the event loop
    }
    if (summary.timedOut) timeouts++;
    else if (summary.winner === null) draws++;
    else wins[summary.winner]++;
    secs += summary.seconds;
    const slaiSide = mode === 'slai' ? ` slai=${sl === 0 ? 'G' : 'R'}` : '';
    console.log(`seed ${seed}${slaiSide} winner=${summary.winner === null ? (summary.timedOut ? 'timeout' : 'draw') : summary.winner === 0 ? 'Green' : 'Red'} t=${summary.seconds.toFixed(0)}s soldiers=${summary.soldiers} spawned=${summary.spawned} mainHP=${summary.mainHp} streaks=${summary.streaks} mainKills=${summary.kills} :: ${summary.reason}`);
    if (mode === 'slai' && (sl === 0 || sl === 1)) {
      // tally per policy
    }
  }
  console.log(`\nGreen ${wins[0]}  Red ${wins[1]}  draws ${draws}  timeouts ${timeouts}  avg ${(secs / n).toFixed(0)} s`);
}

if (process.argv[1] && process.argv[1].includes('headless')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
