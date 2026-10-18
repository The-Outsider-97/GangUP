"""Collaborative agent: coordinate multiple independent squads (GDD 12.2).

Responsibilities: (1) organise the unassigned pool into squads, (2) de-conflict roles so squads do not duplicate
each other (one supply contest, distinct flank lanes, an escort when the Main is in danger), (3) stagger standoff
distances so pressing squads do not stack on one firing line.
"""
from __future__ import annotations

from ..geometry import dist
from ..resolver import choose_lane
from ..schema import make_action
from .base import Agent, Context

CAP = [8, 6, 6, 6, 6, 6, 6, 6, 6]


def active_squad_limit(own_n: int) -> int:
    return 3 if own_n < 14 else 4 if own_n < 28 else 6


class CollaborativeAgent(Agent):
    name = "collaborative"

    def run(self, ctx: Context) -> None:
        obs, sit = ctx.obs, ctx.situation
        self._organise(ctx, obs, sit)
        self._deconflict(ctx, obs, sit)

    # ------------------------------------------------------------------ squad formation
    def _organise(self, ctx: Context, obs: dict, sit: dict) -> None:
        pool = list(sit["pool"])
        limit = active_squad_limit(sit["own_n"])
        made = 0
        for sq in obs["squads"][:limit]:
            if made >= 2 or not pool:
                break
            have = len(sq["members"])
            cap = CAP[sq["slot"] - 1]
            if have >= cap:
                continue
            # never create a one-man squad; topping up an existing squad with a single soldier is fine
            if have == 0 and len(pool) < 2:
                continue
            take = pool[: cap - have]
            pool = pool[len(take):]
            ctx.actions.append(make_action("CreateSquad", obs, squad=sq["slot"], members=(list(sq["members"]) + take)[:10]))
            made += 1
        if made:
            ctx.notes.append(f"organised {made} squad(s)")

    # ------------------------------------------------------------------ role de-confliction
    def _deconflict(self, ctx: Context, obs: dict, sit: dict) -> None:
        objs = ctx.objectives
        squads = {sq["slot"]: sq for sq in obs["squads"] if sq["members"]}
        # one ContestSupply only: the squad nearest the pickup keeps it
        supply = [s for s, o in objs.items() if o == "ContestSupply"]
        if len(supply) > 1 and sit["pickup"]:
            keep = min(supply, key=lambda s: dist(squads[s]["centroid"] or sit["me"], sit["pickup"]))
            for s in supply:
                if s != keep:
                    objs[s] = "Hold"
        # distinct flank lanes
        taken: set = set()
        lanes: dict = {}
        for s in sorted(k for k, o in objs.items() if o == "HarassFlank"):
            lane = choose_lane(sit, taken)
            if lane in taken:
                objs[s] = "Reposition"  # both lanes are already being worked
                continue
            taken.add(lane)
            lanes[s] = lane
        # an escort for a threatened Main
        if sit["danger"] and squads and not any(o == "ProtectMain" for o in objs.values()):
            near = min(squads, key=lambda s: dist(squads[s]["centroid"] or sit["me"], sit["me"]))
            objs[near] = "ProtectMain"
        # stagger pressing squads
        standoff: dict = {}
        for n, s in enumerate(sorted(k for k, o in objs.items() if o == "PressTarget")):
            base = 9.0 if any(t["id"] == "outnumbered-hold-standoff" for t in ctx.knowledge) else 5.0 if any(t["id"] == "advantage-close-in" for t in ctx.knowledge) else 6.0
            standoff[s] = base + 1.5 * n
        ctx.flags["lanes"] = lanes
        ctx.flags["standoff"] = standoff
