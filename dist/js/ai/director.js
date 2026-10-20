import { translateAction, toEnvelope } from './actions.js';
import { buildObservation } from './observation.js';
import { scriptedPolicy } from './scripted.js';
import { ACT_SCHEMA } from './schema.js';
/**
 * Difficulty changes planning cadence and reaction latency only (GDD 13.4). It never changes damage, accuracy, vision,
 * spawning, health or information — SLAI always plays under the same laws as the player.
 */
export const DIFFICULTY = {
    easy: { interval: 120, latency: 66 }, // 0.5 Hz, 1.1 s reaction
    normal: { interval: 60, latency: 24 }, // 1 Hz, 0.4 s
    hard: { interval: 30, latency: 9 }, // 2 Hz, 0.15 s
};
/** Drives one AI-controlled team: builds observations, asks SLAI (asynchronously) and applies validated actions. */
export class AIDirector {
    team;
    cfg;
    stats = {
        decisions: 0, requests: 0, ok: 0, timeouts: 0, errors: 0, invalid: 0, stale: 0, fallbackDecisions: 0,
        actionsApplied: 0, actionsRejected: 0, lastLatencyMs: 0, avgLatencyMs: 0, lastPolicy: 'baseline', lastService: '', lastDecisionId: '', lastAgents: [], online: false, degraded: false,
    };
    onDecision;
    nextDecision = 0;
    inflight = false;
    probeCountdown = 0;
    latencySum = 0;
    feedback = [];
    lastRejects = new Map();
    finished = false;
    constructor(team, cfg) {
        this.team = team;
        this.cfg = cfg;
    }
    attach(m) {
        m.commandListeners.push((env, res) => {
            if (env.team !== this.team || env.source === 'human')
                return;
            if (res.ok)
                this.stats.actionsApplied++;
            else {
                this.stats.actionsRejected++;
                if (this.feedback.length < 64)
                    this.feedback.push({ command: env.cmd.t, reason: res.reason ?? 'unknown' });
                this.lastRejects.set(res.reason ?? 'unknown', (this.lastRejects.get(res.reason ?? 'unknown') ?? 0) + 1);
            }
        });
    }
    /** Identity and provenance of this controller for the replay / result screen: who played, and which path served its decisions. */
    describe() {
        const s = this.stats;
        return {
            team: this.team, kind: this.cfg.mode, difficulty: this.cfg.difficulty, decisions: s.decisions, slaiAnswered: s.ok,
            fallbackDecisions: s.fallbackDecisions, lastPolicy: s.lastPolicy, lastService: s.lastService || undefined, lastDecisionId: s.lastDecisionId || undefined,
        };
    }
    /**
     * Report the finished match to SLAI so its Learning agent can adapt, exactly once per episode. Only when SLAI actually answered at
     * least one decision (a match played entirely by the fallback teaches SLAI nothing). Safe to call repeatedly; resolves to the service's
     * answer, or null when nothing was sent.
     */
    async finish(m, timeoutMs = 4000) {
        if (this.finished || this.cfg.mode !== 'slai' || !m.result.over || this.stats.ok === 0)
            return null;
        this.finished = true;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const res = await fetch(this.cfg.baseUrl + '/v1/match_end', {
                method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
                body: JSON.stringify({ seed: m.seed, team: this.team, winner: m.result.winner, episode: m.episodeId }),
            });
            return res.ok ? (await res.json()) : null;
        }
        catch {
            return null;
        }
        finally {
            clearTimeout(timer);
        }
    }
    due(m) {
        return !m.result.over && m.tick >= this.nextDecision && !this.inflight;
    }
    /** Real-time use: never blocks the simulation. Call once per frame/tick. */
    poll(m) {
        if (!this.due(m))
            return;
        void this.decide(m, false);
    }
    /** Headless use: await a full decision (build → request → apply). */
    async decideNow(m) {
        if (m.result.over)
            return;
        await this.decide(m, true);
    }
    async decide(m, awaitIt) {
        const dcfg = DIFFICULTY[this.cfg.difficulty];
        this.nextDecision = m.tick + dcfg.interval;
        const obs = buildObservation(m, this.team, this.cfg.difficulty, this.cfg.deadlineMs);
        this.stats.decisions++;
        const useSlai = this.cfg.mode === 'slai' && (!this.stats.degraded || this.probeCountdown <= 0);
        if (this.stats.degraded)
            this.probeCountdown = this.probeCountdown <= 0 ? 4 : this.probeCountdown - 1;
        if (!useSlai) {
            this.applyBaseline(m, obs);
            return;
        }
        this.inflight = true;
        this.stats.requests++;
        const t0 = performance.now();
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.cfg.deadlineMs);
        const fb = this.feedback.splice(0);
        const work = (async () => {
            try {
                const res = await fetch(this.cfg.baseUrl + '/v1/decide', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ observation: obs, feedback: fb }),
                    signal: ctl.signal,
                });
                if (!res.ok)
                    throw new Error('http ' + res.status);
                const body = (await res.json());
                const latency = performance.now() - t0;
                clearTimeout(timer);
                this.inflight = false;
                if (m.result.over)
                    return;
                if (!body || body.schema !== ACT_SCHEMA || !Array.isArray(body.actions)) {
                    this.stats.invalid++;
                    this.fail(m, obs);
                    return;
                }
                if (body.generation !== obs.generation || m.teams[this.team].aiGeneration !== obs.generation) {
                    this.stats.stale++; // a slow answer to an old observation is discarded
                    return;
                }
                this.stats.ok++;
                this.stats.online = true;
                this.stats.degraded = false;
                this.stats.lastLatencyMs = latency;
                this.latencySum += latency;
                this.stats.avgLatencyMs = this.latencySum / this.stats.ok;
                this.stats.lastPolicy = body.meta?.policy ?? 'slai';
                this.stats.lastService = body.meta?.service ?? '';
                this.stats.lastDecisionId = body.meta?.decisionId ?? '';
                this.stats.lastAgents = body.meta?.agents ?? [];
                const actions = body.actions.slice(0, obs.budget.maxActions);
                this.apply(m, obs, actions, 'slai');
                this.onDecision?.({ team: this.team, tick: obs.tick, observation: obs, actions, source: 'slai', latencyMs: latency, meta: body.meta });
            }
            catch (e) {
                clearTimeout(timer);
                this.inflight = false;
                if (e?.name === 'AbortError')
                    this.stats.timeouts++;
                else
                    this.stats.errors++;
                this.stats.online = false;
                if (!m.result.over)
                    this.fail(m, obs);
            }
        })();
        if (awaitIt)
            await work;
    }
    /** Timeout / malformed / outage: switch to the deterministic baseline immediately for this observation. */
    fail(m, obs) {
        this.stats.degraded = true;
        if (m.teams[this.team].aiGeneration === obs.generation)
            this.applyBaseline(m, obs);
    }
    applyBaseline(m, obs) {
        this.stats.fallbackDecisions++;
        if (this.cfg.mode === 'baseline') {
            this.stats.lastPolicy = 'scripted-baseline';
            this.stats.lastAgents = [];
        }
        else
            this.stats.lastPolicy = 'scripted-fallback';
        const actions = scriptedPolicy(obs);
        this.apply(m, obs, actions, 'baseline');
        this.onDecision?.({ team: this.team, tick: obs.tick, observation: obs, actions, source: 'baseline', latencyMs: 0 });
    }
    apply(m, obs, actions, source) {
        const latency = DIFFICULTY[this.cfg.difficulty].latency; // controlled reaction latency
        const mainId = m.teams[this.team].mainId;
        for (const a of actions) {
            const t = translateAction(a, mainId);
            if (!t.ok) {
                this.stats.invalid++;
                this.stats.actionsRejected++;
                if (this.feedback.length < 64)
                    this.feedback.push({ command: String(a?.command), reason: t.reason });
                continue;
            }
            m.submit(toEnvelope(a, this.team, t.cmd, source, Math.max(m.tick, obs.tick + latency)));
        }
    }
}
/** Write who controlled each team (and the AI provenance) into the replay. Human teams are those without a director. */
export function recordControllers(m, directors) {
    const out = [];
    for (const team of [0, 1]) {
        const d = directors.find((x) => x.team === team);
        out.push(d ? d.describe() : { team, kind: 'human' });
    }
    m.replay.config.controllers = out;
}
//# sourceMappingURL=director.js.map