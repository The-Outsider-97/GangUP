# SLAI service

SLAI is the intelligence behind the Red faction, a Python (standard library only) HTTP service plus a trainable policy.
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

## Agents (GDD 13.2)

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
