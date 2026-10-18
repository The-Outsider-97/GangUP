"""Learning / Adaptive agent.

* online:  builds an opponent model from legitimate sightings during the match (bounded EMA statistics) and turns it
           into small, bounded score biases for the policy;
* offline: after a match, a reward-weighted step nudges persistent per-objective biases (win => reinforce the mix of
           objectives used, loss => move away from it). Both are clipped, so adaptation can never dominate the policy.
"""
from __future__ import annotations

import json
import os
import threading

from ..features import MAIN_OBJECTIVES, SQUAD_OBJECTIVES
from ..geometry import dist
from .base import Agent, Context

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
CLIP = 0.5


def _clip(v: float, lim: float = CLIP) -> float:
    return max(-lim, min(lim, v))


class LearningAgent(Agent):
    name = "learning"

    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.path.join(DATA_DIR, "adaptive.json")
        self.lock = threading.Lock()
        self.profile = {"squad_bias": {o: 0.0 for o in SQUAD_OBJECTIVES}, "main_bias": {o: 0.0 for o in MAIN_OBJECTIVES},
                        "matches": 0, "wins": 0, "losses": 0, "draws": 0}
        self.live: dict = {}  # (seed, team) -> online stats
        self.usage: dict = {}  # (seed, team) -> objective counts this match
        self.load()

    # ------------------------------------------------------------------ persistence
    def load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                d = json.load(f)
            for k in ("squad_bias", "main_bias"):
                for o, v in d.get(k, {}).items():
                    if o in self.profile[k]:
                        self.profile[k][o] = _clip(float(v))
            for k in ("matches", "wins", "losses", "draws"):
                self.profile[k] = int(d.get(k, 0))
        except (OSError, ValueError, json.JSONDecodeError):
            pass

    def save(self) -> None:
        try:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.profile, f, indent=1)
            os.replace(tmp, self.path)
        except OSError:
            pass  # persistence is best-effort; the service keeps running with in-memory adaptation

    # ------------------------------------------------------------------ online opponent model
    def observe(self, obs: dict, sit: dict) -> dict:
        key = (obs["seed"], obs["team"])
        st = self.live.setdefault(key, {"main_exposed": 0.0, "flank": 0.0, "turtle": 0.0, "n": 0})
        a = 0.15
        em = sit["enemy_main"]
        exposed = 1.0 if (em and not any(dist(em, e) < 8 for e in sit["vis_soldiers"])) else 0.0
        if em or st["n"] == 0:
            st["main_exposed"] += a * (exposed - st["main_exposed"])
        if sit["vis_soldiers"]:
            mid = obs["terrain"]["height"] / 2
            far = sum(1 for e in sit["vis_soldiers"] if abs(e["y"] - mid) > 14) / len(sit["vis_soldiers"])
            st["flank"] += a * (far - st["flank"])
        late = obs["time"] > 90
        st["turtle"] += a * ((1.0 if (late and sit["visible_count"] == 0) else 0.0) - st["turtle"])
        st["n"] += 1
        return st

    def bias(self, obs: dict) -> dict:
        key = (obs["seed"], obs["team"])
        st = self.live.get(key, {"main_exposed": 0.0, "flank": 0.0, "turtle": 0.0})
        sb = dict(self.profile["squad_bias"])
        mb = dict(self.profile["main_bias"])
        if st["main_exposed"] > 0.35:
            sb["PressTarget"] += 0.3 * st["main_exposed"]
            sb["HarassFlank"] += 0.25 * st["main_exposed"]
            mb["Engage"] += 0.2 * st["main_exposed"]
        if st["flank"] > 0.4:
            sb["Reposition"] += 0.3 * st["flank"]
            sb["Hold"] += 0.15 * st["flank"]
        if st["turtle"] > 0.5:
            sb["ContestSupply"] += 0.35 * st["turtle"]
            sb["Reposition"] += 0.1
        for d in (sb, mb):
            for k in d:
                d[k] = _clip(d[k])
        return {"squad": sb, "main": mb}

    def note_usage(self, obs: dict, objectives: dict) -> None:
        key = (obs["seed"], obs["team"])
        u = self.usage.setdefault(key, {})
        for obj in objectives.values():
            u[obj] = u.get(obj, 0) + 1

    # ------------------------------------------------------------------ post-match learning
    def update_from_match(self, seed: int, team: int, winner: int | None, lr: float = 0.08) -> dict:
        with self.lock:
            key = (seed, team)
            usage = self.usage.pop(key, {})
            self.live.pop(key, None)
            reward = 0.0 if winner is None else (1.0 if winner == team else -1.0)
            total = sum(usage.values()) or 1
            mean = 1.0 / len(SQUAD_OBJECTIVES)
            for o in SQUAD_OBJECTIVES:
                share = usage.get(o, 0) / total
                self.profile["squad_bias"][o] = _clip(self.profile["squad_bias"][o] + lr * reward * (share - mean))
            self.profile["matches"] += 1
            if winner is None:
                self.profile["draws"] += 1
            elif winner == team:
                self.profile["wins"] += 1
            else:
                self.profile["losses"] += 1
            self.save()
            return {"reward": reward, "matches": self.profile["matches"]}

    def run(self, ctx: Context) -> None:
        self.observe(ctx.obs, ctx.situation)
        ctx.flags["bias"] = self.bias(ctx.obs)
