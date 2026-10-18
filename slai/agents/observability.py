"""Observability agent: decision timing, error rates, invalid-action rate and replay linkage (GDD 12.2, 18.4)."""
from __future__ import annotations

import json
import threading
import time
from collections import deque

from .base import Agent, Context


class ObservabilityAgent(Agent):
    name = "observability"

    def __init__(self, telemetry_path: str | None = None) -> None:
        self.lock = threading.Lock()
        self.telemetry_path = telemetry_path
        self.started = time.time()
        self.decisions = 0
        self.errors = 0
        self.agent_errors: dict = {}
        self.deadline_misses = 0
        self.actions_proposed = 0
        self.actions_rejected = 0
        self.engine_rejections: dict = {}
        self.latency = deque(maxlen=500)
        self.agent_ms: dict = {}
        self.recent = deque(maxlen=50)

    def run(self, ctx: Context) -> None:  # recorded explicitly by the orchestrator
        self.record(ctx, 0.0)

    def record(self, ctx: Context, total_ms: float) -> None:
        obs = ctx.obs
        with self.lock:
            self.decisions += 1
            self.latency.append(total_ms)
            for k, v in ctx.timings.items():
                s = self.agent_ms.setdefault(k, {"n": 0, "mean": 0.0, "max": 0.0})
                s["n"] += 1
                s["mean"] += (v - s["mean"]) / s["n"]
                s["max"] = max(s["max"], v)
            for k, e in ctx.errors.items():
                self.agent_errors[k] = self.agent_errors.get(k, 0) + 1
            self.actions_proposed += len(ctx.actions) + len(ctx.flags.get("rejected", []))
            self.actions_rejected += len(ctx.flags.get("rejected", []))
            for fb in ctx.flags.get("feedback", []):
                self.engine_rejections[fb.get("reason", "?")] = self.engine_rejections.get(fb.get("reason", "?"), 0) + 1
            if ctx.time_left() < 0:
                self.deadline_misses += 1
            line = {"seed": obs["seed"], "team": obs["team"], "tick": obs["tick"], "generation": obs["generation"],
                    "ms": round(total_ms, 2), "objectives": ctx.objectives, "main": ctx.main_objective,
                    "actions": len(ctx.actions), "errors": ctx.errors, "fallback": ctx.flags.get("fallback", False)}
            self.recent.append(line)
        if self.telemetry_path:
            try:
                with open(self.telemetry_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(line) + "\n")
            except OSError:
                pass

    def note_error(self) -> None:
        with self.lock:
            self.errors += 1

    def snapshot(self) -> dict:
        with self.lock:
            lat = sorted(self.latency)
            p = lambda q: lat[min(len(lat) - 1, int(q * len(lat)))] if lat else 0.0  # noqa: E731
            return {
                "uptimeSec": round(time.time() - self.started, 1),
                "decisions": self.decisions,
                "errors": self.errors,
                "agentErrors": dict(self.agent_errors),
                "deadlineMisses": self.deadline_misses,
                "actionsProposed": self.actions_proposed,
                "actionsRejectedBySafety": self.actions_rejected,
                "engineRejections": dict(self.engine_rejections),
                "latencyMs": {"p50": round(p(0.5), 2), "p95": round(p(0.95), 2), "max": round(lat[-1], 2) if lat else 0.0},
                "agentMs": {k: {kk: round(vv, 3) if isinstance(vv, float) else vv for kk, vv in v.items()} for k, v in self.agent_ms.items()},
            }
