"""Perception agent: summarise the *authorised* observation into a tactical situation with confidence.

It never sees anything the engine did not put in the observation: current sightings, <=3 s last-known records,
own state and static terrain (GDD 6, 13.4).
"""
from __future__ import annotations

import math

from ..geometry import clamp, dist
from .base import Agent, Context


def lane_openness(terrain: dict, y_lo: float, y_hi: float) -> float:
    """Fraction of a horizontal lane band that is free of cover (rough measure of how open a flank is)."""
    w = terrain["width"]
    blocked = 0.0
    for r in terrain["obstacles"]:
        oy = max(0.0, min(y_hi, r["y1"]) - max(y_lo, r["y0"]))
        if oy > 0:
            blocked += (r["x1"] - r["x0"]) * oy
    return 1.0 - clamp(blocked / (w * (y_hi - y_lo)), 0.0, 1.0)


def build_situation(obs: dict) -> dict:
    me = obs["own"]["main"]
    team = obs["team"]
    direction = 1 if team == 0 else -1
    en = obs["enemies"]
    vis = en["visible"]
    lk = en["lastKnown"]
    enemy_main = next((e for e in vis if e.get("kind") == "main"), None)
    vis_soldiers = [e for e in vis if e.get("kind") == "soldier"]
    nearest = min(vis, key=lambda e: dist(e, me)) if vis else None
    lk_nearest = min(lk, key=lambda e: dist(e, me)) if lk else None
    threats_near = sum(1 for e in vis if dist(e, me) <= 14)
    threats_close = sum(1 for e in vis if dist(e, me) <= 18)
    own_n = obs["own"]["soldierCount"]
    hp_frac = me["hp"] / 100.0
    focus = enemy_main if enemy_main is not None and dist(enemy_main, me) <= 20 else nearest
    centroid = None
    if vis_soldiers:
        centroid = {"x": sum(e["x"] for e in vis_soldiers) / len(vis_soldiers), "y": sum(e["y"] for e in vis_soldiers) / len(vis_soldiers)}
    own_strength = sum(s["hp"] / 30.0 for s in obs["own"]["soldiers"]) + hp_frac * 3.0
    enemy_strength = sum(e["hp"] / 30.0 for e in vis_soldiers) + ((enemy_main["hp"] / 100.0) * 3.0 if enemy_main else 0.0)
    ratio = own_strength / (own_strength + enemy_strength + 1e-6) if (vis or own_strength) else 0.5
    if vis:
        info_conf = 1.0
    elif lk:
        info_conf = max(0.0, 1.0 - min(e["age"] for e in lk) / 3.0)
    else:
        info_conf = 0.0
    terr = obs["terrain"]
    h = terr["height"]
    north = lane_openness(terr, 4, h * 0.3)
    south = lane_openness(terr, h * 0.7, h - 4)
    unassigned_pool = [s["id"] for s in obs["own"]["soldiers"] if s["squad"] == 0 and not s["guard"]]
    return {
        "team": team,
        "dir": direction,
        "me": me,
        "hp_frac": hp_frac,
        "enemy_main": enemy_main,
        "vis_soldiers": vis_soldiers,
        "visible_count": len(vis),
        "nearest": nearest,
        "focus": focus,
        "lk_nearest": lk_nearest,
        "threats_near": threats_near,
        "threats_close": threats_close,
        "own_n": own_n,
        "own_strength": own_strength,
        "enemy_strength": enemy_strength,
        "ratio": ratio,
        "info_conf": info_conf,
        "enemy_centroid": centroid,
        "lane_open": {"north": north, "south": south},
        "pool": unassigned_pool,
        "pickup": obs["resources"]["pickup"],
        "wave_in": obs["resources"]["nextWaveIn"],
        "zone": obs["terrain"]["zone"],
        "danger": (hp_frac < 0.35 and threats_close > 0) or (threats_near >= 3 and threats_near > own_n * 1.3),
    }


class PerceptionAgent(Agent):
    name = "perception"

    def run(self, ctx: Context) -> None:
        ctx.situation = build_situation(ctx.obs)
        ctx.confidence = ctx.situation["info_conf"]
        if ctx.situation["visible_count"] == 0 and ctx.situation["lk_nearest"] is None:
            ctx.notes.append("no legitimate enemy information: acting on priors")
