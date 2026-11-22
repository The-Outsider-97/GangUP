# SLAI service

SLAI is the intelligence behind the Red faction: a Python HTTP service that runs the game's decision pipeline on the **real SLAI agents** from `<SLAI>/src/agents`, plus a trainable policy. (`--agents lite` runs a self-contained stdlib-only stand-in for each agent, used for tests and for machines without the SLAI checkout.)
It plays under the same laws as the human: it receives an *observation* containing only what Red's team can currently see, and answers
with *commands* that the TypeScript engine validates exactly like human input.

```
 TS engine ──build──► Observation (gangup.obs.v1) ──POST /v1/decide──► Orchestrator
     ▲                                                                   │ Perception → Learning → Planning → Collaborative → Safety → Evaluation
     └──── validated commands (gangup.act.v1, generation-stamped) ◄──────┘ (+ Observability, Knowledge)
```

## Protocol

* `POST /v1/decide` body `{observation, feedback[]}` → `{schema:"gangup.act.v1", generation, actions[], meta}`
* `POST /v1/match_end` `{seed, team, winner, episode?}` → Learning agent updates its opening profile, **once per episode** (see *Episodes and learning guarantees*)
* `GET /v1/health`, `GET /v1/stats` (latency percentiles, fallback counts, agent errors, rejection reasons)
* Every observation carries a **generation**; every action echoes it plus `issuedAt` / `expiresAt` ticks. The engine rejects stale generations,
  expired actions, non-owned units, hidden targets, unreachable destinations and AI surrender (R1.2, R10.2). Safety re-checks the same rules before
  anything leaves the service.
* Difficulty is cadence + reaction latency only (`src/ai/director.ts`).

## Real SLAI agents (`slai/bridge`)

`python -m slai.server` builds the eight agents through SLAI's own `AgentFactory` (`slai/bridge/host.py`) and routes every stage of a
decision through them (`slai/bridge/adapters.py`). The real agents are general frameworks: none of them knows what a squad or a flank lane is.
GangUP therefore supplies the game-specific meaning (the situation from the authorised observation, the legal objectives, the arena rules, the
policy) and each real agent contributes its own capability:

| Stage | Real agent (`src/agents`) | What GangUP asks of it | Changes the decision? |
|---|---|---|---|
| Perception | `PerceptionAgent` | `perform_task(inference, text)` on a text rendering of the tactical snapshot → scene embedding → *novelty* vs the previous decision | Telemetry / learning signal |
| Learning | `LearningAgent` | `perform_task(observe, LearningSignal)`: a performance signal every 16 decisions (background), an outcome signal at match end (awaited briefly, then retried until acknowledged) | Telemetry + the agent's persistent signal store. The GangUP-specific bias learning (`adaptive.json`) stays in GangUP |
| Knowledge | SLAI's authorised knowledge store (`assurance.KnowledgeRepository` + `ScopedLexicalRetriever`) | Each validated tactic is a `kind="tactic"` record in project scope `gangup` (immutable revisions, seeded idempotently); `search(tags)` per decision with `project_id="gangup"` | **Yes**: only retrieved tactics are applied (a tactic that is applicable but not retrieved is counted in `/v1/stats`) |
| Planning | `PlanningAgent` | HTN: every candidate squad objective is a `Task` (abstract → primitive steps with preconditions over world-state facts); `decompose_task` per decision | **Yes**: infeasible objectives are masked before the policy chooses |
| Collaborative | `CollaborativeAgent` | `coordinate_tasks` arbitrates contested roles (supply, flank lanes, escort; squads are the agents, distance rank is their load); `assess_risk` second-guesses attacks | **Yes** (see the note on the risk floor) |
| Safety | `SafetyAgent` | `validate_action` on the proposed order set after the game-rule legality check | Advisory by default (verdict reported in `meta.safetyVerdict`); with `--safety-enforce` a `block` holds fire (orders other than squad bookkeeping/stance are dropped) and five blocks in a row switch it back to advisory |
| Evaluation | `EvaluationAgent` | `predict(...)` health forecast from decision metrics every 60 decisions (background) | Telemetry (`/v1/stats`) |
| Observability | `ObservabilityAgent` | `perform_task` with latencies / throughput / events, batched every 40 decisions (background) | Telemetry (`/v1/stats`) |

Operational rules: every real call is time-boxed (defaults: perception 150, knowledge 80, planning 120, collaborative 250, safety 250 ms; `--budget`),
serialised per agent, and circuit-broken (3 consecutive failures/timeouts → bypassed for 15 s, doubling to 4 min, then re-probed). A bypassed stage runs
the built-in fallback and is reported in `meta.stages` of every response, in the menu (`real SLAI agents n/8`) and in `/v1/stats` (`realAgents`, `realUse`).
`--strict-agents` refuses to start unless all eight load. `python -m slai.bridge` loads the agents, runs probe decisions and prints, per agent, whether it
loaded, how many calls were served for real, latency and the last error.

Notes from integrating them:

* `CollaborativeAgent.coordinate_tasks` can *delegate* tasks to the agents registered in its manager (`delegate_during_coordination`, default on). GangUP
  switches it off at start-up (and falls back to its own role rules if it cannot).
* The agent's `BayesianRiskModel` learns from its own verdicts, so it drifts to "veto everything" (measured: after ≈ 50 high-risk assessments the threshold falls
  from 0.60 to 0.25 and a risk of 0.3 is flagged). GangUP keeps it a bounded second opinion: an attack is vetoed only when the agent says review/halt **and** the
  domain risk is ≥ 0.73 (≈ 3:1 local odds against), uses separate agent keys for vetoes and role assignments, and configures `bayes_decay: 0.97`.
* **Knowledge goes through the governed repository, not `add_document`.** The first design seeded tactics with `KnowledgeAgent.add_document`; SLAI refuses un-scoped
  writes there (`KNW-1006`: project knowledge belongs in `assurance.KnowledgeRepository`), the seed raised `PermissionError`, the circuit breaker opened, and the stage ran the
  built-in lookup for every decision (0 of 6 decisions served for real in the first log). The check was right; the caller was wrong, and nothing was weakened. `slai/bridge/knowledge_store.py`
  holds a *trusted* `AccessContext` built from constants at the application boundary (principal `gangup-runtime`, project `gangup` only, write + review - SLAI needs review to
  activate a record, and GangUP's review is the maintainers' `validated` flag - never global publication, never attestation). Seeding creates one record per validated tactic, writes a new
  revision when a tactic changes and archives removed ones (history is kept); retrieval is scope-filtered in SQL before ranking. The SQLite file is
  `slai/data/state/knowledge.sqlite` (`--knowledge-db`). The tests run the real repository and ACL and prove the denials (no global publish, no other project, no cross-project reads).
* **Start-up warm-up.** Real agents initialise lazily (Perception's first inference, Safety's first validation take seconds). `Orchestrator.warm_up()` runs
  those first calls in parallel at start-up, prints `warm <agent> ready in N ms`, and measures the second ("steady-state") call. Perception then gets ≈ 3×
  its steady-state time as budget (150–400 ms) unless `--budget perception=MS` is given. A failed warm-up never stops the server; the stage uses its
  fallback and `python -m slai.bridge` prints the traceback.
* **Safety runs in the background.** `SafetyAgent.validate_action` runs guard, cyber, reward-model, STPA and constitutional checks: measured at ≈ 4 s per call on a
  development machine, far more than a decision may wait. Warm-up measures the steady-state call; if it exceeds 60 % of the safety budget the stage switches
  to *async* mode: a review is dispatched in the background (one at a time) and its verdict is cached by the *shape* of the order set (squad, command, doctrine,
  formation, stance, goal; coordinates and ticks excluded). Orders of a shape not yet judged go out after the game-rule legality check
  (`meta.stages.safety = "real (async: review pending)"`); once judged, the verdict is attached to the response (`meta.safetyVerdict`: decision, risk, blockers, degraded components). A fast agent is called synchronously as before.
* **Safety is advisory by default.** On the SLAI checkout the real agent returned `block` at risk 0.75 (the block threshold, i.e. a blocker is present) for every game order
  set, so enforcing it would freeze the AI. Verdicts are therefore recorded and reported, not enforced; `--safety-enforce` makes a `block` hold fire for that order shape
  (until 5 blocks in a row, which turns it advisory again). `python -m slai.bridge` prints the blockers and degraded components behind a verdict.
* **Perception vocabulary.** The scene is described in a closed 30-word vocabulary (counts and health are bucketed), which is added to the agent's tokenizer with its
  public `add_tokens` at warm-up, so the embedding does not depend on whether the tokenizer's BPE files are present.
* **State ladder.** `python -m slai.bridge` and `/v1/stats → ladder` report, per agent and as separate facts: initialized → healthy → called → executed → contributed → persisted. A loaded agent that was never called, or one that
  answered but only feeds telemetry, never shows `contributed`; the knowledge row describes the repository (the instance's own call count is `agentInstanceCalled`).
* **Defects in the SLAI checkout** (`slai/bridge/compat.py`). Three bugs make a real agent fail on every call; GangUP repairs the *loaded modules in memory* (nothing on
  disk is touched), logs `compat: ...` and lists them in `/v1/health`. A repair is skipped when the defect is gone, so fixing SLAI upstream is safe.
  1. `src/agents/base/modules/base_tokenizer.py` uses `Literal` (lines ≈ 397, 678) without importing it → `NameError` in every `PerceptionAgent` text inference.
     Upstream fix: add `Literal` to its `from typing import ...` line.
  2. `src/agents/planning_agent.py` imports SLAI's own `Any`, then `from .planning.utils.planning_errors import *` (no `__all__`, does `from typing import Any`)
     replaces it with `typing.Any` → `TypeError: typing.Any cannot be used with isinstance()` in every `decompose_task`. Upstream fix: re-import `Any`
     after the star imports, or give `planning_errors` an `__all__`.
  3. `src/agents/perception/modules/tokenizer.py`: `BytePairEncoder.bpe` loops `min(pairs, ...)` with no guard for a word the merges folded into a single symbol →
     `ValueError: min() iterable argument is empty` for any text containing such a word. Upstream fix: `while len(word) > 1:` around the merge loop.
  All three are fixed in the SLAI change that accompanies this one (with regression tests in `tests/test_gangup_integration_regressions.py`); the in-memory repairs stay as a no-op safety net and
  can be deleted once that SLAI version is the minimum supported one.
* **Messages that are correct and stay.** `Skipping TRL checkpoint: factory environment has state_dim=4 action_dim=2; expected 5 and 4` is SLAI refusing to load the scheduling TRL checkpoint into an
  environment of a different shape (the one the LearningAgent was built with; the checkpoint wants 5 state / 4 action dimensions); GangUP only sends it observe signals and never uses its RL sub-agents and incompatible weights are not loaded - leave it. `Adaptive email/url model uses an
  incompatible persistence schema ... deterministic degraded mode` is the SafetyAgent rejecting two legacy phishing-model files that predate the signed `safety_neural_network.model.v3`
  format; they are not migrated (re-signing weights of unknown provenance would launder them) - retrain and re-save them with the current `NeuralNetwork`, or set `model_loading.fail_closed_on_schema_mismatch`.
  The EvaluationAgent's PostgreSQL issue tracker is optional: without a server it retries 3 times (1 s + 2 s) and keeps issues in memory; set `evaluation_agent.issue_database_retries: 1` (or give it a database) in SLAI's own configuration.

## Episodes and learning guarantees

Every game has an **episode id** (a UUID made by the client or the headless runner; the deterministic engine never invents one). It travels in `obs.episode` and in
`/v1/match_end`, and it is what per-match state is keyed by, so two games with the same seed (a rematch, two tabs, a replay) never share state.

* **Idempotent.** The profile (`adaptive.json`) remembers the last 256 processed `episode:team` tokens. A retried `match_end` returns `{"duplicate": true}` and changes nothing, also
  after a restart. Without an episode id the call is accepted only for a game this service actually played, and only once. The two teams of one episode are separate results.
* **Only real games count.** The client and `headless.ts` report an outcome only when SLAI answered at least one decision (`AIDirector.finish`), once, and never for a timed-out match.
  Headless runs finalize their episodes too (SLAI matches adapt the profile; pass `--no-learn` to `headless.ts` to leave it untouched, e.g. for benchmarks).
* **Both heads learn.** `update_from_match` nudges the squad-objective biases *and* the Main-objective biases (`main_bias` was read before but never updated), each by
  `lr × reward × (share used − uniform)`, clipped to ±0.5.
* **Acknowledged delivery to the real LearningAgent.** A signal counts as `acked` only when the agent answers `recorded` (or `duplicate`). The outcome signal is awaited for up to 2 s;
  if the agent is busy, slow or down it stays `pending` and is retried in the background. `/v1/stats → realUse.learning` shows `submitted / acked / failed / dropped / pending / persisted`
  and the last error; the `match_end` answer carries `delivery` (`acked` or `pending (reason)`). After an acknowledged outcome the agent's learning memory is written to
  `slai/data/learning_memory.pt` (one fixed file, atomic, overwritten; a durability barrier, not restored automatically). Signal ids are unique per service run and episode.
* **Stance hysteresis.** `decide_stance` keeps a stance for at least 3 s unless the Main is in danger, and returns to offensive only above a strength ratio of 0.55 (it goes defensive below 0.4)
  with one more soldier than the trigger, so a borderline fight no longer flips the stance on every decision. The scripted baseline keeps its plain rule as the documented control.
* **Provenance.** Every response carries `meta.decisionId` (`episode:team:tick:generation`), the policy version and the stage sources. The replay download records `episodeId` and,
  per team, who controlled it (human / SLAI / baseline), difficulty, how many decisions SLAI answered, how many fell back, and the last policy and decision id.

## Persistent policy learning (`slai/learner.py`)

GangUP learns across games by reusing SLAI's generic external-learning service (`src/agents/learning/external_*`: residual-softmax policy, REINFORCE with an EMA baseline, bounded
residual, hashed atomic checkpoints). Nothing GangUP-specific lives in SLAI; GangUP supplies what is specific to the game:

| Concern | What happens |
|---|---|
| Heads | `squad` (8 objectives, 28 features) and `main` (5 goals, 21 features), each with its own namespaced state directory `<dir>/<head>-<schema fingerprint>`; a changed feature/objective definition changes the fingerprint, so old weights are **never** loaded under a new meaning (`restore: fresh_start`) |
| Prior | the shipped imitation policy's scores (plus knowledge and opponent biases). The learned part is a bounded *residual* added to it (`max_param_norm`), so learning refines the prior |
| Legality | the learner only ever sees the legal / HTN-feasible mask; a guardrail override that runs a different objective is reported (`executed`) and that decision is not credited |
| Reward | outcome (win +1, loss -1, draw 0) at the end, plus a small potential-based shaping term from the team's own Main health and soldier count (`--learning-shaping`, 0 = off) |
| Episodes | keyed `episode:team`; the two teams of one game are separate; a game that ends by time limit is `truncated` (terminal reward 0, no winner, never counted by the opponent profile); abandoned live episodes are aborted after 15 min idle |
| Idempotency | every finished episode is one fsync'd line in `episodes.jsonl` (decisions, whether an optimizer step ran, parameter hashes before/after); a repeated `match_end` returns `duplicate`, also after a restart |
| Modes | `--learning off` (imitation argmax, the previous behaviour, default) · `train` (samples from the learned policy over legal objectives, learns from finished games, autosaves) · `evaluate` (greedy from the restored checkpoint, **cannot** train) |
| Persistence | the service flushes and checkpoints on SIGTERM/SIGINT; `evaluate`/`train` restore the latest verified checkpoint at start |
| Visibility | `/v1/learning` and `/v1/stats → learning` keep the pipeline stages apart: decisions recorded · reward events · episodes finished · optimizer steps · parameters changed · checkpoints saved / restored. An acknowledgement is not an update, and an update is not an improvement |

```powershell
# train against live games (e.g. headless runs), then serve the frozen result
python -m slai.server --agents lite --learning train    --learning-dir .\slai\data\policy --port 8765
python -m slai.server --agents lite --learning evaluate --learning-dir .\slai\data\policy --port 8765
```

`python tools/learning_experiment.py` trains candidates, validates them against the imitation policy on held-out seeds, applies a promotion gate (a candidate is promoted only if the lower 95 % bound of its
validation improvement is above 0; otherwise production stays the previous policy - the rollback), then runs the test seeds once, a restore-determinism check and a head-to-head. Results are in `docs/LEARNING_EVALUATION.md`.
No improvement per game is promised: learning can be slow, can overfit the scripted opponent, and is gated for exactly that reason.

## Agents (GDD 13.2): the built-in stand-ins (`slai/agents`, `--agents lite`)

These hold the game-specific domain logic the adapters reuse (situation building, tag derivation, legality rules, outcome attribution, bias math) and are the
documented fallback for a stage whose real agent is unavailable.

| Agent | Role |
|---|---|
| Perception | Summarises the authorised observation into a situation: focus enemy, threats, outnumbering, pickup, ≤ 3 s last-known records |
| Planning | Chooses squad objectives and stance from the policy, masked to legal objectives |
| Collaborative | Organises the unassigned pool into squads; de-conflicts squads (one supply contest, distinct flank lanes, escort when the Main is endangered) and staggers standoff distances |
| Learning | Online opponent model from legitimate sightings → small clipped score biases; after each match a reward-weighted nudge of persistent per-objective biases (`slai/data/adaptive.json`, created at runtime) |
| Knowledge | Validated tactics library (`slai/data/tactics.json`); tunes resolver parameters only |
| Safety | Independent validation: schema, legality, authority, visibility, bounds; repairs or drops commands and keeps an audit trail |
| Evaluation | Attributes changes in relative strength / Main health to the objectives that were active; diagnostics only, never a source of hidden information |
| Observability | Decision timing, error and invalid-action rates, optional JSONL telemetry |

The **TacticalDecisionPolicy** is two linear-softmax heads (squad objectives: ProtectMain, Reposition, PressTarget, HarassFlank, ContestSupply,
Hold, Regroup, Disengage; Main goals: Engage, HoldNear, MoveTo, Retreat, Resupply) behind a legal-action masker. It only ranks objectives; a deterministic
resolver (`resolver.py`) turns the chosen objective into commands. The model can never set damage, positions or hidden information.
If `weights.json` is missing or corrupt the service runs the scripted objectives instead and says so in `/v1/health`.

## Training regime (GDD 13.3)

`slai/train.py` reads self-play JSONL logs (`headless.ts --log`), splits train / hold-out **by match seed**, fits both heads by supervised imitation of
the scripted objectives, weights samples by match outcome (win 1.0, draw 0.7, loss 0.5), and writes `slai/data/weights.json` with provenance.

Shipped weights: 60 matches (48 train / 12 hold-out seeds), 26 192 squad and 22 942 Main samples, hold-out accuracy 99.8 % (majority-class baselines:
51.5 % squad, 57.4 % Main, so the model genuinely reproduces the labeller rather than a prior).

## Honest evaluation

Paired SLAI-vs-baseline matches (seeds 500–519, each seed played from both sides, hard difficulty): **SLAI 20 wins, 18 losses, 2 timeouts**.
The policy is therefore *as strong as* the scripted baseline it imitates, not stronger. Because imitation targets the scripted labeller, high accuracy
is expected and is not evidence of strength. Improving beyond parity needs a signal other than imitation (self-play reinforcement, search, or
evolutionary tuning of the resolver biases).
