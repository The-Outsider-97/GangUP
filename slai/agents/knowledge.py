"""Knowledge agent: retrieves validated tactics (and prior-match opponent knowledge) for the current situation."""
from __future__ import annotations

import json
import os

from ..geometry import dist
from .base import Agent, Context

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")


def situation_tags(obs: dict, sit: dict) -> set:
    tags: set = set()
    if sit["visible_count"] > 0 and sit["ratio"] < 0.4:
        tags.add("outnumbered")
    if sit["visible_count"] > 0 and sit["ratio"] > 0.65:
        tags.add("advantage")
    em = sit["enemy_main"]
    if em and not any(dist(em, e) < 8 for e in sit["vis_soldiers"]):
        tags.add("enemy_main_exposed")
    if sit["hp_frac"] < 0.35:
        tags.add("main_low")
    if sit["pickup"]:
        tags.add("supply_open")
    if any(sq["members"] and sq["avgAmmo"] < 6 for sq in obs["squads"]):
        tags.add("low_ammo")
    if sit["visible_count"] == 0 and sit["lk_nearest"] is None:
        tags.add("enemy_unknown")
    return tags


class KnowledgeAgent(Agent):
    name = "knowledge"

    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.path.join(DATA_DIR, "tactics.json")
        self.tactics: list = []
        self.load()

    def load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.tactics = [t for t in data.get("tactics", []) if t.get("validated")]  # only validated entries are used
        except (OSError, json.JSONDecodeError):
            self.tactics = []

    def retrieve(self, tags: set) -> list:
        return [t for t in self.tactics if set(t["when"]) <= tags]

    def run(self, ctx: Context) -> None:
        tags = situation_tags(ctx.obs, ctx.situation)
        ctx.flags["tags"] = sorted(tags)
        ctx.knowledge = self.retrieve(tags)
