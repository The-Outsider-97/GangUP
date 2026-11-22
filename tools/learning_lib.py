"""Shared helpers for the learning experiments and benchmarks: run the real service and the real engine, summarise with uncertainty.

Nothing here simulates a result: games are played by ``src/tools/headless.ts`` (the authoritative TypeScript engine) against a
``python -m slai.server`` subprocess, and every number is computed from the per-match JSON lines that run wrote.
"""
from __future__ import annotations

import json
import math
import os
import random
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Service:
    """A ``slai.server`` subprocess (lite agents unless told otherwise) with its own learner state directory."""

    def __init__(self, port: int, learning: str = "off", state_dir: str | None = None, adaptive: str | None = None, hyper: dict | None = None,
                 batch: int = 4, shaping: float = 0.3, seed: int = 0, agents: str = "lite", env: dict | None = None, log: str | None = None) -> None:
        self.port, self.url = port, f"http://127.0.0.1:{port}"
        cmd = [sys.executable, "-m", "slai.server", "--agents", agents, "--port", str(port), "--quiet", "--learning", learning]
        if state_dir:
            cmd += ["--learning-dir", state_dir]
        if adaptive:
            cmd += ["--adaptive", adaptive]
        if hyper:
            cmd += ["--learning-hyper", json.dumps(hyper)]
        cmd += ["--learning-batch", str(batch), "--learning-shaping", str(shaping), "--learning-seed", str(seed)]
        self.log = open(log or os.devnull, "ab")
        self.proc = subprocess.Popen(cmd, cwd=ROOT, env={**os.environ, **(env or {})}, stdout=self.log, stderr=self.log)
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                self.get("/v1/health")
                return
            except Exception:  # noqa: BLE001
                if self.proc.poll() is not None:
                    raise RuntimeError(f"service exited early (code {self.proc.returncode}); see log")
                time.sleep(0.3)
        raise RuntimeError("service did not start")

    def get(self, path: str) -> dict:
        with urllib.request.urlopen(self.url + path, timeout=10) as r:
            return json.loads(r.read())

    def stop(self, graceful: bool = True) -> None:
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM if graceful else signal.SIGKILL)  # SIGTERM runs the server's shutdown (flush + checkpoint)
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.log.close()


def play(mode: str, n: int, seed0: int, url: str | None = None, out: str | None = None, urls: tuple[str, str] | None = None,
         difficulty: str = "hard", max_sec: int = 300, learn: bool = True, slai_team: int = 1) -> list[dict]:
    """Run ``n`` real engine matches; returns one summary dict per match (also appended to ``out`` as JSON lines)."""
    out = out or os.path.join("/tmp", f"play-{os.getpid()}-{time.time_ns()}.jsonl")
    cmd = ["tsx", "src/tools/headless.ts", "--matches", str(n), "--seed", str(seed0), "--mode", mode, "--difficulty", difficulty,
           "--max-sec", str(max_sec), "--json", out, "--slai-team", str(slai_team)]
    if url:
        cmd += ["--url", url]
    if urls:
        cmd += ["--url-green", urls[0], "--url-red", urls[1]]
    if not learn:
        cmd += ["--no-learn"]
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"headless failed: {r.stderr[-600:]}")
    with open(out) as f:
        rows = [json.loads(line) for line in f if line.strip()]
    return rows[-n:]


def score(row: dict, team: int) -> float:
    """Outcome for ``team``: win 1, draw/timeout 0.5, loss 0."""
    if row.get("timedOut") or row.get("winner") is None:
        return 0.5
    return 1.0 if row["winner"] == team else 0.0


def slai_score(row: dict) -> float:
    return score(row, row["slaiTeam"])


# ---------------------------------------------------------------------------------------------- statistics
def wilson(k: float, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def per_seed(rows: list[dict], fn=slai_score) -> dict[int, float]:
    """Mean score per engine seed (the two mirrored games of a seed are one paired observation)."""
    acc: dict[int, list[float]] = {}
    for r in rows:
        acc.setdefault(r["seed"], []).append(fn(r))
    return {s: sum(v) / len(v) for s, v in acc.items()}


def paired_diff(a: dict[int, float], b: dict[int, float], boot: int = 20000, seed: int = 1) -> dict:
    """b - a over shared seeds with a bootstrap 95% CI (resampling seeds) and an exact two-sided sign test on non-tied seeds."""
    keys = sorted(set(a) & set(b))
    d = [b[k] - a[k] for k in keys]
    n = len(d)
    if n == 0:
        return {"n": 0}
    rng = random.Random(seed)
    means = sorted(sum(d[rng.randrange(n)] for _ in range(n)) / n for _ in range(boot))
    pos, neg = sum(1 for x in d if x > 1e-12), sum(1 for x in d if x < -1e-12)
    m = pos + neg
    p = 1.0 if m == 0 else min(1.0, 2 * sum(math.comb(m, i) for i in range(0, min(pos, neg) + 1)) / 2 ** m)
    return {"n": n, "mean": sum(d) / n, "ci95": [means[int(0.025 * boot)], means[int(0.975 * boot) - 1]], "seedsBetter": pos, "seedsWorse": neg,
            "seedsTied": n - m, "signTestP": p}


def summarize(rows: list[dict], fn=slai_score) -> dict:
    n = len(rows)
    wins = sum(1 for r in rows if fn(r) == 1.0)
    losses = sum(1 for r in rows if fn(r) == 0.0)
    draws = n - wins - losses
    pts = sum(fn(r) for r in rows)
    lo, hi = wilson(pts, n)
    return {"games": n, "wins": wins, "losses": losses, "drawsOrTimeouts": draws, "scoreRate": pts / n if n else None, "scoreRate95": [lo, hi],
            "meanSeconds": sum(r["seconds"] for r in rows) / n if n else None,
            "answeredDecisions": sum(d["answered"] for r in rows for d in r["directors"] if d["team"] == r.get("slaiTeam")),
            "fallbackDecisions": sum(d["fallback"] for r in rows for d in r["directors"] if d["team"] == r.get("slaiTeam"))}


def fresh_dir(path: str) -> str:
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path, exist_ok=True)
    return path
