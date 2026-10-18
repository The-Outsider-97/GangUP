"""Deterministic resolver: (objective, situation) -> minimal list of engine commands.

The learned policy only *ranks* objectives. This module turns an objective into concrete orders using doctrine
constants and terrain knowledge. It only ever targets currently-visible units and legal destinations (GDD 13.1, R10.2).
"""
from __future__ import annotations

import math

from .geometry import clamp, cover_point, dist, nearest_free
from .schema import make_action


def _dest(obs: dict, x: float, y: float) -> dict:
    t = obs["terrain"]
    x = clamp(x, 2.0, t["width"] - 2.0)
    y = clamp(y, 2.0, t["height"] - 2.0)
    fx, fy = nearest_free(t, x, y, 0.8)
    return {"x": round(fx, 2), "y": round(fy, 2)}


def front_limit(obs: dict, sit: dict, x: float) -> float:
    w = obs["terrain"]["width"]
    return min(x, w / 2 - 4) if sit["dir"] == 1 else max(x, w / 2 + 4)


def standoff_point(obs: dict, sit: dict, focus: dict, d: float = 6.0) -> dict:
    me = sit["me"]
    dx, dy = me["x"] - focus["x"], me["y"] - focus["y"]
    n = math.hypot(dx, dy) or 1.0
    return _dest(obs, focus["x"] + dx / n * d, focus["y"] + dy / n * d)


def flank_point(obs: dict, sit: dict, lane: str) -> dict:
    t = obs["terrain"]
    focus = sit["focus"] or sit["lk_nearest"]
    y = 9.0 if lane == "north" else t["height"] - 9.0
    if focus:
        x = focus["x"] - sit["dir"] * 2.0
        y = clamp((focus["y"] + (12.0 if lane == "south" else -12.0)), 8.0, t["height"] - 8.0)
    else:
        x = t["width"] / 2 - sit["dir"] * 10.0
    return _dest(obs, x, y)


def choose_lane(sit: dict, taken: set) -> str:
    """Prefer the flank lane away from the enemy mass and the more open one; avoid lanes another squad uses."""
    focus = sit["focus"] or sit["lk_nearest"]
    h = 60.0
    pref = ["north", "south"]
    if focus:
        pref = ["south", "north"] if focus["y"] < h / 2 else ["north", "south"]
    else:
        pref.sort(key=lambda k: -sit["lane_open"][k])
    for lane in pref:
        if lane not in taken:
            return lane
    return pref[0]


def squad_actions(obs: dict, sit: dict, sq: dict, objective: str, lane: str | None = None, standoff: float = 6.0) -> list[dict]:
    """Emit only the fields that differ from the squad's current orders."""
    slot, me, direction = sq["slot"], sit["me"], sit["dir"]
    out: list[dict] = []
    cen = sq["centroid"] or {"x": me["x"], "y": me["y"]}

    def doctrine(d: str) -> None:
        if sq["doctrine"] != d:
            out.append(make_action("SetDoctrine", obs, squad=slot, doctrine=d))

    def formation(f: str) -> None:
        if sq["formation"] != f:
            out.append(make_action("SetFormation", obs, squad=slot, formation=f))

    def move(dest: dict) -> None:
        cur = sq["move"]
        if cur["kind"] == "Move" and math.hypot(cur["x"] - dest["x"], cur["y"] - dest["y"]) < 3.0:
            return
        out.append(make_action("MoveSquad", obs, squad=slot, destination=dest))

    def target(unit: dict | None) -> None:
        want = unit["id"] if unit else -1
        if unit is None:
            if sq["target"]["kind"] != "none":
                out.append(make_action("SetTarget", obs, squad=slot, target={"kind": "none"}))
        elif sq["target"]["id"] != want:
            out.append(make_action("SetTarget", obs, squad=slot, target={"id": want, "kind": "unit"}))

    focus = sit["focus"]
    if objective == "Disengage":
        zone = sit["zone"]
        out.append(make_action("SetRally", obs, squad=slot, destination={"x": (zone["x0"] + zone["x1"]) / 2, "y": (zone["y0"] + zone["y1"]) / 2}))
        doctrine("Disengage")
        return out
    if objective == "PressTarget":
        if focus:
            dest, tgt = standoff_point(obs, sit, focus, standoff), focus
        elif sit["lk_nearest"]:
            lk = sit["lk_nearest"]
            dest, tgt = _dest(obs, lk["x"], lk["y"]), None  # investigate the frozen position; never auto-track
        else:
            dest, tgt = _dest(obs, obs["terrain"]["width"] / 2 - direction * 12, obs["terrain"]["height"] / 2), None
        doctrine("Press"); formation("Line"); move(dest); target(tgt)
    elif objective == "HarassFlank":
        doctrine("Harass"); formation("Spread"); move(flank_point(obs, sit, lane or "north")); target(None)
    elif objective == "ContestSupply":
        near_enemy = any(dist(cen, e) < 18 for e in obs["enemies"]["visible"])
        doctrine("Press" if near_enemy else "Defend"); formation("Compact")
        pk = sit["pickup"] or obs["terrain"]["supply"]
        move(_dest(obs, pk["x"], pk["y"])); target(None)
    elif objective == "Reposition":
        threat = focus or sit["lk_nearest"]
        spot = cover_point(obs["terrain"], threat, cen) if threat else None
        if spot is None:
            spot = (front_limit(obs, sit, obs["terrain"]["width"] / 2 - direction * 12), obs["terrain"]["height"] / 2 + ((slot % 2) * 2 - 1) * 6)
        doctrine("Defend" if threat else "Press"); formation("Spread"); move(_dest(obs, spot[0], spot[1])); target(None)
    elif objective == "ProtectMain":
        doctrine("Defend"); formation("Compact"); move(_dest(obs, me["x"] + direction * 3, me["y"])); target(None)
    elif objective == "Regroup":
        doctrine("Defend"); formation("Compact"); move(_dest(obs, me["x"] + direction * 4, me["y"] + ((slot % 2) * 2 - 1) * 3)); target(None)
    else:  # Hold: defend in place near the Main
        doctrine("Defend"); formation("Compact")
        if dist(cen, me) > 12:
            move(_dest(obs, me["x"] + direction * 5, me["y"] + ((slot % 2) * 2 - 1) * 4))
        elif sq["move"]["kind"] != "Hold":
            out.append(make_action("HoldPosition", obs, squad=slot))
        target(None)
    return out


def main_actions(obs: dict, sit: dict, objective: str) -> list[dict]:
    me, d = sit["me"], sit["dir"]
    zone = sit["zone"]
    s1 = obs["squads"][0]

    def goal(kind: str, dest: dict, tid: int | None = None) -> dict:
        return make_action("MainGoal", obs, actor=me["id"], goal=kind, destination=dest,
                           target={"id": tid} if tid is not None else None, ttl=240)

    if objective == "Retreat":
        return [goal("Retreat", _dest(obs, clamp(me["x"] - d * 10, zone["x0"] + 1, zone["x1"] - 1), clamp(me["y"], 10, obs["terrain"]["height"] - 10)))]
    if objective == "Resupply" and sit["pickup"]:
        return [goal("Resupply", _dest(obs, sit["pickup"]["x"], sit["pickup"]["y"]))]
    if objective == "Engage":
        em = sit["enemy_main"]
        soldiers = sorted((e for e in sit["vis_soldiers"] if dist(e, me) <= 16), key=lambda e: dist(e, me))
        duel_ok = bool(em) and me["hp"] >= em["hp"] - 10 and sit["hp_frac"] >= 0.4
        tgt = em if (em and (dist(em, me) <= 12 or duel_ok)) else (soldiers[0] if soldiers else sit["focus"])
        if tgt:
            return [goal("Engage", _dest(obs, tgt["x"], tgt["y"]), tgt["id"])]
    if objective in ("MoveTo", "HoldNear") and s1["centroid"] and s1["members"]:
        return [goal("MoveTo", _dest(obs, front_limit(obs, sit, s1["centroid"]["x"] - d * 8), s1["centroid"]["y"]))]
    return [goal("HoldNear", _dest(obs, (zone["x0"] + zone["x1"]) / 2 + d * 8, obs["terrain"]["height"] / 2))]
