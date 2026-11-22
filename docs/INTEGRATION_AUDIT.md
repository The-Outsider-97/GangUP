# Integration audit: GangUP × SLAI

Scope: the failures in the start-up log (8 real agents, KnowledgeAgent 0/6, KNW-1006, repeated "Insufficient training data", three compat patches, TRL checkpoint shape, SafetyAgent schema, missing `response_quality`,
PostgreSQL fallback, config overrides, warm-up) and persistent continuous learning. Everything was built and tested in a Linux sandbox **without torch, statsmodels, a GPU, PostgreSQL or network access**, so anything that
needs the real heavy agents is marked as *not verified here*. Status words are used strictly: **fixed and tested** (a test fails without the change), **fixed, not verifiable here**, **by design / no change**, **open**.

## Findings and status

| # | Finding (evidence in the log) | Root cause | Status |
|---|---|---|---|
| 1 | KnowledgeAgent used 0 of 6 times, "Document add failed ... use assurance.KnowledgeRepository" (KNW-1006) | GangUP seeded tactics through the legacy `add_document` (public, un-scoped data only). The `PermissionError` opened the circuit breaker, so every decision ran the built-in lookup. SLAI's check is correct. | **Fixed and tested.** Tactics are project-scoped records in `assurance.KnowledgeRepository` with a trusted, least-privilege `AccessContext`; retrieval is `ScopedLexicalRetriever` with `project_id`. Tests use the real repository and ACL (`tests_py/test_knowledge_store.py`, 9). No SLAI check was weakened. *Not verified here:* the full `src.agents.knowledge` package import (needs statsmodels etc.); the assurance modules themselves were exercised unmodified. |
| 2 | "8 real agents" reported while the Knowledge stage was effectively fallback | "loaded" was being read as "operating" | **Fixed and tested.** Per-agent state ladder: initialized → healthy → called → executed → contributed → persisted (`python -m slai.bridge`, `/v1/stats → ladder`). The diagnostic's RESULT line no longer counts a stage as real unless it was actually called. Run here on the agents that load: Collaborative and Observability are real (ladder all yes); the others show NO with the reason. |
| 3 | `Insufficient training data, using fallback.` repeated on every call | `UncertaintyAwareHeuristic` re-checked readiness (and re-warned) on every evaluation although its data had not changed | **Fixed (SLAI), test skipped without torch.** Readiness is cached per training-data signature, warns once, exposes `readiness`, and is invalidated when data change. No data are fabricated; the fallback is still reported as a fallback. |
| 4 | Compat patches (Literal, `Any` shadowing, BPE `min()` on empty) | Three real defects in SLAI | **Fixed upstream in SLAI with regression tests** (`tests/test_gangup_integration_regressions.py`, 22 pass / 1 skipped; the BPE tests fail on the unfixed code). The runtime repairs in `slai/bridge/compat.py` are kept as a no-op safety net: they are skipped when the defect is gone, and I could not verify the real agents here, so I did not remove them. Delete them once the fixed SLAI is the minimum version. |
| 5 | `Skipping TRL checkpoint ... state_dim=4 action_dim=2; expected 5 and 4` | The scheduling TRL checkpoint is 5-in / 4-out; the LearningAgent's environment is 4/2. SLAI refuses to load it, which is right. | **By design.** Incompatible weights are never loaded. GangUP only sends observe signals. Documented in `docs/SLAI.md`. |
| 6 | SafetyAgent: legacy email/url phishing models "incompatible persistence schema" | Two model files predate `safety_neural_network.model.v3` (no `schema_version`, no signature) | **By design: rejected, not migrated.** The agent already degrades to deterministic mode and has a fail-closed switch. Re-signing weights of unknown provenance would launder them; retrain and re-save with the current `NeuralNetwork`. Not verifiable here (needs torch). |
| 7 | `SafetyAgent runtime config override ignored` on every start | The AgentFactory always passes each agent its own `agents_config.yaml` section as `config`; the agent warned on any non-empty value | **Fixed, not verifiable here.** Warns only for keys whose values differ from what the agent loads, and names them. (Syntax-checked; the agent needs torch.) |
| 8 | `Missing src.utils.helpers.response_quality` | Module absent | **Fixed and tested** (five functions, `tests/test_gangup_integration_regressions.py`). |
| 9 | EvaluationAgent PostgreSQL retries then non-persistent fallback | PostgreSQL optional and not running; 3 attempts (1 s + 2 s) before falling back | **No code change.** The fallback is reported correctly; set `evaluation_agent.issue_database_retries: 1` or provide a database in SLAI's configuration. A persistent local issue store is **open** (would be a new SLAI feature). |
| 10 | `knowledge_cache` ephemeral-key warning on every start | A warning for a normal configuration | **Fixed.** Info when the key is ephemeral by choice; warning only when `require_persistent_key` is set. |
| 11 | Safety blocking / degraded guard | Real agent returns `block` for every game order set | **Unchanged (documented).** Advisory by default, `--safety-enforce` opt-in with an auto-release after 5 blocks; reasons reported. |
| 12 | `Permission denied: .../checkpoints_manifest.json` (log line 5698) | A file the process cannot write in the SLAI tree | **Open**, environment (Windows file permissions); not investigated further. |
| 13 | Repeated representation construction; warm-up times | PerceptionAgent / SafetyAgent first-call cost | **Open / not measurable here.** Warm-up exists (parallel, measured); the real agents' latencies need torch. |

## Persistent continuous learning

Implemented as `slai/learner.py` on SLAI's existing external-learning service (details and guarantees: `docs/SLAI.md`, "Persistent policy learning"). Covered by 17 tests in `tests_py/test_learner.py` that use SLAI's real learner:
episode ids, legal masks, executed-vs-chosen (override not credited), terminated / truncated / aborted, idempotency (also after restart), atomic hashed checkpoints, restore, the updated policy serving the next decision (a task with a known
best move is learned through the adapter), evaluation never training, schema identity, and the full cycle through the orchestrator (decide → match end → update → checkpoint → restart → decide).
Whether it makes the AI play better was measured separately: **no improvement was demonstrated** (`docs/LEARNING_EVALUATION.md`).

## Performance

In-process decision latency, lite agents, 2000 varied observations after a 100-decision warm-up, two-core sandbox (`tools/latency_bench.py`; the "before" row runs the same script on the previous commit in a git worktree):

| configuration | n | p50 ms | p95 ms | p99 ms | mean ms | max ms |
|---|---|---|---|---|---|---|
| imitation (learning off) - before (previous commit) | 2000 | 0.207 | 0.299 | 0.36 | 0.215 | 0.798 |
| imitation (learning off) - after | 2000 | 0.206 | 0.295 | 0.345 | 0.214 | 0.416 |
| learning=train (sampling + recording) - after | 2000 | 0.666 | 1.189 | 1.502 | 0.737 | 8.894 |
| learning=evaluate (greedy, restored) - after | 2000 | 0.543 | 0.718 | 0.99 | 0.54 | 1.343 |

The imitation path is unchanged. Learning adds about 0.3-0.5 ms at p50 (sampling, masks, recording). The real agents' latencies could not be measured here. No profile of the real agents was possible, so no real-agent optimisation was attempted;
only start-up behaviour that was visible in the log was addressed (re-checking readiness, repeated warnings, the Knowledge breaker opening on the first call).

## Test evidence (this sandbox)

* GangUP Python: 132 tests pass (105 before the knowledge-store, learner and ladder tests were added: +9, +17, +1; the pre-existing suite was 100 tests at the start of this work). Command: `SLAI_ROOT=<slai> python -m unittest discover -s tests_py -t .`. Tests needing a SLAI checkout skip themselves when none is found.
* GangUP TypeScript: 57 tests pass (56 before, +1 truncated-match reporting); `tsc --noEmit` clean; `dist/js/ai/director.js` rebuilt.
* SLAI: `tests/test_gangup_integration_regressions.py` + `tests/learning/test_external_persistence.py`: 22 passed, 1 skipped (torch); all of `tests/learning`: 78 passed. `tests/knowledge_assurance` and some `tests/agents` do not collect in the sandbox (statsmodels / package-relative imports) - not caused by these changes, not run.
* Learning experiment: `docs/LEARNING_EVALUATION.md`.

## Not verified here

Real PerceptionAgent, LearningAgent, PlanningAgent, SafetyAgent, EvaluationAgent behaviour with these changes; the full import of the knowledge package; the SafetyAgent warning change; PostgreSQL; any Windows-specific behaviour (paths, console encodings, signals - on Windows the service flushes on Ctrl+C/SIGINT, SIGTERM semantics differ).
