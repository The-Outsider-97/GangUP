"""In-process decision latency of the orchestrator (lite agents): p50 / p95 / p99 over varied observations.

Runs against whichever checkout it is executed in, so the same file measures the previous commit (``git worktree``) and the updated one.
Each configuration is measured after a warm-up; observations vary in squads, enemies and tick so the cache of one shape cannot flatter it.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from tests_py.helpers import make_obs  # noqa: E402
from slai.orchestrator import Orchestrator  # noqa: E402


def observations(n: int, seed: int = 5) -> list[dict]:
    rng = random.Random(seed)
    out = []
    for i in range(n):
        enemies = [{"x": 60 + rng.random() * 30, "y": 15 + rng.random() * 30} for _ in range(rng.randint(0, 9))]
        squads = {1: rng.randint(3, 9), 2: rng.randint(3, 9)}
        if rng.random() < 0.6:
            squads[3] = rng.randint(1, 6)
        o = make_obs(squads=squads, unassigned=rng.randint(0, 6), enemies=enemies,
                     pickup={"x": 50.0, "y": 30.0} if rng.random() < 0.5 else None, tick=600 + 12 * (i % 400), main_hp=rng.choice([100.0, 70.0, 35.0]))
        o["episode"] = f"bench-{i // 400}"
        out.append(o)
    return out


def pct(v: list[float], q: float) -> float:
    v = sorted(v)
    return v[min(len(v) - 1, int(q * len(v)))]


def bench(label: str, orch: Orchestrator, obs: list[dict], warm: int = 100) -> dict:
    for o in obs[:warm]:
        orch.decide(o)
    lat = []
    for o in obs:
        t0 = time.perf_counter()
        orch.decide(o)
        lat.append((time.perf_counter() - t0) * 1000.0)
    return {"config": label, "n": len(lat), "p50_ms": round(pct(lat, 0.5), 3), "p95_ms": round(pct(lat, 0.95), 3), "p99_ms": round(pct(lat, 0.99), 3),
            "mean_ms": round(statistics.fmean(lat), 3), "max_ms": round(max(lat), 3)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=2000)
    ap.add_argument("--slai-root", default=os.environ.get("SLAI_ROOT"))
    ap.add_argument("--state", default=None, help="a trained learner state dir for the evaluate configuration (copied)")
    args = ap.parse_args()
    obs = observations(args.n)
    res = []
    with tempfile.TemporaryDirectory() as d:
        res.append(bench("imitation (learning off)", Orchestrator(adaptive_path=os.path.join(d, "a.json")), obs))
        try:
            import shutil
            o = Orchestrator(adaptive_path=os.path.join(d, "b.json"), learning="train", learning_dir=os.path.join(d, "train"), slai_root=args.slai_root)
            res.append(bench("learning=train (sampling + recording)", o, obs))
            if args.state:
                shutil.copytree(args.state, os.path.join(d, "eval"))
            o2 = Orchestrator(adaptive_path=os.path.join(d, "c.json"), learning="evaluate", learning_dir=os.path.join(d, "eval"), slai_root=args.slai_root)
            res.append(bench("learning=evaluate (greedy, restored)" if args.state else "learning=evaluate (greedy, untrained)", o2, obs))
        except TypeError:
            res.append({"config": "learning modes", "note": "not available in this checkout"})
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
