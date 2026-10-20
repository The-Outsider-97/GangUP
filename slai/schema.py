"""Observation / action schema for the engine <-> SLAI interface (GDD 12.4). Mirrors src/ai/schema.ts."""
from __future__ import annotations

import math
from typing import Any

from . import ACT_SCHEMA, OBS_SCHEMA

DOCTRINES = ("Defend", "Press", "Harass", "Disengage")
FORMATIONS = ("Compact", "Line", "Spread")
STANCES = ("defensive", "offensive")
MAIN_GOALS = ("Engage", "MoveTo", "Retreat", "HoldNear", "Resupply")
COMMANDS = (
    "SetStance", "CreateSquad", "DisbandSquad", "MoveSquad", "FollowUnit", "HoldPosition",
    "SetDoctrine", "SetFormation", "SetTarget", "SetLeader", "SetRally", "MainGoal",
)
MAX_SQUAD = 10
SLOTS = 9


class SchemaError(ValueError):
    """Raised when an observation or action violates the interface contract."""


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _need(d: Any, key: str, path: str, typ: Any = None) -> Any:
    if not isinstance(d, dict) or key not in d:
        raise SchemaError(f"missing {path}.{key}")
    v = d[key]
    if typ is not None and not isinstance(v, typ):
        raise SchemaError(f"bad type for {path}.{key}")
    return v


def episode_key(obs: dict) -> tuple:
    """Identity of one game for per-match state: the client's episode id when present, else the seed (seeds can repeat across games)."""
    return (obs.get("episode") or obs["seed"], obs["team"])


def validate_observation(obs: Any) -> None:
    """Reject malformed observations before any agent touches them."""
    if not isinstance(obs, dict):
        raise SchemaError("observation must be an object")
    if obs.get("schema") != OBS_SCHEMA:
        raise SchemaError(f"unsupported schema {obs.get('schema')!r}")
    for k in ("tick", "generation", "team", "seed"):
        if not _num(_need(obs, k, "obs")):
            raise SchemaError(f"obs.{k} must be a finite number")
    if obs["team"] not in (0, 1):
        raise SchemaError("obs.team must be 0 or 1")
    ep = obs.get("episode")
    if ep is not None and not (isinstance(ep, str) and 0 < len(ep) <= 64):
        raise SchemaError("obs.episode must be a non-empty string of at most 64 characters")
    own = _need(obs, "own", "obs", dict)
    main = _need(own, "main", "obs.own", dict)
    for k in ("id", "x", "y", "theta", "hp", "shield"):
        if not _num(_need(main, k, "obs.own.main")):
            raise SchemaError(f"obs.own.main.{k} must be a finite number")
    _need(own, "soldiers", "obs.own", list)
    _need(own, "streak", "obs.own", dict)
    squads = _need(obs, "squads", "obs", list)
    if len(squads) != SLOTS:
        raise SchemaError("obs.squads must have 9 entries")
    _need(obs, "unassigned", "obs", list)
    en = _need(obs, "enemies", "obs", dict)
    _need(en, "visible", "obs.enemies", list)
    _need(en, "lastKnown", "obs.enemies", list)
    for e in en["visible"]:
        for k in ("id", "x", "y", "hp"):
            if not _num(_need(e, k, "obs.enemies.visible[]")):
                raise SchemaError("bad visible enemy")
    ter = _need(obs, "terrain", "obs", dict)
    for k in ("width", "height"):
        if not _num(_need(ter, k, "obs.terrain")):
            raise SchemaError("bad terrain")
    _need(ter, "obstacles", "obs.terrain", list)
    _need(obs, "resources", "obs", dict)
    _need(obs, "legal", "obs", dict)
    _need(obs, "budget", "obs", dict)


def make_action(command: str, obs: dict, **fields: Any) -> dict:
    """Build a wire-format action carrying the observation generation and an expiry (default 5 s)."""
    if command not in COMMANDS:
        raise SchemaError(f"unknown command {command}")
    a: dict = {
        "command": command,
        "generation": obs["generation"],
        "issuedAt": obs["tick"],
        "expiresAt": obs["tick"] + fields.pop("ttl", 300),
    }
    a.update({k: v for k, v in fields.items() if v is not None})
    return a


def make_response(obs: dict, actions: list[dict], meta: dict | None = None) -> dict:
    return {"schema": ACT_SCHEMA, "generation": obs["generation"], "actions": actions, "meta": meta or {}}
