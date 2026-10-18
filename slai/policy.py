"""TacticalDecisionPolicy (GDD 13.1) — a locally trainable ranking model over *legal* tactical objectives.

Two linear-softmax heads (squad objectives, Main goals) with a legal-action masker. The model produces scores only;
it never predicts or sets damage or positions, and a deterministic resolver (resolver.py) turns the chosen objective
into engine commands. If no weights are available the service uses the scripted policy (documented fallback).
"""
from __future__ import annotations

import json
import math
import os
import random
from dataclasses import dataclass, field

from .features import MAIN_FEATURES, MAIN_OBJECTIVES, SQUAD_FEATURES, SQUAD_OBJECTIVES

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
DEFAULT_WEIGHTS = os.path.join(DATA_DIR, "weights.json")


def softmax(scores: list[float], temperature: float = 1.0) -> list[float]:
    t = max(1e-6, temperature)
    m = max(scores)
    ex = [math.exp((s - m) / t) for s in scores]
    z = sum(ex)
    return [e / z for e in ex]


@dataclass
class Head:
    objectives: tuple
    n_features: int
    W: dict = field(default_factory=dict)  # objective -> list[float]
    b: dict = field(default_factory=dict)  # objective -> float

    def __post_init__(self) -> None:
        for o in self.objectives:
            self.W.setdefault(o, [0.0] * self.n_features)
            self.b.setdefault(o, 0.0)

    def scores(self, x: list[float], bias: dict | None = None) -> dict:
        if len(x) != self.n_features:
            raise ValueError(f"expected {self.n_features} features, got {len(x)}")
        out = {}
        for o in self.objectives:
            w = self.W[o]
            s = self.b[o] + sum(wi * xi for wi, xi in zip(w, x))
            if bias:
                s += bias.get(o, 0.0)
            out[o] = s
        return out

    def to_json(self) -> dict:
        return {"objectives": list(self.objectives), "W": self.W, "b": self.b}

    @staticmethod
    def from_json(d: dict, objectives: tuple, n_features: int) -> "Head":
        if tuple(d["objectives"]) != tuple(objectives):
            raise ValueError("objective set mismatch")
        h = Head(objectives, n_features, {k: list(v) for k, v in d["W"].items()}, dict(d["b"]))
        for o in objectives:
            if len(h.W[o]) != n_features:
                raise ValueError("feature width mismatch")
        return h


class TacticalDecisionPolicy:
    def __init__(self) -> None:
        self.squad = Head(SQUAD_OBJECTIVES, len(SQUAD_FEATURES))
        self.main = Head(MAIN_OBJECTIVES, len(MAIN_FEATURES))
        self.version = "untrained"
        self.trained = False
        self.meta: dict = {}

    # ------------------------------------------------------------------ persistence
    @classmethod
    def load(cls, path: str = DEFAULT_WEIGHTS) -> "TacticalDecisionPolicy":
        p = cls()
        try:
            with open(path, "r", encoding="utf-8") as f:
                d = json.load(f)
            p.squad = Head.from_json(d["squad"], SQUAD_OBJECTIVES, len(SQUAD_FEATURES))
            p.main = Head.from_json(d["main"], MAIN_OBJECTIVES, len(MAIN_FEATURES))
            p.version = d.get("version", "unversioned")
            p.meta = d.get("meta", {})
            p.trained = True
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            p.trained = False  # model load failure => scripted fallback is used by the Planning agent
        return p

    def save(self, path: str = DEFAULT_WEIGHTS) -> None:
        d = {"version": self.version, "squad": self.squad.to_json(), "main": self.main.to_json(), "meta": self.meta,
             "features": {"squad": list(SQUAD_FEATURES), "main": list(MAIN_FEATURES)}}
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=1)

    # ------------------------------------------------------------------ inference
    @staticmethod
    def _choose(scores: dict, legal: set, temperature: float, rng: random.Random | None) -> tuple[str, float]:
        cand = [(o, s) for o, s in scores.items() if o in legal]
        if not cand:
            raise ValueError("no legal objective")
        probs = softmax([s for _, s in cand], 1.0)
        if temperature > 0 and rng is not None:
            probs = softmax([s for _, s in cand], temperature)
            r, acc = rng.random(), 0.0
            for (o, _), p in zip(cand, probs):
                acc += p
                if r <= acc:
                    return o, p
            return cand[-1][0], probs[-1]
        i = max(range(len(cand)), key=lambda k: (cand[k][1], -k))  # deterministic argmax, stable tie-break
        return cand[i][0], probs[i]

    def choose_squad(self, x: list[float], legal: set, bias: dict | None = None, temperature: float = 0.0,
                     rng: random.Random | None = None) -> tuple[str, float, dict]:
        scores = self.squad.scores(x, bias)
        obj, conf = self._choose(scores, legal, temperature, rng)
        return obj, conf, scores

    def choose_main(self, x: list[float], legal: set, bias: dict | None = None, temperature: float = 0.0,
                    rng: random.Random | None = None) -> tuple[str, float, dict]:
        scores = self.main.scores(x, bias)
        obj, conf = self._choose(scores, legal, temperature, rng)
        return obj, conf, scores


def legal_squad_objectives(obs: dict, sit: dict, sq: dict) -> set:
    """Legal-action mask: an objective is legal only if the information and means to execute it exist."""
    legal = {"ProtectMain", "Reposition", "Hold", "Regroup", "Disengage", "HarassFlank"}
    if sit["focus"] or sit["lk_nearest"]:
        legal.add("PressTarget")  # needs a legitimate sighting or a (<=3 s) last-known record to aim at
    if sit["pickup"]:
        legal.add("ContestSupply")
    return legal


def legal_main_objectives(obs: dict, sit: dict) -> set:
    legal = {"HoldNear", "MoveTo", "Retreat"}
    if sit["focus"]:
        legal.add("Engage")
    if sit["pickup"]:
        legal.add("Resupply")
    return legal
