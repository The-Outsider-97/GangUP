"""Orchestrator: routes only the agents a decision needs, bounds latency, isolates failures (GDD 12.2, 12.3).

Pipeline:  Perception -> Learning(observe) -> Knowledge? -> Planning -> Collaborative? -> Resolve -> Safety -> Evaluation
If an agent fails or the budget is nearly spent, the optional stages are skipped and the deterministic scripted policy
fills any gap, so a response is always produced and is always legal.
"""
from __future__ import annotations

import time

from . import __version__
from .agents import Context
from .agents.collaborative import CollaborativeAgent
from .agents.evaluation import EvaluationAgent
from .agents.knowledge import KnowledgeAgent
from .agents.learning import LearningAgent
from .agents.observability import ObservabilityAgent
from .agents.perception import PerceptionAgent
from .agents.planning import PlanningAgent
from .agents.safety import SafetyAgent
from .policy import DEFAULT_WEIGHTS, TacticalDecisionPolicy
from .resolver import main_actions, squad_actions
from .schema import make_action, make_response, validate_observation
from .scripted import scripted_main_objective, scripted_squad_objective, scripted_stance


class Orchestrator:
    """``agents="lite"``  : the self-contained agents in ``slai/agents`` (stdlib only; used by tests and when SLAI is not installed).
    ``agents="real"``  : the actual SLAI agents from ``<SLAI>/src/agents`` through ``slai.bridge`` (GDD 12.2). A real agent that cannot
                         be loaded, is too slow or fails is bypassed for that stage and reported in ``meta.stages`` / ``/v1/health``;
                         ``strict=True`` refuses to start unless all eight load."""

    def __init__(self, weights_path: str = DEFAULT_WEIGHTS, adaptive_path: str | None = None, telemetry_path: str | None = None,
                 tactics_path: str | None = None, agents: str = "lite", host=None, strict: bool = False, budgets: dict | None = None,
                 slai_root: str | None = None, safety_enforcing: bool = False, log=None, enabled=None) -> None:
        if agents not in ("lite", "real"):
            raise ValueError("agents must be 'lite' or 'real'")
        self.mode = agents
        self.host = None
        self.warm_ms: dict = {}
        self.policy = TacticalDecisionPolicy.load(weights_path)
        if agents == "real":
            from .bridge import adapters as A
            from .bridge.host import RealAgentHost
            from .bridge import GANGUP_AGENT_CONFIG

            self.host = host or RealAgentHost(root=slai_root, agent_config=GANGUP_AGENT_CONFIG, log=log, enabled=enabled)
            if not self.host.started:
                self.host.start()
            if strict and self.host.missing():
                bad = {n: self.host.slots[n].error for n in self.host.missing()}
                raise RuntimeError("strict mode: these real SLAI agents are unavailable: " + "; ".join(f"{n}: {e}" for n, e in bad.items()))
            caps = dict(budgets or {})
            h = self.host
            self.perception = A.RealPerception(h, caps)
            self.knowledge = A.RealKnowledge(h, tactics_path, caps)
            self.learning = A.RealLearning(h, adaptive_path, caps)
            self.planning = A.RealPlanning(h, self.policy, caps)
            self.collaborative = A.RealCollaborative(h, caps)
            self.safety = A.RealSafety(h, caps, enforcing=safety_enforcing)
            self.evaluation = A.RealEvaluation(h, caps)
            self.observability = A.RealObservability(h, telemetry_path, caps)
            self.warm_up()
        else:
            self.perception = PerceptionAgent()
            self.knowledge = KnowledgeAgent(tactics_path)
            self.learning = LearningAgent(adaptive_path)
            self.planning = PlanningAgent(self.policy)
            self.collaborative = CollaborativeAgent()
            self.safety = SafetyAgent()
            self.evaluation = EvaluationAgent()
            self.observability = ObservabilityAgent(telemetry_path)

    def warm_up(self) -> dict:
        """Real agents initialise lazily (first inference, first validation ...): run those first calls now, in parallel, so no
        game decision pays for them. Returns {stage: milliseconds or None}; failures stay visible on the slot (error / trace)."""
        import threading

        jobs = {"collaborative": self.collaborative.warm, "knowledge": self.knowledge.warm, "planning": self.planning.warm,
                "perception": self.perception.warm, "safety": self.safety.warm}
        out: dict = {}

        def go(name: str, fn) -> None:
            t0 = time.perf_counter()
            try:
                ok = fn()
            except Exception:  # noqa: BLE001
                ok = None
            out[name] = round((time.perf_counter() - t0) * 1000.0) if ok not in (None, False) else None

        threads = [threading.Thread(target=go, args=(n, f), daemon=True) for n, f in jobs.items() if self.host.usable(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=150.0)
        self.warm_ms = out
        if self.host.log:
            for n, ms in out.items():
                self.host.log(f"  warm {n:<13} {'ready' if ms is not None else 'FAILED (will use the built-in stage)'}{f' in {ms} ms' if ms is not None else ''}")
        return out

    # ------------------------------------------------------------------ main entry
    def decide(self, obs: dict, feedback: list | None = None) -> dict:
        validate_observation(obs)  # raises SchemaError for malformed input
        t0 = time.perf_counter()
        budget_s = max(0.05, min(5.0, obs["budget"].get("deadlineMs", 400) / 1000.0)) * 0.8
        ctx = Context(obs=obs, deadline=time.monotonic() + budget_s)
        ctx.flags["feedback"] = list(feedback or [])[:64]
        ran: list = []

        def run(agent, optional: bool = False) -> bool:
            if optional and ctx.time_left() < budget_s * 0.3:
                ctx.notes.append(f"skipped {agent.name}: budget")
                return False
            ok = agent.safe_run(ctx)
            ran.append(agent.name)
            return ok

        if not run(self.perception):
            return self._emergency(obs, ctx, t0)
        sit = ctx.situation

        run(self.learning)  # cheap; also yields bias
        needs_knowledge = sit["visible_count"] > 0 or sit["hp_frac"] < 0.5 or sit["pickup"] is not None or sit["lk_nearest"] is not None
        if needs_knowledge:
            run(self.knowledge, optional=True)

        planned = run(self.planning)
        if not planned or not ctx.objectives and any(sq["members"] for sq in obs["squads"]):
            self._scripted_objectives(ctx)  # documented deterministic fallback
            ctx.flags["fallback"] = True

        needs_collab = any(sq["members"] for sq in obs["squads"]) or len(sit["pool"]) >= 2
        if needs_collab:
            if not run(self.collaborative, optional=True):
                ctx.flags.setdefault("lanes", {})
                ctx.flags.setdefault("standoff", {})

        self._compose(ctx)
        run(self.safety)
        run(self.evaluation)
        self.learning.note_usage(obs, ctx.objectives)

        total_ms = (time.perf_counter() - t0) * 1000.0
        self.observability.record(ctx, total_ms)
        meta = {
            "policy": f"tdp-{self.policy.version}" if self.policy.trained and not ctx.flags.get("fallback") else "scripted-fallback",
            "service": __version__,
            "agents": ran,
            "latencyMs": round(total_ms, 2),
            "objectives": {str(k): v for k, v in ctx.objectives.items()},
            "mainObjective": ctx.main_objective,
            "stance": ctx.stance,
            "tags": ctx.flags.get("tags", []),
            "tactics": [t["id"] for t in ctx.knowledge],
            "confidence": round(ctx.flags.get("policy_conf", ctx.confidence), 3),
            "overrides": ctx.flags.get("overrides", 0),
            "rejectedBySafety": len(ctx.flags.get("rejected", [])),
            "errors": ctx.errors,
            "fallback": bool(ctx.flags.get("fallback")),
            "notes": ctx.notes[:8],
            "mode": self.mode,
            "stages": ctx.flags.get("stages", {}),
        }
        for k_meta, k_flag in (("scene", "scene"), ("plans", "plans"), ("htnMasked", "htn_masked"), ("safetyVerdict", "safety_real")):
            if k_flag in ctx.flags:
                meta[k_meta] = ctx.flags[k_flag]
        return make_response(obs, ctx.actions, meta)

    # ------------------------------------------------------------------ helpers
    def _scripted_objectives(self, ctx: Context) -> None:
        obs, sit = ctx.obs, ctx.situation
        ctx.stance = scripted_stance(sit)
        for sq in obs["squads"]:
            if sq["members"]:
                ctx.objectives[sq["slot"]] = scripted_squad_objective(obs, sit, sq)
        ctx.main_objective = scripted_main_objective(obs, sit)

    def _compose(self, ctx: Context) -> None:
        """Resolve objectives into concrete commands (appended after any squad-organisation actions)."""
        obs, sit = ctx.obs, ctx.situation
        if not obs["own"]["main"].get("alive", True):
            return
        if ctx.stance != obs["own"]["stance"]:
            ctx.actions.insert(0, make_action("SetStance", obs, stance=ctx.stance))
        lanes = ctx.flags.get("lanes", {})
        standoff = ctx.flags.get("standoff", {})
        for sq in obs["squads"]:
            obj = ctx.objectives.get(sq["slot"])
            if obj and sq["members"]:
                ctx.actions.extend(squad_actions(obs, sit, sq, obj, lanes.get(sq["slot"]), standoff.get(sq["slot"], 6.0)))
        ctx.actions.extend(main_actions(obs, sit, ctx.main_objective))

    def _emergency(self, obs: dict, ctx: Context, t0: float) -> dict:
        """Perception itself failed: hold everything and say so. The engine keeps the last legal orders."""
        self.observability.note_error()
        meta = {"policy": "emergency-hold", "fallback": True, "errors": ctx.errors, "agents": [], "latencyMs": round((time.perf_counter() - t0) * 1000, 2)}
        return make_response(obs, [], meta)

    def match_end(self, seed: int, team: int, winner: int | None) -> dict:
        self.evaluation.forget(seed, team)
        return self.learning.update_from_match(seed, team, winner)

    def stats(self) -> dict:
        s = self.observability.snapshot()
        s["policy"] = {"version": self.policy.version, "trained": self.policy.trained, "meta": self.policy.meta}
        s["evaluation"] = self.evaluation.report()
        s["adaptive"] = {k: self.learning.profile[k] for k in ("matches", "wins", "losses", "draws")}
        s["agentMode"] = self.mode
        if self.host is not None:
            s["realAgents"] = self.host.status()
            s["realUse"] = {
                "knowledge": {"queries": self.knowledge.queries, "applicableButNotRetrieved": self.knowledge.misses},
                "collaborative": {"arbitrations": self.collaborative.arbitrations, "attackVetoes": self.collaborative.vetoes},
                "safety": {"reviews": self.safety.reviews, "blocks": self.safety.blocks, "cacheHits": self.safety.cache_hits, "mode": self.safety.mode, "dispatched": self.safety.dispatched, "last": self.safety.last},
                "learning": {"signalsSent": self.learning.sent, "lastGuidance": self.learning.last_guidance},
            }
        return s

    def close(self) -> None:
        if self.host is not None:
            self.host.close()

    def agents_summary(self) -> dict:
        if self.host is None:
            return {"mode": "lite", "ready": 0, "total": 0, "missing": []}
        return {"mode": "real", "ready": self.host.ready_count(), "total": len(self.host.enabled), "missing": self.host.missing()}
