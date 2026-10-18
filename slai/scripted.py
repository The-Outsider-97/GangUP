"""Deterministic scripted tactical policy (the documented SLAI fallback, GDD 13.5) and the imitation *labeler*.

Priorities mirror src/ai/scripted.ts: P1 protect Main; P2 organise squads; P3 fix & press visible enemies;
P4 investigate stale last-known records; P5 contest supply; P6 advance. Low-ammo squads disengage to refill.
"""
from __future__ import annotations

from .geometry import dist


def scripted_stance(sit: dict) -> str:
    return "defensive" if sit["danger"] or sit["own_n"] < 5 else "offensive"


def scripted_squad_objective(obs: dict, sit: dict, sq: dict) -> str:
    if not sq["members"]:
        return "Hold"
    if sq["avgAmmo"] < 3:
        return "Disengage"
    if sit["danger"]:
        return "ProtectMain"
    focus, lk = sit["focus"], sit["lk_nearest"]
    if sq["slot"] == 1:
        return "PressTarget" if (focus or lk) else "Reposition"
    if sq["slot"] == 2:
        if focus:
            return "HarassFlank"
        if sit["pickup"] and not lk:
            return "ContestSupply"
        return "HarassFlank"
    return "Hold"


def scripted_main_objective(obs: dict, sit: dict) -> str:
    me, em = sit["me"], sit["enemy_main"]
    duel_ok = bool(em) and me["hp"] >= em["hp"] - 10 and sit["own_n"] >= len(sit["vis_soldiers"]) and sit["hp_frac"] >= 0.4
    soldier_target = any(dist(e, me) <= 16 for e in sit["vis_soldiers"])
    focus = sit["focus"]
    if sit["danger"]:
        return "Retreat"
    if em and (dist(em, me) <= 12 or (dist(em, me) <= 18 and duel_ok and me["hp"] > em["hp"] + 10)):
        return "Engage"
    if soldier_target:
        return "Engage"
    if focus and dist(focus, me) <= 16 and (focus.get("kind") != "main" or duel_ok):
        return "Engage"
    if sit["pickup"] and me["ammo"] < 25 and dist(sit["pickup"], me) < 40:
        return "Resupply"
    if obs["squads"][0]["members"] and obs["squads"][0]["centroid"]:
        return "MoveTo"
    return "HoldNear"
