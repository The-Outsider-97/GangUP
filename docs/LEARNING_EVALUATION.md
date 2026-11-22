# Learning evaluation

What was measured, how, and what it does and does not show. Every number below is rendered by `tools/learning_report.py` from `docs/learning_experiment_report.json`, which `tools/learning_experiment.py`
wrote from real matches of the TypeScript engine (`src/tools/headless.ts`) against a `python -m slai.server --agents lite` process. Nothing is simulated or hand-typed.

## Verdict

**No improvement was demonstrated, and the promotion gate correctly rolled the candidate back.** After 200 training games per configuration the learned policies score slightly above the imitation policy against the scripted
opponent (validation +0.04 / +0.07, test +0.06 in score per seed), but every confidence interval contains 0, no sign test is significant, and in the head-to-head the candidate scored *below* the imitation policy (0.39, vs even -0.11,
also not significant). The honest reading is "no detectable difference at this sample size", not "it learns to win" and not "it got worse". Production stays the imitation policy (`--learning off`, the default).

What **is** established is the machinery: the full cycle runs on real engine games, parameters really change, checkpoints restore bit-identically in a fresh process, evaluation cannot train, and the gate rejects what it cannot demonstrate.

## Protocol

* Opponent: the engine's scripted baseline director, `hard`. Own service per arm; learner state per candidate.
* Seeds: training 100000+ (never reused for evaluation), validation 20000-20023 (selection and gate), test 30000-30039 (touched once, after the candidate was chosen), head-to-head 31000-31019.
* Design: every seed is played on **both** sides; the two games of a seed are one paired observation (mirrored sides, paired by seed). Statistics: Wilson intervals for rates, bootstrap (20 000 resamples of seeds) for paired differences, exact two-sided sign test on non-tied seeds.
* Arms: *imitation* = previous production (`--learning off`); *untrained* = learner in evaluate mode on an empty state directory (a control: it must equal imitation exactly); *candidate* = learner in evaluate mode restored from the trained checkpoint **in a fresh process**.
* Candidates: two hyper-parameter configurations (`temperature` 3 / `learning_rate` 4 and `temperature` 2 / `learning_rate` 10, both `max_param_norm` 8, batch 4 episodes, shaping 0.3), chosen after a 100-game pilot (temperature 4, learning rate 0.5) whose parameter steps were only about 0.003-0.01 per update and whose score did not change. Selection used validation seeds only; the test seeds were touched once.
* Gate: promote only if the lower 95 % bound of the validation improvement is above 0; otherwise roll back to the previous production policy.
* Training scores are sampled-action scores of a changing policy; they are shown for the curve only and are **not** an evaluation.

Seeds: train 100000+, validation 20000..20023, test 30000..30039. Design: each seed on both sides (mirrored); paired by seed. Gate: lower 95 % bound of validation improvement > 0.0. Training games per config: 200.

### Training

| config | hyper-parameters | games | optimizer steps (squad / main) | episodes consumed | last-20 training score (first → last) |
|---|---|---|---|---|---|
| c1-T3-lr4 | `{"temperature": 3.0, "learning_rate": 4.0, "max_param_norm": 8.0, "gamma": 0.999}` | 200 | 50 / 50 | 200 | 0.20 → 0.30 (sampled actions; not an evaluation) |
| c2-T2-lr10 | `{"temperature": 2.0, "learning_rate": 10.0, "max_param_norm": 8.0, "gamma": 0.999}` | 200 | 50 / 50 | 200 | 0.17 → 0.47 (sampled actions; not an evaluation) |

### Validation (selection; held-out seeds, learner frozen)

* imitation (previous production): 17W / 25L / 6D of 48 - score 0.417 (Wilson 95 % [0.288, 0.557])
* untrained learner in evaluate mode: 17W / 25L / 6D of 48 - score 0.417 (Wilson 95 % [0.288, 0.557]); identical to imitation game for game: **True**; state unchanged by evaluation: **True**

| candidate | score | improvement vs imitation (paired by seed) | evaluation changed no parameters |
|---|---|---|---|
| c1-T3-lr4 | 20W / 24L / 4D of 48 - score 0.458 (Wilson 95 % [0.326, 0.597]) | +0.042 (bootstrap 95 % [-0.125, +0.198]; 11 seeds better / 6 worse / 7 tied; sign test p = 0.332) | True |
| c2-T2-lr10 | 22W / 23L / 3D of 48 - score 0.490 (Wilson 95 % [0.354, 0.626]) | +0.073 (bootstrap 95 % [-0.115, +0.250]; 10 seeds better / 6 worse / 8 tied; sign test p = 0.454) | True |

### Promotion decision

* selected (best validation mean): **c2-T2-lr10**; gate: lower 95% bound > 0.0
* validation improvement: +0.073 (bootstrap 95 % [-0.115, +0.250]; 10 seeds better / 6 worse / 8 tied; sign test p = 0.454)
* **ROLLED BACK: production stays the imitation policy (previous production)**

### Test seeds (touched once, after selection; candidate restored in a fresh process)

* imitation: 32W / 40L / 8D of 80 - score 0.450 (Wilson 95 % [0.346, 0.559])
* candidate: 38W / 36L / 6D of 80 - score 0.512 (Wilson 95 % [0.405, 0.619])
* candidate − imitation: +0.062 (bootstrap 95 % [-0.087, +0.206]; 17 seeds better / 13 worse / 10 tied; sign test p = 0.585)
* evaluation changed no parameters / no optimizer step: **True**; restored heads: `{"squad": {"hash": "b96175812ded1378", "step": 50, "consumed": 200}, "main": {"hash": "c887aa0c3118ac35", "step": 50, "consumed": 200}, "optimizerSteps": 0, "checkpointsRestored": 2}`
* restore determinism (two independent restores, 8 seeds × both sides): identical games = **True**

### Head to head (candidate vs imitation policy, each seed on both sides)

* 40 games: candidate 11 W / 20 L / 9 D - score 0.388 (Wilson 95 % [0.253, 0.542]); vs even: -0.113 (bootstrap 95 % [-0.250, +0.025]; 4 seeds better / 10 worse / 6 tied; sign test p = 0.180)


## Integrity checks that passed

* The untrained evaluate-mode learner reproduces the imitation policy game for game (same winners, reasons, durations, kills): the learner adds nothing until it has been trained.
* Evaluation changed nothing: parameter hash, training step and consumed episodes were identical before and after every evaluation arm; zero optimizer steps.
* Restoring the checkpoint in two independent processes replays identical games.
* No fallback decisions in the test arms (all decisions were answered by the service).

## What this does not show, and limits

* **Power.** 40 seeds (80 games) detect only large differences: the half-width of the 95 % interval on the test difference is about 0.15. An improvement of a few percentage points - what 200 games of REINFORCE on a near-deterministic prior could plausibly give - is invisible here. More training and many more evaluation games are the way to learn more; the harness takes `--train-games`, `--val-seeds`, `--test-seeds`.
* **Opponent.** Everything is against one scripted opponent. A policy that improves against it could be exploiting it; the head-to-head against the imitation policy is the first step away from that, and it did not favour the candidate.
* **Two configurations, one selection step.** Picking the better of two on validation inflates the validation estimate slightly; the test estimate is unaffected by that choice.
* **Reproducibility.** The engine and service are deterministic given the seed (the restore check shows it); training depends on the sampler seed (`--learning-seed`, 1 here) and on game order. Re-running with the same seeds should reproduce these numbers on the same code; this was run once.
* **Lite agents.** All games used the built-in lite agents. The real SLAI agents could not be loaded in the build sandbox (no torch); how the learner interacts with them in play is verified only by the bridge's contract tests.
* **Not a guarantee.** Online learning is not guaranteed to improve any individual game, and nothing here says it will.

## Reproduce

```powershell
cd G:\GAIA\AI\SLAI\applications\GangUP
$env:SLAI_ROOT = "G:\GAIA\AI\SLAI"
python tools\learning_experiment.py --out .\experiment --slai-root $env:SLAI_ROOT `
  --configs '[{"name":"c1-T3-lr4","hyper":{"temperature":3.0,"learning_rate":4.0,"max_param_norm":8.0,"gamma":0.999}},{"name":"c2-T2-lr10","hyper":{"temperature":2.0,"learning_rate":10.0,"max_param_norm":8.0,"gamma":0.999}}]' `
  --train-games 200 --val-seeds 24 --test-seeds 40
python tools\learning_report.py .\experiment\report.json
```

Two cores took about 22 minutes for this configuration. Add `--skip-test` to stop after selection and the gate.
