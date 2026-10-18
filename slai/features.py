"""Feature extraction for the TacticalDecisionPolicy (GDD 13.2). Inputs are the legal observation + situation only."""
from __future__ import annotations

from .geometry import clamp, dist

SQUAD_OBJECTIVES = (
    "ProtectMain", "Reposition", "PressTarget", "HarassFlank", "ContestSupply", "Hold", "Regroup", "Disengage",
)
MAIN_OBJECTIVES = ("Engage", "HoldNear", "MoveTo", "Retreat", "Resupply")

SQUAD_FEATURES = (
    "main_hp", "main_low", "threat_near", "vis_count", "enemy_main_visible", "enemy_main_dist", "lk_present",
    "ratio", "squad_size", "squad_hp", "squad_ammo", "squad_low_ammo", "squad_dist_main", "squad_dist_enemy",
    "supply_avail", "squad_dist_supply", "main_ammo_low", "wave_soon", "own_streak", "enemy_streak",
    "blocked_frac", "slot1", "slot2", "slot_other", "own_n", "danger", "focus_present", "stance_off",
)
MAIN_FEATURES = (
    "main_hp", "main_low", "enemy_main_visible", "enemy_main_dist", "enemy_main_hp", "duel_edge", "vis_soldiers",
    "threat_near", "ratio", "ammo_low", "pickup_avail", "pickup_dist", "own_n", "own_streak", "enemy_streak",
    "danger", "focus_dist", "lk_present", "soldier_close", "squad1_present", "main_ahead",
)


def _lk_conf(sit: dict, obs: dict) -> float:
    lk = obs["enemies"]["lastKnown"]
    return max(0.0, 1.0 - min(e["age"] for e in lk) / 3.0) if lk else 0.0


def squad_features(obs: dict, sit: dict, sq: dict) -> list[float]:
    me = sit["me"]
    cen = sq["centroid"] or {"x": me["x"], "y": me["y"]}
    em = sit["enemy_main"]
    focus = sit["focus"]
    pickup = sit["pickup"]
    members = max(1, len(sq["members"]))
    d_enemy = clamp(min((dist(cen, e) for e in obs["enemies"]["visible"]), default=40.0) / 40.0, 0.0, 1.0)
    d_main = clamp(dist(cen, me) / 40.0, 0.0, 1.0)
    d_sup = clamp(dist(cen, pickup) / 50.0, 0.0, 1.0) if pickup else 1.0
    return [
        sit["hp_frac"],
        1.0 if sit["hp_frac"] < 0.35 else 0.0,
        min(1.0, sit["threats_near"] / 5.0),
        min(1.0, sit["visible_count"] / 10.0),
        1.0 if em else 0.0,
        clamp(dist(em, me) / 30.0, 0.0, 1.0) if em else 1.0,
        _lk_conf(sit, obs),
        sit["ratio"],
        min(1.0, len(sq["members"]) / 10.0),
        sq["avgHp"],
        clamp(sq["avgAmmo"] / 24.0, 0.0, 1.0),
        1.0 if sq["avgAmmo"] < 3 else 0.0,
        d_main,
        d_enemy,
        1.0 if pickup else 0.0,
        d_sup,
        1.0 if obs["own"]["main"]["ammo"] < 25 else 0.0,
        1.0 if obs["resources"]["nextWaveIn"] < 6 else 0.0,
        1.0 if obs["own"]["streak"]["active"] else 0.0,
        1.0 if obs["enemies"]["enemyStreakActive"] else 0.0,
        min(1.0, sq["blocked"] / members),
        1.0 if sq["slot"] == 1 else 0.0,
        1.0 if sq["slot"] == 2 else 0.0,
        1.0 if sq["slot"] > 2 else 0.0,
        min(1.0, sit["own_n"] / 50.0),
        1.0 if sit["danger"] else 0.0,
        1.0 if focus else 0.0,
        1.0 if obs["own"]["stance"] == "offensive" else 0.0,
    ]


def main_features(obs: dict, sit: dict) -> list[float]:
    me = sit["me"]
    em = sit["enemy_main"]
    pickup = sit["pickup"]
    nearest = sit["nearest"]
    s1 = obs["squads"][0]
    ahead = 0.0
    if s1["centroid"] and s1["members"]:
        ahead = clamp(sit["dir"] * (me["x"] - s1["centroid"]["x"]) / 20.0, -1.0, 1.0)
    soldier_close = any(dist(e, me) <= 16 for e in sit["vis_soldiers"])
    return [
        sit["hp_frac"],
        1.0 if sit["hp_frac"] < 0.35 else 0.0,
        1.0 if em else 0.0,
        clamp(dist(em, me) / 30.0, 0.0, 1.0) if em else 1.0,
        em["hp"] / 100.0 if em else 0.0,
        clamp((me["hp"] - em["hp"]) / 100.0, -1.0, 1.0) if em else 0.0,
        min(1.0, len(sit["vis_soldiers"]) / 10.0),
        min(1.0, sit["threats_near"] / 5.0),
        sit["ratio"],
        1.0 if me["ammo"] < 25 else 0.0,
        1.0 if pickup else 0.0,
        clamp(dist(pickup, me) / 60.0, 0.0, 1.0) if pickup else 1.0,
        min(1.0, sit["own_n"] / 50.0),
        1.0 if obs["own"]["streak"]["active"] else 0.0,
        1.0 if obs["enemies"]["enemyStreakActive"] else 0.0,
        1.0 if sit["danger"] else 0.0,
        clamp(dist(nearest, me) / 24.0, 0.0, 1.0) if nearest else 1.0,
        _lk_conf(sit, obs),
        1.0 if soldier_close else 0.0,
        1.0 if (s1["members"]) else 0.0,
        ahead,
    ]
