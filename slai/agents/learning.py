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
from ..schema import episode_key
from .base import Agent, Context

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
CLIP = 0.5
MAX_LIVE = 32  # games tracked at once (older, abandoned ones are evicted)
KEEP_EPISODES = 256  # processed episode ids remembered (and persisted) so a retried match_end cannot be learned twice


def _clip(v: float, lim: float = CLIP) -> float:
    return max(-lim, min(lim, v))


class LearningAgent(Agent):
    name = "learning"

    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.path.join(DATA_DIR, "adaptive.json")
        self.lock = threading.Lock()
        self.profile = {"squad_bias": {o: 0.0 for o in SQUAD_OBJECTIVES}, "main_bias": {o: 0.0 for o in MAIN_OBJECTIVES},
                        "matches": 0, "wins": 0, "losses": 0, "draws": 0, "episodes": []}
        self.live: dict = {}  # episode key -> online stats
        self.usage: dict = {}  # episode key -> {"squad": {objective: n}, "main": {objective: n}} for this match
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
            eps = d.get("episodes", [])
            if isinstance(eps, list):
                self.profile["episodes"] = [str(e) for e in eps][-KEEP_EPISODES:]
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
        key = episode_key(obs)
        if key not in self.live and len(self.live) >= MAX_LIVE:
            self.live.pop(next(iter(self.live)))  # abandoned games (quit, timeout) must not accumulate
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
        key = episode_key(obs)
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

    def note_usage(self, obs: dict, objectives: dict, main_objective: str | None = None) -> None:
        key = episode_key(obs)
        if key not in self.usage and len(self.usage) >= MAX_LIVE:
            self.usage.pop(next(iter(self.usage)))
        u = self.usage.setdefault(key, {"squad": {}, "main": {}})
        for obj in objectives.values():
            u["squad"][obj] = u["squad"].get(obj, 0) + 1
        if main_objective:
            u["main"][main_objective] = u["main"].get(main_objective, 0) + 1

    # ------------------------------------------------------------------ post-match learning
    def update_from_match(self, seed: int, team: int, winner: int | None, lr: float = 0.08, episode: str | None = None) -> dict:
        """One reward-weighted step per *episode*. ``episode`` is the client's game id; without it the call is only accepted for a
        game this service actually played (decisions were seen for that seed/team), which is then consumed - so a repeated or
        stray call cannot count a match twice. The result carries ``duplicate`` / ``ignored`` when nothing was learned."""
        with self.lock:
            key = (episode or seed, team)
            reward = 0.0 if winner is None else (1.0 if winner == team else -1.0)
            token = f"{episode}:{team}" if episode else None  # both teams of one episode may be SLAI-controlled
            if token and token in self.profile["episodes"]:
                return {"duplicate": True, "reward": reward, "matches": self.profile["matches"], "episode": episode}
            usage = self.usage.pop(key, None)
            seen = self.live.pop(key, None)
            if not episode and usage is None and seen is None:
                return {"ignored": "no active episode for this seed/team", "reward": reward, "matches": self.profile["matches"]}
            usage = usage or {"squad": {}, "main": {}}
            for head, objs, bias in (("squad", SQUAD_OBJECTIVES, self.profile["squad_bias"]), ("main", MAIN_OBJECTIVES, self.profile["main_bias"])):
                counts = usage[head]
                total = sum(counts.values())
                if not total:
                    continue  # no decisions of this kind: nothing to attribute
                mean = 1.0 / len(objs)
                for o in objs:
                    bias[o] = _clip(bias[o] + lr * reward * (counts.get(o, 0) / total - mean))
            self.profile["matches"] += 1
            if winner is None:
                self.profile["draws"] += 1
            elif winner == team:
                self.profile["wins"] += 1
            else:
                self.profile["losses"] += 1
            if token:
                self.profile["episodes"] = (self.profile["episodes"] + [token])[-KEEP_EPISODES:]
            self.save()
            return {"reward": reward, "matches": self.profile["matches"], "episode": episode, "usage": usage}

    def run(self, ctx: Context) -> None:
        self.observe(ctx.obs, ctx.situation)
        ctx.flags["bias"] = self.bias(ctx.obs)
