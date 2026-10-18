"""Synthetic observation builder for SLAI unit tests (no game engine required)."""
from __future__ import annotations

import copy
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TERRAIN = json.load(open(os.path.join(HERE, "..", "slai", "data", "terrain.json")))


def empty_squad(slot: int) -> dict:
    return {"slot": slot, "members": [], "leader": -1, "move": {"kind": "None", "x": 0, "y": 0, "followId": -1},
            "doctrine": "Defend", "formation": "Compact", "target": {"kind": "none", "id": -1, "x": 0, "y": 0},
            "blocked": 0, "centroid": None, "avgHp": 0.0, "avgAmmo": 0.0}


def soldier(i: int, x: float, y: float, squad: int = 0, hp: float = 30.0, ammo: int = 24, guard: bool = False) -> dict:
    return {"id": i, "x": x, "y": y, "theta": 0.0, "hp": hp, "shield": 8.0, "squad": squad, "guard": guard, "ammo": ammo, "task": "Idle"}


def make_obs(team: int = 1, tick: int = 600, generation: int = 1, main_hp: float = 100.0, squads: dict | None = None,
             unassigned: int = 0, enemies: list | None = None, lastknown: list | None = None, pickup: dict | None = None,
             main_xy: tuple = (92.0, 30.0), seed: int = 42, ammo: int = 50) -> dict:
    """squads: {slot: n_members}. Soldiers get ids from 10 upward and sit near the Main."""
    t = TERRAIN
    sol: list = []
    sq = [empty_squad(i + 1) for i in range(9)]
    nid = 10
    for slot, n in (squads or {}).items():
        ids = []
        for k in range(n):
            sol.append(soldier(nid, main_xy[0] - 6 + k * 0.5, main_xy[1] + (slot - 2) * 3, squad=slot))
            ids.append(nid)
            nid += 1
        sq[slot - 1].update(members=ids, leader=ids[0], centroid={"x": main_xy[0] - 6, "y": main_xy[1] + (slot - 2) * 3},
                            avgHp=1.0, avgAmmo=24.0, move={"kind": "Hold", "x": main_xy[0] - 6, "y": main_xy[1], "followId": -1})
    pool = []
    for _ in range(unassigned):
        sol.append(soldier(nid, main_xy[0] - 3, main_xy[1] + 1))
        pool.append(nid)
        nid += 1
    vis = [{"id": 1000 + i, "kind": e.get("kind", "soldier"), "x": e["x"], "y": e["y"], "theta": 0.0, "hp": e.get("hp", 30.0), "shield": 8.0}
           for i, e in enumerate(enemies or [])]
    return {
        "schema": "gangup.obs.v1", "version": "0.3", "seed": seed, "tick": tick, "time": tick / 60.0, "generation": generation,
        "team": team, "difficulty": "hard",
        "own": {"main": {"id": 2, "x": main_xy[0], "y": main_xy[1], "theta": 3.14, "hp": main_hp, "shield": 25.0, "alive": True,
                         "mode": "rifle", "ammo": ammo, "mag": 10, "strain": 0.0, "shieldMax": 25.0},
                "soldiers": sol, "soldierCount": len(sol), "stance": "defensive",
                "streak": {"active": False, "remaining": 0.0, "cooldown": 0.0, "killsInWindow": 0}},
        "squads": sq, "unassigned": pool,
        "enemies": {"visible": vis, "lastKnown": lastknown or [], "enemyStreakActive": False},
        "terrain": {"width": t["width"], "height": t["height"], "obstacles": copy.deepcopy(t["obstacles"]), "supply": t["supply"],
                    "zone": t["zones"][team], "enemyZone": t["zones"][1 - team]},
        "resources": {"pickup": pickup, "nextPickupIn": 12.0, "nextWaveIn": 9.0, "waveBase": 5},
        "legal": {"stances": ["defensive", "offensive"], "doctrines": ["Defend", "Press", "Harass", "Disengage"],
                  "formations": ["Compact", "Line", "Spread"], "mainGoals": ["Engage", "MoveTo", "Retreat", "HoldNear", "Resupply"],
                  "freeSlots": [s for s in range(1, 10) if s not in (squads or {})], "maxSquadSize": 10},
        "budget": {"deadlineMs": 400, "maxActions": 24},
    }
