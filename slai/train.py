"""Offline training for the TacticalDecisionPolicy (GDD 13.3).

Regime (as specified by the GDD): log (observation, action, outcome) tuples from seeded self-play under a fixed schema,
split train/validation/holdout *by match seed* to avoid leakage, train offline with supervised imitation + ranking, and
weight samples by match outcome so winning decisions are emphasised. Offline RL / self-play improvement is explicitly
deferred until clean legal-action interfaces and reproducible baselines exist.

  python3 -m slai.train --data data/selfplay.jsonl --out slai/data/weights.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time

from .agents.perception import build_situation
from .features import MAIN_FEATURES, MAIN_OBJECTIVES, SQUAD_FEATURES, SQUAD_OBJECTIVES, main_features, squad_features
from .policy import DATA_DIR, Head, TacticalDecisionPolicy, softmax
from .scripted import scripted_main_objective, scripted_squad_objective

OUTCOME_WEIGHT = {"win": 1.0, "draw": 0.7, "loss": 0.5}


def load_terrain(path: str | None = None) -> dict:
    with open(path or os.path.join(DATA_DIR, "terrain.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def restore_terrain(obs: dict, terrain: dict) -> dict:
    t = obs.get("terrain", {})
    if "obstacles" in t:
        return obs
    team = obs["team"]
    obs["terrain"] = {
        "width": terrain["width"], "height": terrain["height"], "obstacles": terrain["obstacles"], "supply": terrain["supply"],
        "zone": terrain["zones"][team], "enemyZone": terrain["zones"][1 - team],
    }
    return obs


def outcome_of(rec: dict) -> str:
    w = rec.get("winner")
    if w is None:
        return "draw"
    return "win" if w == rec["team"] else "loss"


def build_samples(paths: list[str], terrain: dict, max_per_file: int | None = None):
    """Yield (seed, squad_x, squad_y, main_x, main_y, weight) records grouped per observation."""
    for path in paths:
        n = 0
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                rec = json.loads(line)
                obs = restore_terrain(rec["obs"], terrain)
                sit = build_situation(obs)
                w = OUTCOME_WEIGHT[outcome_of(rec)]
                squads = []
                for sq in obs["squads"]:
                    if sq["members"]:
                        squads.append((squad_features(obs, sit, sq), SQUAD_OBJECTIVES.index(scripted_squad_objective(obs, sit, sq))))
                main = (main_features(obs, sit), MAIN_OBJECTIVES.index(scripted_main_objective(obs, sit)))
                yield rec["seed"], squads, main, w
                n += 1
                if max_per_file and n >= max_per_file:
                    break


def fit_head(head: Head, X: list, Y: list, W: list, epochs: int, lr: float, l2: float, rng: random.Random, log=print, name="head") -> None:
    objs = head.objectives
    idx = list(range(len(X)))
    for ep in range(epochs):
        rng.shuffle(idx)
        cur_lr = lr / (1.0 + 0.08 * ep)
        loss = 0.0
        for i in idx:
            x, y, w = X[i], Y[i], W[i]
            scores = head.scores(x)
            p = softmax([scores[o] for o in objs])
            loss += -w * math.log(max(1e-9, p[y]))
            for k, o in enumerate(objs):
                g = (p[k] - (1.0 if k == y else 0.0)) * w * cur_lr
                if g == 0.0:
                    continue
                row = head.W[o]
                for j, xj in enumerate(x):
                    row[j] -= g * xj + cur_lr * l2 * row[j]
                head.b[o] -= g
        if ep % 5 == 0 or ep == epochs - 1:
            log(f"  [{name}] epoch {ep + 1}/{epochs} loss {loss / max(1, len(X)):.4f}")


def accuracy(head: Head, X: list, Y: list) -> float:
    if not X:
        return float("nan")
    ok = 0
    objs = head.objectives
    for x, y in zip(X, Y):
        s = head.scores(x)
        if max(objs, key=lambda o: s[o]) == objs[y]:
            ok += 1
    return ok / len(X)


def train(paths: list[str], out: str, epochs: int = 25, lr: float = 0.25, l2: float = 1e-4, holdout: float = 0.2,
          seed: int = 7, max_per_file: int | None = None, log=print) -> dict:
    terrain = load_terrain()
    rng = random.Random(seed)
    by_seed: dict = {}
    for s, squads, main, w in build_samples(paths, terrain, max_per_file):
        by_seed.setdefault(s, []).append((squads, main, w))
    seeds = sorted(by_seed)
    if len(seeds) < 2:
        raise SystemExit("need logs from at least 2 distinct match seeds to split train/holdout without leakage")
    rng.shuffle(seeds)
    n_hold = max(1, int(len(seeds) * holdout))
    hold, tr = set(seeds[:n_hold]), seeds[n_hold:]
    log(f"matches: {len(seeds)} (train {len(tr)}, holdout {len(hold)})")

    def collect(sel):
        sx, sy, sw, mx, my, mw = [], [], [], [], [], []
        for s in sel:
            for squads, main, w in by_seed[s]:
                for x, y in squads:
                    sx.append(x); sy.append(y); sw.append(w)
                mx.append(main[0]); my.append(main[1]); mw.append(w)
        return sx, sy, sw, mx, my, mw

    trs = collect(tr)
    hos = collect(sorted(hold))
    log(f"samples: squad {len(trs[0])}/{len(hos[0])}  main {len(trs[3])}/{len(hos[3])}  (train/holdout)")
    pol = TacticalDecisionPolicy()
    t0 = time.time()
    fit_head(pol.squad, trs[0], trs[1], trs[2], epochs, lr, l2, rng, log, "squad")
    fit_head(pol.main, trs[3], trs[4], trs[5], epochs, lr, l2, rng, log, "main")
    acc = {
        "squad_train": accuracy(pol.squad, trs[0], trs[1]), "squad_holdout": accuracy(pol.squad, hos[0], hos[1]),
        "main_train": accuracy(pol.main, trs[3], trs[4]), "main_holdout": accuracy(pol.main, hos[3], hos[4]),
    }
    log("accuracy: " + ", ".join(f"{k}={v:.3f}" for k, v in acc.items()))
    pol.trained = True
    pol.version = time.strftime("%Y%m%d-%H%M")
    pol.meta = {"samples": {"squad": len(trs[0]), "main": len(trs[3])}, "matches": len(seeds), "holdoutMatches": len(hold),
                "accuracy": acc, "epochs": epochs, "method": "supervised imitation of scripted objectives, outcome-weighted",
                "trainSeconds": round(time.time() - t0, 1)}
    pol.save(out)
    log(f"saved {out} (version {pol.version})")
    return pol.meta


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Train the SLAI TacticalDecisionPolicy from self-play logs")
    ap.add_argument("--data", nargs="+", required=True, help="JSONL logs produced by src/tools/headless.ts --log")
    ap.add_argument("--out", default=os.path.join(DATA_DIR, "weights.json"))
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--lr", type=float, default=0.25)
    ap.add_argument("--max-per-file", type=int, default=None)
    a = ap.parse_args(argv)
    train(a.data, a.out, a.epochs, a.lr, max_per_file=a.max_per_file)


if __name__ == "__main__":
    main()
