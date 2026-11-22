"""Render ``docs/LEARNING_EVALUATION.md`` tables from an experiment ``report.json`` (so no number is ever typed by hand)."""
from __future__ import annotations

import json
import sys


def f(x, n=3):
    return "-" if x is None else (f"{x:.{n}f}" if isinstance(x, float) else str(x))


def ci(a):
    return "-" if not a else f"[{a[0]:+.3f}, {a[1]:+.3f}]"


def sc(s):
    return f"{s['wins']}W / {s['losses']}L / {s['drawsOrTimeouts']}D of {s['games']} - score {f(s['scoreRate'])} (Wilson 95 % [{f(s['scoreRate95'][0])}, {f(s['scoreRate95'][1])}])"


def diff(d):
    return f"{d['mean']:+.3f} (bootstrap 95 % {ci(d['ci95'])}; {d['seedsBetter']} seeds better / {d['seedsWorse']} worse / {d['seedsTied']} tied; sign test p = {d['signTestP']:.3f})"


def main(path: str) -> None:
    r = json.load(open(path))
    p = r["protocol"]
    out = [f"Seeds: train {p['trainSeeds']}, validation {p['validationSeeds']}, test {p['testSeeds']}. Design: {p['design']}. Gate: lower 95 % bound of validation improvement > {p['gateLower']}. Training games per config: {p['trainGames']}.", ""]
    out += ["### Training", "", "| config | hyper-parameters | games | optimizer steps (squad / main) | episodes consumed | last-20 training score (first → last) |", "|---|---|---|---|---|---|"]
    for n, t in r["training"].items():
        h = t["heads"]
        out.append(f"| {n} | `{json.dumps(t['config']['hyper'])}` | {t['trainSummary']['games']} | {h['squad']['trainingStep']} / {h['main']['trainingStep']} | {h['squad']['consumedEpisodes']} | "
                   f"{f(t['curve'][0]['scoreRate'], 2)} → {f(t['curve'][-1]['scoreRate'], 2)} (sampled actions; not an evaluation) |")
    v = r["validation"]
    out += ["", "### Validation (selection; held-out seeds, learner frozen)", "", f"* imitation (previous production): {sc(v['imitation'])}",
            f"* untrained learner in evaluate mode: {sc(v['untrained']) if v['untrained'] else '-'}; identical to imitation game for game: **{v['untrainedEqualsImitationGameForGame']}**; state unchanged by evaluation: **{v['untrainedStateUnchanged']}**", ""]
    out += ["| candidate | score | improvement vs imitation (paired by seed) | evaluation changed no parameters |", "|---|---|---|---|"]
    for n, c in v["candidates"].items():
        out.append(f"| {n} | {sc(c['summary'])} | {diff(c['vsImitation'])} | {c['evalDidNotTrain']} |")
    d = r["decision"]
    out += ["", "### Promotion decision", "", f"* selected (best validation mean): **{d.get('selected')}**; gate: {d.get('gate')}", f"* validation improvement: {diff(d['validationImprovement']) if d.get('validationImprovement') else '-'}", f"* **{d['action'] if 'action' in d else d.get('reason')}**"]
    if "test" in r:
        t = r["test"]
        out += ["", "### Test seeds (touched once, after selection; candidate restored in a fresh process)", "", f"* imitation: {sc(t['imitation'])}", f"* candidate: {sc(t['candidateRestoredFreshProcess'])}",
                f"* candidate − imitation: {diff(t['candidateVsImitation'])}", f"* evaluation changed no parameters / no optimizer step: **{t['evalDidNotTrain']}**; restored heads: `{json.dumps(t['candidateHeadsRestored'])}`",
                f"* restore determinism (two independent restores, {r['restoreDeterminism']['seeds']} seeds × both sides): identical games = **{r['restoreDeterminism']['identicalGames']}**"]
        h = r["headToHead"]
        out += ["", "### Head to head (candidate vs imitation policy, each seed on both sides)", "", f"* {h['games']} games: candidate {h['candidateWins']} W / {h['candidateLosses']} L / {h['drawsOrTimeouts']} D - score {f(h['candidateScoreRate'])} (Wilson 95 % [{f(h['candidateScoreRate95'][0])}, {f(h['candidateScoreRate95'][1])}]); vs even: {diff(h['vsEven'])}"]
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1])
