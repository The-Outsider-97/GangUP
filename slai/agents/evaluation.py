"""Evaluation / quality agent: outcome attribution and consistency checks for decisions (GDD 12.2).

For each team it keeps the previous snapshot and, one decision later, attributes the change in relative strength and
Main health to the objectives that were active. These per-objective quality statistics feed training logs and the
/v1/stats endpoint; they are diagnostics, not a hidden source of information.
"""
from __future__ import annotations

import threading

from ..schema import episode_key
from .base import Agent, Context


class EvaluationAgent(Agent):
    name = "evaluation"

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.prev: dict = {}
        self.quality: dict = {}  # objective -> {n, mean_delta}
        self.inconsistencies = 0

    def run(self, ctx: Context) -> None:
        obs, sit = ctx.obs, ctx.situation
        key = episode_key(obs)
        snap = {"tick": obs["tick"], "ratio": sit["ratio"], "hp": sit["hp_frac"], "own_n": sit["own_n"], "objs": dict(ctx.objectives)}
        with self.lock:
            prev = self.prev.get(key)
            if prev and obs["tick"] > prev["tick"]:
                delta = (sit["ratio"] - prev["ratio"]) + 0.5 * (sit["hp_frac"] - prev["hp"])
                for obj in set(prev["objs"].values()):
                    q = self.quality.setdefault(obj, {"n": 0, "mean_delta": 0.0})
                    q["n"] += 1
                    q["mean_delta"] += (delta - q["mean_delta"]) / q["n"]
                ctx.flags["quality_delta"] = delta
            self.prev[key] = snap
        # consistency: contradictory orders for one squad in one decision
        per_squad: dict = {}
        for a in ctx.actions:
            if a["command"] in ("MoveSquad", "HoldPosition") and a.get("squad"):
                per_squad.setdefault(a["squad"], set()).add(a["command"])
        for slot, cmds in per_squad.items():
            if len(cmds) > 1:
                self.inconsistencies += 1
                ctx.notes.append(f"squad {slot}: conflicting movement orders")
        for fb in ctx.flags.get("feedback", []):
            ctx.notes.append(f"engine rejected {fb.get('command')}: {fb.get('reason')}")

    def forget(self, key: tuple) -> None:
        with self.lock:
            self.prev.pop(key, None)

    def report(self) -> dict:
        with self.lock:
            return {"quality": {k: dict(v) for k, v in self.quality.items()}, "inconsistencies": self.inconsistencies}
