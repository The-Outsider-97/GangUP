"""Planning / Reasoning agent: choose feasible strategic goals and compare their tactical consequences."""
from __future__ import annotations

from ..features import main_features, squad_features
from ..geometry import clamp, dist
from ..policy import TacticalDecisionPolicy, legal_main_objectives, legal_squad_objectives
from ..scripted import scripted_main_objective, scripted_squad_objective, scripted_stance
from .base import Agent, Context

AGGRESSIVE = {"PressTarget", "HarassFlank"}


def consequence_adjust(obs: dict, sit: dict, sq: dict, objective: str) -> float:
    """Small, bounded estimate of how an objective plays out given local odds (kept well below the policy's range)."""
    if sit["visible_count"] == 0:
        return 0.0
    cen = sq["centroid"] or sit["me"]
    near = sum(1 for e in obs["enemies"]["visible"] if dist(cen, e) <= 18)
    local = len(sq["members"]) / (near + 1.0)
    adj = 0.0
    if objective in AGGRESSIVE:
        adj += clamp((local - 0.8) * 0.5, -0.6, 0.3)
    if objective == "ProtectMain" and sit["hp_frac"] < 0.5:
        adj += 0.2
    if objective == "Disengage" and sq["avgAmmo"] >= 8:
        adj -= 0.6  # disengaging while still armed is a poor trade
    return adj


def decide_stance(sit: dict) -> str:
    """Q/E stance from a Lanchester-style strength comparison (defensive when weak or in danger)."""
    if sit["danger"] or sit["own_n"] < 5:
        return "defensive"
    if sit["visible_count"] and sit["ratio"] < 0.4:
        return "defensive"
    return "offensive"


class PlanningAgent(Agent):
    name = "planning"

    def __init__(self, policy: TacticalDecisionPolicy) -> None:
        self.policy = policy

    def run(self, ctx: Context) -> None:
        obs, sit = ctx.obs, ctx.situation
        bias = ctx.flags.get("bias", {"squad": {}, "main": {}})
        kn_bias = self._knowledge_bias(ctx)
        ctx.stance = decide_stance(sit)
        use_model = self.policy.trained
        if not use_model:
            ctx.notes.append("policy untrained: scripted objectives")
        overrides = 0
        conf_sum, conf_n = 0.0, 0
        for sq in obs["squads"]:
            if not sq["members"]:
                continue
            legal = self.gate_squad(ctx, sq, legal_squad_objectives(obs, sit, sq))
            if use_model:
                x = squad_features(obs, sit, sq)
                merged = {o: bias["squad"].get(o, 0.0) + kn_bias.get(o, 0.0) + consequence_adjust(obs, sit, sq, o) for o in legal}
                obj, conf, _ = self.policy.choose_squad(x, legal, merged)
            else:
                obj, conf = scripted_squad_objective(obs, sit, sq), 1.0
            # hard guardrails that no learned score may override (documented in the GDD risks): an unarmed squad refills,
            # and a threatened Main is never left without escorts.
            if sq["avgAmmo"] < 3 and obj != "Disengage":
                obj, overrides = "Disengage", overrides + 1
            elif sit["danger"] and obj in {"PressTarget", "HarassFlank", "ContestSupply", "Reposition"} and sq["slot"] != 2:
                obj, overrides = "ProtectMain", overrides + 1
            if obj not in legal:
                obj, overrides = scripted_squad_objective(obs, sit, sq), overrides + 1
            ctx.objectives[sq["slot"]] = obj
            conf_sum += conf
            conf_n += 1
        legal_m = legal_main_objectives(obs, sit)
        if use_model:
            mx = main_features(obs, sit)
            mobj, mconf, _ = self.policy.choose_main(mx, legal_m, bias["main"])
        else:
            mobj, mconf = scripted_main_objective(obs, sit), 1.0
        if sit["danger"] and mobj != "Retreat":
            mobj, overrides = "Retreat", overrides + 1  # the Main never walks into a lethal crossfire
        if mobj not in legal_m:
            mobj = scripted_main_objective(obs, sit)
        ctx.main_objective = mobj
        ctx.flags["overrides"] = overrides
        ctx.flags["policy_conf"] = (conf_sum + mconf) / (conf_n + 1)

    def gate_squad(self, ctx: Context, sq: dict, legal: list) -> list:
        """Hook for feasibility checks on the legal objectives (the real-agent bridge overrides it with HTN decomposition)."""
        return legal

    @staticmethod
    def _knowledge_bias(ctx: Context) -> dict:
        b: dict = {}
        for t in ctx.knowledge:
            p = t["params"]
            if "harass_bias" in p:
                b["HarassFlank"] = b.get("HarassFlank", 0.0) + p["harass_bias"]
            if "press_bias" in p:
                b["PressTarget"] = b.get("PressTarget", 0.0) + p["press_bias"]
            if "protect_bias" in p:
                b["ProtectMain"] = b.get("ProtectMain", 0.0) + p["protect_bias"]
            if "supply_bias" in p:
                b["ContestSupply"] = b.get("ContestSupply", 0.0) + p["supply_bias"]
            if "disengage_bias" in p:
                b["Disengage"] = b.get("Disengage", 0.0) + p["disengage_bias"]
            if "reposition_bias" in p:
                b["Reposition"] = b.get("Reposition", 0.0) + p["reposition_bias"]
        return b
