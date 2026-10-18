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
* `POST /v1/match_end` `{seed, team, winner}` → Learning agent updates its opening profile
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
| Learning | `LearningAgent` | `perform_task(observe, LearningSignal)`: a performance signal every 16 decisions, an outcome signal at match end (background) | Telemetry + the agent's persistent signal store. The GangUP-specific bias learning (`adaptive.json`) stays in GangUP |
| Knowledge | `KnowledgeAgent` | `add_document` for each validated tactic, `retrieve(tags)` per decision | **Yes**: only retrieved tactics are applied (a tactic that is applicable but not retrieved is counted in `/v1/stats`) |
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
* Knowledge is configured with no document directory, no persisted store and no ontology expansion so that only GangUP's tactics are indexed.
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
* **Defects in the SLAI checkout** (`slai/bridge/compat.py`). Three bugs make a real agent fail on every call; GangUP repairs the *loaded modules in memory* (nothing on
  disk is touched), logs `compat: ...` and lists them in `/v1/health`. A repair is skipped when the defect is gone, so fixing SLAI upstream is safe.
  1. `src/agents/base/modules/base_tokenizer.py` uses `Literal` (lines ≈ 397, 678) without importing it → `NameError` in every `PerceptionAgent` text inference.
     Upstream fix: add `Literal` to its `from typing import ...` line.
  2. `src/agents/planning_agent.py` imports SLAI's own `Any`, then `from .planning.utils.planning_errors import *` (no `__all__`, does `from typing import Any`)
     replaces it with `typing.Any` → `TypeError: typing.Any cannot be used with isinstance()` in every `decompose_task`. Upstream fix: re-import `Any`
     after the star imports, or give `planning_errors` an `__all__`.
  3. `src/agents/perception/modules/tokenizer.py`: `BytePairEncoder.bpe` loops `min(pairs, ...)` with no guard for a word the merges folded into a single symbol →
     `ValueError: min() iterable argument is empty` for any text containing such a word. Upstream fix: `while len(word) > 1:` around the merge loop.

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
