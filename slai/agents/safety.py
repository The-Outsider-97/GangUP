"""Safety agent: independent validation of every proposed action (schema, legality, authority, visibility, bounds).

The engine re-validates everything (defence in depth); this agent keeps SLAI from *wasting* the engine's validation
budget on illegal orders and provides the audit trail (GDD 12.2, R10.2).
"""
from __future__ import annotations

import math

from ..geometry import is_free, nearest_free
from ..schema import COMMANDS, DOCTRINES, FORMATIONS, MAIN_GOALS, MAX_SQUAD, SLOTS, STANCES
from .base import Agent, Context

SQUAD_COMMANDS = {"CreateSquad", "DisbandSquad", "MoveSquad", "FollowUnit", "HoldPosition", "SetDoctrine", "SetFormation",
                  "SetTarget", "SetLeader", "SetRally"}


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_action(obs: dict, a: dict) -> tuple[dict | None, str | None]:
    """Return (possibly repaired action, None) or (None, reason)."""
    if not isinstance(a, dict) or a.get("command") not in COMMANDS:
        return None, "unknown-command"
    if a.get("generation") != obs["generation"]:
        return None, "stale-generation"
    if not (_num(a.get("issuedAt")) and _num(a.get("expiresAt"))) or a["expiresAt"] <= obs["tick"]:
        return None, "bad-envelope"
    cmd = a["command"]
    terrain = obs["terrain"]
    squads = obs["squads"]
    own_ids = {s["id"] for s in obs["own"]["soldiers"]}
    vis_ids = {e["id"] for e in obs["enemies"]["visible"]}
    a = dict(a)
    if cmd in SQUAD_COMMANDS:
        s = a.get("squad")
        if not isinstance(s, int) or isinstance(s, bool) or not 1 <= s <= SLOTS:
            return None, "missing-squad-id"
        if cmd != "CreateSquad" and not squads[s - 1]["members"]:
            return None, "empty-squad"
    if cmd == "SetStance":
        if a.get("stance") not in STANCES:
            return None, "bad-stance"
    elif cmd == "CreateSquad":
        m = a.get("members")
        if not isinstance(m, list) or len(set(m)) != len(m) or len(m) > MAX_SQUAD or not m:
            return None, "bad-members"
        if not all(isinstance(i, int) and i in own_ids for i in m):
            return None, "foreign-member"
    elif cmd in ("MoveSquad", "SetRally"):
        d = a.get("destination")
        if not isinstance(d, dict) or not (_num(d.get("x")) and _num(d.get("y"))):
            return None, "missing-destination"
        if not (0 <= d["x"] <= terrain["width"] and 0 <= d["y"] <= terrain["height"]):
            return None, "out-of-bounds"
        if not is_free(terrain, d["x"], d["y"], 0.4):
            fx, fy = nearest_free(terrain, d["x"], d["y"], 0.6, 4.0)
            if not is_free(terrain, fx, fy, 0.4):
                return None, "destination-in-cover"
            a["destination"] = {"x": round(fx, 2), "y": round(fy, 2)}
    elif cmd == "FollowUnit":
        t = a.get("target") or {}
        if t.get("id") not in own_ids and t.get("id") != obs["own"]["main"]["id"]:
            return None, "bad-follow-target"
    elif cmd == "SetDoctrine":
        if a.get("doctrine") not in DOCTRINES:
            return None, "bad-doctrine"
    elif cmd == "SetFormation":
        if a.get("formation") not in FORMATIONS:
            return None, "bad-formation"
    elif cmd == "SetTarget":
        t = a.get("target") or {}
        if t.get("kind") != "none" and t.get("id") is not None and t["id"] not in vis_ids:
            return None, "hidden-target"  # concealed IDs may never be used
    elif cmd == "SetLeader":
        if a.get("actor") not in squads[a["squad"] - 1]["members"]:
            return None, "not-a-member"
    elif cmd == "MainGoal":
        if a.get("actor") != obs["own"]["main"]["id"]:
            return None, "not-own-main"
        if a.get("goal") not in MAIN_GOALS:
            return None, "bad-goal"
        d = a.get("destination")
        if not isinstance(d, dict) or not (_num(d.get("x")) and _num(d.get("y"))):
            return None, "missing-destination"
        t = a.get("target") or {}
        if t.get("id") is not None and t["id"] not in vis_ids:
            return None, "hidden-target"
    return a, None


class SafetyAgent(Agent):
    name = "safety"

    def run(self, ctx: Context) -> None:
        obs = ctx.obs
        seen: dict = {}
        rejected: list = []
        for a in ctx.actions:
            fixed, why = validate_action(obs, a)
            if fixed is None:
                rejected.append({"command": a.get("command") if isinstance(a, dict) else None, "reason": why})
                continue
            # duplicates: the last order for the same (command, squad) wins
            seen[(fixed["command"], fixed.get("squad"), fixed.get("actor") if fixed["command"] == "SetLeader" else None)] = fixed
        out = list(seen.values())
        cap = obs["budget"].get("maxActions", 24)
        if len(out) > cap:
            ctx.notes.append(f"truncated {len(out) - cap} actions to the budget")
            out = out[:cap]
        ctx.actions = out
        ctx.flags["rejected"] = rejected
