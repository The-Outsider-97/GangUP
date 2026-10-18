"""Stage adapters: GangUP's decision pipeline running on the *real* SLAI agents (``src/agents``).

The real agents are general frameworks; none of them knows what a "squad" or a "flank lane" is. What GangUP adds is the
game-specific *meaning* (it builds the tactical situation, defines the legal objectives and the rules of the arena); what
each real agent contributes is its own capability, and for five of the eight roles its answer changes the decision:

  stage          real agent (src/agents)   what the real agent does for GangUP                         affects the decision
  -------------  ------------------------  ----------------------------------------------------------  --------------------
  perception     PerceptionAgent           encodes a text rendering of the tactical snapshot (its         scene novelty (telemetry,
                                           TEXT modality) into a scene embedding                          learning signal)
  learning       LearningAgent             receives LearningSignals (outcomes / performance) through     telemetry + persistent
                                           its public ``observe`` mode                                    signal store
  knowledge      KnowledgeAgent            indexes the validated tactics library and RETRIEVES the        yes - only retrieved
                                           tactics for the current situation (TF-IDF)                     tactics are applied
  planning       PlanningAgent             HTN decomposition of every candidate squad objective against   yes - infeasible
                                           the current world state (preconditions)                        objectives are masked
  collaborative  CollaborativeAgent        ``coordinate_tasks`` arbitrates contested roles (supply,       yes
                                           flank lanes, escort); ``assess_risk`` vetoes reckless attacks
  safety         SafetyAgent               ``validate_action`` on the proposed order set                   verdict reported; a "block"
                                                                                                          holds fire only with --safety-enforce
  evaluation     EvaluationAgent           ``predict`` health forecast from decision metrics (periodic)   telemetry
  observability  ObservabilityAgent        ``perform_task`` with latencies, throughput and events         telemetry

Every real call is time-boxed and circuit-broken by ``RealAgentHost``; if a real agent is missing, slow or failing, the
stage runs the domain fallback in ``slai/agents`` and says so (``meta.stages``), so a legal answer is always produced.
"""
from __future__ import annotations

import math
import time
from typing import Any

from ..agents import Context
from ..agents.collaborative import CAP, CollaborativeAgent  # noqa: F401  (CAP re-exported for tests)
from ..agents.evaluation import EvaluationAgent
from ..agents.knowledge import KnowledgeAgent, situation_tags
from ..agents.learning import LearningAgent
from ..agents.observability import ObservabilityAgent
from ..agents.perception import PerceptionAgent
from ..agents.planning import PlanningAgent
from ..agents.safety import SafetyAgent
from ..geometry import clamp, dist
from ..policy import TacticalDecisionPolicy
from ..resolver import choose_lane
from .host import RealAgentHost, StageBusy, StageTimeout, StageUnavailable

DEFAULT_BUDGET_MS = {"perception": 150, "knowledge": 80, "planning": 120, "collaborative": 250, "safety": 250}


def _budget(host: RealAgentHost, ctx: Context, name: str, caps: dict) -> float | None:
    """Seconds this call may take: its own cap, but never more than 60 % of the time left for the whole decision."""
    cap = caps.get(name, DEFAULT_BUDGET_MS.get(name, 100)) / 1000.0
    left = ctx.time_left() * 0.6
    return cap if left >= cap else (left if left >= 0.01 else None)


def _mark(ctx: Context, stage: str, source: str) -> None:
    ctx.flags.setdefault("stages", {})[stage] = source


def _why(e: BaseException) -> str:
    if isinstance(e, (StageUnavailable, StageBusy, StageTimeout)):
        return str(e)
    return f"{type(e).__name__}: {str(e)[:160]}"


def _flatten(x: Any) -> list[float]:
    if hasattr(x, "detach"):
        x = x.detach().cpu()
    if hasattr(x, "reshape"):
        x = x.reshape(-1)
    if hasattr(x, "tolist"):
        x = x.tolist()
    return [float(v) for v in x]


# ====================================================================== Perception
class RealPerception(PerceptionAgent):
    """Domain situation (always) + a scene embedding from the real PerceptionAgent."""

    # The agent's tokenizer ships with 5 tokens when its BPE files are absent, which turns every word into [UNK] (all scenes would
    # embed alike). The scene is therefore described in a small closed vocabulary that is added to the tokenizer at start-up
    # (its public add_tokens; the encoder's embedding table is far larger than the new ids).
    VOCAB = ("team", "one", "two", "allies", "none", "few", "several", "many", "main", "health", "critical", "low", "medium", "high",
             "enemies", "visible", "near", "ratio", "outnumbered", "even", "advantage", "danger", "calm", "supply", "open", "closed",
             "confidence", "wave", "soon", "later")

    def __init__(self, host: RealAgentHost, caps: dict | None = None) -> None:
        self.host, self.caps = host, caps or {}
        self.prev: dict = {}
        self.vocab_seeded = 0
        self.vocab_error: str | None = None
        self.steady_ms = 0.0

    @staticmethod
    def _bucket(v: float, edges: tuple, words: tuple) -> str:
        for e, w in zip(edges, words):
            if v < e:
                return w
        return words[-1]

    @classmethod
    def describe(cls, obs: dict, sit: dict) -> str:
        b, counts = cls._bucket, ("none", "few", "several", "many")
        return (f"team {'one' if obs['team'] == 1 else 'two'} allies {b(sit['own_n'], (1, 4, 9), counts)} "
                f"main health {b(sit['hp_frac'], (0.25, 0.6, 0.85), ('critical', 'low', 'medium', 'high'))} "
                f"enemies visible {b(sit['visible_count'], (1, 3, 7), counts)} near {b(sit['threats_near'], (1, 3, 7), counts)} "
                f"ratio {b(sit['ratio'], (0.7, 1.3), ('outnumbered', 'even', 'advantage'))} {'danger' if sit['danger'] else 'calm'} "
                f"supply {'open' if sit['pickup'] else 'closed'} confidence {b(sit['info_conf'], (0.35, 0.7), ('low', 'medium', 'high'))} "
                f"wave {'soon' if sit['wave_in'] < 10 else 'later'}")

    def seed_vocabulary(self, agent: Any) -> None:
        tok = getattr(agent, "tokenizer", None)
        add = getattr(tok, "add_tokens", None)
        if add is None:
            self.vocab_error = "the agent exposes no tokenizer.add_tokens"
            return
        self.vocab_seeded = int(add(list(self.VOCAB)) or 0)

    def embed(self, text: str, budget: float) -> list[float]:
        res = self.host.call("perception", lambda a: a.perform_task({"task_type": "inference", "modality": "text", "input_data": text}), budget)
        if not isinstance(res, dict) or res.get("status") != "success" or "output" not in res:
            raise ValueError(f"unexpected PerceptionAgent result: {str(res)[:120]}")
        vec = _flatten(res["output"])
        if not vec or not all(math.isfinite(v) for v in vec):
            raise ValueError("empty or non-finite embedding")
        return vec

    def warm(self) -> bool:
        """Seed the vocabulary, then pay for the first inference (it builds encoder state lazily: seconds on CPU) and measure the second."""
        if not self.host.usable("perception"):
            return False
        sample = "team one allies several main health high enemies visible none near none ratio even calm supply open confidence high wave later"
        try:
            try:
                self.host.call("perception", self.seed_vocabulary, 30.0)
            except Exception as e:  # noqa: BLE001 - scenes still embed, just coarser; say so
                self.vocab_error = f"{type(e).__name__}: {str(e)[:120]}"
            self.embed(sample, 60.0)
            t0 = time.perf_counter()
            self.embed(sample, 60.0)
            self.steady_ms = (time.perf_counter() - t0) * 1000.0
        except Exception:  # noqa: BLE001 - reported through the slot (last error / trace)
            return False
        return True

    def run(self, ctx: Context) -> None:
        super().run(ctx)  # situation: parsing the authorised observation is game logic, not an agent capability
        text = self.describe(ctx.obs, ctx.situation)
        caps = self.caps
        if "perception" not in caps and self.steady_ms:  # no explicit --budget: allow ~3x the measured steady-state time (within 150..400 ms)
            caps = dict(caps, perception=min(400.0, max(150.0, 3.0 * self.steady_ms)))
        budget = _budget(self.host, ctx, "perception", caps)
        try:
            if budget is None:
                raise StageTimeout("perception: no time left")
            vec = self.embed(text, budget)
            key = (ctx.obs["seed"], ctx.obs["team"])
            prev = self.prev.get(key)
            novelty = 0.0
            if prev and len(prev) == len(vec):
                dot = sum(a * b for a, b in zip(prev, vec))
                na, nb = math.sqrt(sum(a * a for a in prev)), math.sqrt(sum(b * b for b in vec))
                novelty = clamp(1.0 - dot / (na * nb), 0.0, 1.0) if na > 0 and nb > 0 else 0.0
            if len(self.prev) > 64:
                self.prev.clear()
            self.prev[key] = vec
            ctx.flags["scene"] = {"novelty": round(novelty, 4), "dim": len(vec)}
            _mark(ctx, "perception", "real")
        except Exception as e:  # noqa: BLE001 - enrichment is optional; the situation above is already complete
            _mark(ctx, "perception", f"lite ({_why(e)})")


# ====================================================================== Learning
class RealLearning(LearningAgent):
    """Domain bias learning (objective names are GangUP's) + LearningSignals into the real LearningAgent."""
    EVERY = 16  # decisions between performance signals (background; the real agent may be slow)

    def __init__(self, host: RealAgentHost, path: str | None = None, caps: dict | None = None) -> None:
        super().__init__(path)
        self.host = host
        self.count: dict = {}
        self.sent = 0
        self.last_guidance: Any = None
        self.last_error: str | None = None

    def _send(self, signal: dict) -> None:
        def job(agent: Any) -> Any:
            out = agent.perform_task({"mode": "observe", "signal": signal})
            self.last_guidance = (out or {}).get("learning", {}).get("adaptive_guidance") if isinstance(out, dict) else None
            return out

        if self.host.background("learning", job):
            self.sent += 1

    def run(self, ctx: Context) -> None:
        super().run(ctx)
        obs, sit = ctx.obs, ctx.situation
        key = (obs["seed"], obs["team"])
        n = self.count[key] = self.count.get(key, 0) + 1
        if len(self.count) > 64:
            self.count.clear()
        if n % self.EVERY == 1 and self.host.usable("learning"):
            self._send({"signal_id": f"gangup-{obs['seed']}-{obs['team']}-{obs['tick']}", "source_agent": "gangup.slai", "kind": "performance",
                        "metric": "strength_ratio", "value": float(sit["ratio"]), "direction": "higher_better", "confidence": float(sit["info_conf"]),
                        "provenance": "execution", "context": {"game": "gangup", "team": obs["team"], "phase": "early" if obs["time"] < 60 else "late"},
                        "metadata": {"seed": obs["seed"], "tick": obs["tick"], "novelty": ctx.flags.get("scene", {}).get("novelty")}})
        _mark(ctx, "learning", "real" if self.host.usable("learning") else "lite (agent unavailable)")

    def update_from_match(self, seed: int, team: int, winner: int | None, lr: float = 0.08) -> dict:
        usage = dict(self.usage.get((seed, team), {}))
        out = super().update_from_match(seed, team, winner, lr)
        if self.host.usable("learning"):
            self._send({"signal_id": f"gangup-end-{seed}-{team}", "source_agent": "gangup.slai", "kind": "outcome", "metric": "match_result",
                        "value": float(out["reward"]), "direction": "higher_better", "confidence": 1.0, "validated": True, "provenance": "execution",
                        "context": {"game": "gangup", "team": team}, "metadata": {"seed": seed, "winner": winner, "objectiveUsage": usage}})
        out["realLearningSignals"] = self.sent
        return out


# ====================================================================== Knowledge
class RealKnowledge(KnowledgeAgent):
    """Tactics are indexed in, and retrieved from, the real KnowledgeAgent; the domain only checks applicability."""
    PREFIX = "gangup:"

    def __init__(self, host: RealAgentHost, path: str | None = None, caps: dict | None = None) -> None:
        super().__init__(path)
        self.host, self.caps = host, caps or {}
        self.seeded = False
        self.queries = 0
        self.misses = 0

    def seed(self, agent: Any) -> None:
        if self.seeded:
            return
        for t in self.tactics:
            text = " ".join(t["when"]) + " " + t["id"].replace("-", " ")
            agent.add_document(text, doc_id=self.PREFIX + t["id"], metadata={"gangup": True, "tactic": t["id"], "validated": True})
        self.seeded = True

    def warm(self) -> bool:
        if not self.host.usable("knowledge"):
            return False
        try:
            self.host.call("knowledge", self.seed, 20.0)
            return True
        except Exception:  # noqa: BLE001 - retried lazily on the first decision
            return False

    def run(self, ctx: Context) -> None:
        tags = situation_tags(ctx.obs, ctx.situation)
        ctx.flags["tags"] = sorted(tags)
        applicable = self.retrieve(tags)  # validated + conditions satisfied (domain)
        if not tags:
            ctx.knowledge = []
            _mark(ctx, "knowledge", "real" if self.host.usable("knowledge") else "lite (agent unavailable)")
            return
        query = " ".join(sorted(tags))
        budget = _budget(self.host, ctx, "knowledge", self.caps)
        try:
            if budget is None:
                raise StageTimeout("knowledge: no time left")

            def job(agent: Any) -> Any:
                self.seed(agent)
                return agent.retrieve(query, k=len(self.tactics) + 2)

            res = self.host.call("knowledge", job, budget)
            ids = set()
            for item in res or []:
                doc = item[1] if isinstance(item, (tuple, list)) and len(item) == 2 else item
                did = str((doc or {}).get("doc_id", ""))
                if did.startswith(self.PREFIX):
                    ids.add(did[len(self.PREFIX):])
            chosen = [t for t in applicable if t["id"] in ids]
            self.queries += 1
            self.misses += len(applicable) - len(chosen)
            ctx.knowledge = chosen
            _mark(ctx, "knowledge", "real")
        except Exception as e:  # noqa: BLE001
            ctx.knowledge = applicable
            _mark(ctx, "knowledge", f"lite ({_why(e)})")


# ====================================================================== Planning
# Hierarchical task network: each squad objective decomposes into ordered primitive steps whose preconditions are facts about the
# current world state. Infeasible objectives (a precondition fails) cannot be chosen by the learned policy.
HTN = {
    "PressTarget": [("advance", "calm"), ("engage", "enemy_visible")],
    "HarassFlank": [("flank", "calm"), ("strike", "enemy_known")],
    "ContestSupply": [("approach", "pickup_open"), ("collect", "pickup_open")],
    "ProtectMain": [("escort", None)],
    "Hold": [("take_position", None)],
    "Reposition": [("relocate", None)],
    "Disengage": [("withdraw", None), ("resupply", None)],
}


class RealPlanning(PlanningAgent):
    def __init__(self, host: RealAgentHost, policy: TacticalDecisionPolicy, caps: dict | None = None) -> None:
        super().__init__(policy)
        self.host, self.caps = host, caps or {}
        self.registered: dict = {}
        self.feasible: dict | None = None
        self.last_plans: dict = {}

    # -- world model -> HTN facts
    @staticmethod
    def facts(sit: dict) -> dict:
        return {"enemy_visible": sit["visible_count"] > 0, "enemy_known": sit["visible_count"] > 0 or sit["lk_nearest"] is not None,
                "calm": not sit["danger"], "pickup_open": sit["pickup"] is not None}

    def warm(self) -> bool:
        """Registers the HTN and runs one decomposition per objective (the first decompose_task initialises the planner's caches)."""
        if not self.host.usable("planning"):
            return False
        try:
            self.host.call("planning", self._decompose({"enemy_visible": False, "enemy_known": False, "calm": True, "pickup_open": True}), 60.0)
            return True
        except Exception:  # noqa: BLE001 - reported through the slot (last error / trace)
            return False

    def _register(self, planner: Any) -> None:
        if self.registered:
            return
        from src.agents.planning.planning_types import Task, TaskType  # type: ignore

        for obj, steps in HTN.items():
            prims = []
            for step, fact in steps:
                pre = [(lambda s, f=fact: bool(s.get(f)))] if fact else [(lambda s: True)]
                t = Task(f"gu_{obj}_{step}", TaskType.PRIMITIVE, preconditions=pre, effects=[], duration=1.0)
                t.id = f"gu_{obj}_{step}"
                prims.append(t)
            abstract = Task(f"gu_achieve_{obj}", TaskType.ABSTRACT, methods=[prims], duration=2.0)
            abstract.id = f"gu_achieve_{obj}"
            planner.register_task(abstract)
            self.registered[obj] = abstract

    def _decompose(self, facts: dict):
        def job(planner: Any) -> dict:
            self._register(planner)
            planner.world_state = dict(facts)  # the planner memoises on its own world state: keep it equal to the facts
            out: dict = {}
            for obj, task in self.registered.items():
                plan = planner.decompose_task(task, dict(facts))
                out[obj] = [t.name.replace(f"gu_{obj}_", "") for t in plan] if plan else None
            return out

        return job

    def run(self, ctx: Context) -> None:
        self.feasible = None
        budget = _budget(self.host, ctx, "planning", self.caps)
        try:
            if budget is None:
                raise StageTimeout("planning: no time left")
            res = self.host.call("planning", self._decompose(self.facts(ctx.situation)), budget)
            if not isinstance(res, dict) or not any(v for v in res.values()):
                raise ValueError("HTN produced no feasible objective")
            self.feasible = res
            _mark(ctx, "planning", "real")
        except Exception as e:  # noqa: BLE001
            _mark(ctx, "planning", f"lite ({_why(e)})")
        super().run(ctx)
        if self.feasible:
            ctx.flags["plans"] = {str(s): self.feasible.get(o) for s, o in ctx.objectives.items() if self.feasible.get(o)}

    def gate_squad(self, ctx: Context, sq: dict, legal: list) -> list:
        if not self.feasible:
            return legal
        ok = [o for o in legal if self.feasible.get(o)]
        masked = len(legal) - len(ok)
        if masked:
            ctx.flags["htn_masked"] = ctx.flags.get("htn_masked", 0) + masked
        return ok or legal  # never leave a squad without options


# ====================================================================== Collaborative
RISKY = {"PressTarget": "Hold", "HarassFlank": "Reposition"}
RISK_FLOOR = 0.73  # an attack is never vetoed below this domain risk (= 3:1 local odds against), whatever the agent's adaptive threshold says


class RealCollaborative(CollaborativeAgent):
    """Squad organisation stays game logic; contested roles are arbitrated by the real agent, attacks risk-assessed by it."""

    def __init__(self, host: RealAgentHost, caps: dict | None = None) -> None:
        self.host, self.caps = host, caps or {}
        self.arbitrations = 0
        self.vetoes = 0
        self.can_coordinate = True

    def warm(self) -> bool:
        """coordinate_tasks may DELEGATE to the manager's registered agents (``delegate_during_coordination``). GangUP only wants
        an assignment, so make sure that is off; if it cannot be switched off, role arbitration falls back to the domain rule."""
        rc = getattr(self.host.instance("collaborative"), "runtime_config", None)
        if rc is not None and getattr(rc, "delegate_during_coordination", False):
            try:
                object.__setattr__(rc, "delegate_during_coordination", False)
            except Exception:  # noqa: BLE001
                pass
            self.can_coordinate = not getattr(rc, "delegate_during_coordination", False)
        return self.host.usable("collaborative")

    def _deconflict(self, ctx: Context, obs: dict, sit: dict) -> None:
        objs = ctx.objectives
        squads = {sq["slot"]: sq for sq in obs["squads"] if sq["members"]}
        budget = _budget(self.host, ctx, "collaborative", self.caps)
        try:
            if budget is None:
                raise StageTimeout("collaborative: no time left")
            self._real(ctx, obs, sit, objs, squads, budget)
            _mark(ctx, "collaborative", "real")
        except Exception as e:  # noqa: BLE001
            _mark(ctx, "collaborative", f"lite ({_why(e)})")
            super()._deconflict(ctx, obs, sit)

    def _real(self, ctx: Context, obs: dict, sit: dict, objs: dict, squads: dict, budget: float) -> None:
        def where(slot: int) -> dict:
            return squads[slot]["centroid"] or sit["me"]

        # 1) risk gate: the real agent's dynamic thresholds decide whether an attack is too reckless
        risky = [(s, o) for s, o in sorted(objs.items()) if o in RISKY and s in squads and sit["visible_count"] > 0]
        verdicts: dict = {}
        if risky:
            def assess(agent: Any) -> dict:
                out = {}
                for s, o in risky:
                    near = sum(1 for e in obs["enemies"]["visible"] if dist(where(s), e) <= 18)
                    local = len(squads[s]["members"]) / (near + 1.0)
                    risk = clamp(1.05 - 0.9 * local, 0.0, 1.0)  # ~0.6 (the agent's default threshold) at 2:1 local odds against
                    a = agent.assess_risk(risk, task_type="squad_objective", source_agent=f"risk-squad{s}", context={"objective": o, "local_odds": round(local, 2)})
                    out[s] = (risk, str(getattr(a, "recommended_action", "proceed")))
                return out

            verdicts = self.host.call("collaborative", assess, budget)
            for s, (risk, rec) in verdicts.items():
                # The agent's BayesianRiskModel learns from its own verdicts (high risk -> lower threshold -> more high risk ...), so
                # on its own it drifts to "veto everything". It is therefore a second opinion bounded by a domain floor: both must agree.
                if rec in ("human_review", "halt_and_escalate") and risk >= RISK_FLOOR:
                    objs[s] = RISKY[objs[s]]
                    self.vetoes += 1
                    ctx.notes.append(f"squad {s}: attack vetoed by risk assessment ({rec})")

        # 2) contested roles -> coordinate_tasks
        supply = sorted(s for s, o in objs.items() if o == "ContestSupply")
        harass = sorted(s for s, o in objs.items() if o == "HarassFlank")
        need_escort = bool(sit["danger"] and squads and not any(o == "ProtectMain" for o in objs.values()))
        contested = len(supply) > 1 or len(harass) > 1 or need_escort
        lanes: dict = {}
        if contested and not self.can_coordinate:
            CollaborativeAgent._deconflict(self, ctx, obs, sit)  # domain arbitration (delegation could not be disabled)
            return
        if contested:
            tasks, agents = [], {}
            ranked = lambda target: {s: r for r, s in enumerate(sorted(squads, key=lambda q: dist(where(q), target)))}  # noqa: E731
            claimants = set(supply) | set(harass)
            escorts = [q for q in squads if q not in claimants] or list(squads)  # an escort must not abandon another role
            if len(supply) > 1 and sit["pickup"]:
                rk = ranked(sit["pickup"])
                tasks.append({"task_id": "role-supply", "type": "gangup_role", "name": "contest supply", "priority": 80, "requirements": ["supply"], "estimated_risk": 0.1})
                for s in supply:
                    agents.setdefault(f"squad{s}", {"capabilities": ["combat"], "current_load": rk[s]})["capabilities"].append("supply")
            if len(harass) > 1:
                open_ = sit["lane_open"]
                for lane in ("north", "south"):
                    tasks.append({"task_id": f"role-lane-{lane}", "type": "gangup_role", "name": f"flank {lane}", "priority": int(50 + 40 * open_[lane]), "requirements": ["flank"], "estimated_risk": 0.1})
                for s in harass:
                    agents.setdefault(f"squad{s}", {"capabilities": ["combat"], "current_load": 0})["capabilities"].append("flank")
            if need_escort:
                rk = ranked(sit["me"])
                tasks.append({"task_id": "role-escort", "type": "gangup_role", "name": "escort main", "priority": 100, "requirements": ["escort"], "estimated_risk": 0.1})
                for s in escorts:
                    agents.setdefault(f"squad{s}", {"capabilities": ["combat"], "current_load": rk[s]})["capabilities"].append("escort")
            if tasks:
                res = self.host.call("collaborative", lambda a: a.coordinate_tasks(tasks, agents, constraints={"max_tasks_per_agent": 99}), budget)
                self.arbitrations += 1
                won: dict = {}
                for tid, a in (res.get("assignments") or {}).items():
                    if str(a.get("status", "")).startswith("assigned") and a.get("agent"):
                        won.setdefault(int(str(a["agent"]).replace("squad", "")), []).append(tid)
                taken_roles: set = set()
                if len(supply) > 1:
                    keep = next((s for s, r in won.items() if "role-supply" in r), None)
                    for s in supply:
                        if s != keep:
                            objs[s] = "Hold"
                if len(harass) > 1:
                    for s in harass:
                        lane = next((r.split("-")[-1] for r in won.get(s, []) if r.startswith("role-lane-") and r not in taken_roles), None)
                        if lane is None:
                            objs[s] = "Reposition"
                        else:
                            taken_roles.add(f"role-lane-{lane}")
                            lanes[s] = lane
                if need_escort:
                    esc = next((s for s, r in won.items() if "role-escort" in r), None)
                    if esc is not None:
                        objs[esc] = "ProtectMain"
        # single claimants need no arbitration: they get the domain's preferred lane
        taken = set(lanes.values())
        for s in harass:
            if s not in lanes and objs.get(s) == "HarassFlank":
                lane = choose_lane(sit, taken)
                if lane in taken:
                    objs[s] = "Reposition"
                else:
                    taken.add(lane)
                    lanes[s] = lane
        if sit["danger"] and squads and not any(o == "ProtectMain" for o in objs.values()):  # arbitration produced no escort
            objs[min(squads, key=lambda q: dist(where(q), sit["me"]))] = "ProtectMain"
        standoff: dict = {}
        for n, s in enumerate(sorted(k for k, o in objs.items() if o == "PressTarget")):
            base = 9.0 if any(t["id"] == "outnumbered-hold-standoff" for t in ctx.knowledge) else 5.0 if any(t["id"] == "advantage-close-in" for t in ctx.knowledge) else 6.0
            standoff[s] = base + 1.5 * n
        ctx.flags["lanes"] = lanes
        ctx.flags["standoff"] = standoff


# ====================================================================== Safety
class RealSafety(SafetyAgent):
    """Game-rule legality first (the engine would reject anything else), then the real SafetyAgent judges the order set.

    ``enforcing=False`` (default): the verdict is recorded and reported but orders are not held. Measured on the SLAI checkout the real
    agent returns ``block`` (risk 0.75, the block threshold: a blocker is present) for every game order set, so enforcing it freezes the AI.
    ``enforcing=True`` (``--safety-enforce``): a ``block`` holds fire for that order shape, until 5 blocks in a row make it advisory."""
    ADVISORY_AFTER = 5

    def __init__(self, host: RealAgentHost, caps: dict | None = None, enforcing: bool = False) -> None:
        self.host, self.caps, self.enforcing = host, caps or {}, enforcing
        self.reviews = 0
        self.blocks = 0
        self.consecutive_blocks = 0
        self.last: dict = {}
        self.cache: dict = {}  # structural order signature -> the real verdict (positions and ticks do not change what is being judged)
        self.cache_hits = 0
        self.warm_ms: tuple[float, float] | None = None  # (first call, second call) at start-up
        self.mode = "sync"  # "async" when one review takes longer than a decision can wait (measured at warm-up)
        self.inflight: set = set()
        self.dispatched = 0

    CONTEXT = {"type": "game_action", "source": "gangup.slai", "domain": "strategy_game"}

    @staticmethod
    def signature(digest: dict) -> tuple:
        return tuple(sorted((str(o.get("squad")), str(o.get("command")), str(o.get("doctrine")), str(o.get("formation")), str(o.get("stance")),
                             str(o.get("goal"))) for o in digest["orders"]))

    def _validate(self, digest: dict):
        """Runs inside the host's worker thread; stores the verdict even if the caller has already given up waiting for it."""
        sig = self.signature(digest)

        def job(agent: Any) -> dict:
            try:
                verdict = agent.validate_action(digest, dict(self.CONTEXT))
                if isinstance(verdict, dict) and "decision" in verdict:
                    if len(self.cache) > 256:
                        self.cache.clear()
                    self.cache[sig] = verdict
                return verdict
            finally:
                self.inflight.discard(sig)

        return job

    def warm(self) -> tuple[float, float] | None:
        """The real SafetyAgent runs guard, cyber, reward-model, STPA and constitutional checks and initialises lazily: the first
        call is slow. Pay for it (and measure the steady-state call) before the first decision."""
        if not self.host.usable("safety"):
            return None
        sample = {"action_name": "gangup.tactical_orders", "domain": "strategy_game", "team": 1, "tick": 0,
                  "orders": [{"command": "SetObjective", "squad": 1, "goal": "ContestSupply"}, {"command": "SetStance", "squad": 1, "stance": "Aggressive"}]}
        times = []
        for _ in range(2):
            t0 = time.perf_counter()
            try:
                self.host.call("safety", self._validate(sample), 90.0)
            except Exception:  # noqa: BLE001 - reported through the slot (last error / trace)
                return None
            times.append((time.perf_counter() - t0) * 1000.0)
        self.warm_ms = (times[0], times[1])
        limit = self.caps.get("safety", DEFAULT_BUDGET_MS["safety"])
        # A review that takes longer than a decision may wait cannot gate that decision. It then runs in the background and its
        # verdict applies, from the cache, to every later decision with the same order shape.
        self.mode = "async" if times[1] > 0.6 * limit else "sync"
        return self.warm_ms

    @staticmethod
    def digest(ctx: Context) -> dict:
        orders = []
        for a in ctx.actions[:24]:
            d = {"command": a.get("command"), "squad": a.get("squad")}
            for k in ("doctrine", "formation", "stance", "goal"):
                if k in a:
                    d[k] = a[k]
            if isinstance(a.get("destination"), dict):
                d["destination"] = {"x": round(a["destination"].get("x", 0.0), 1), "y": round(a["destination"].get("y", 0.0), 1)}
            orders.append(d)
        return {"action_name": "gangup.tactical_orders", "domain": "strategy_game", "team": ctx.obs["team"], "tick": ctx.obs["tick"], "orders": orders}

    def run(self, ctx: Context) -> None:
        super().run(ctx)  # legality / authority / visibility / de-duplication / budget
        if not ctx.actions:
            _mark(ctx, "safety", "real" if self.host.usable("safety") else "lite (agent unavailable)")
            return
        budget = _budget(self.host, ctx, "safety", self.caps)
        try:
            digest = self.digest(ctx)
            sig = self.signature(digest)
            verdict = self.cache.get(sig)
            if verdict is not None:
                self.cache_hits += 1  # the real agent already judged an order set of this shape: reuse its verdict
            elif self.mode == "async":
                if not self.host.usable("safety"):
                    raise StageUnavailable("safety: unavailable or circuit open")
                if sig not in self.inflight:
                    self.inflight.add(sig)
                    if self.host.background("safety", self._validate(digest)):
                        self.dispatched += 1
                    else:
                        self.inflight.discard(sig)  # the agent is still busy with another review: this shape is retried next time
                _mark(ctx, "safety", "real (async: review pending)")
                return
            else:
                if budget is None:
                    raise StageTimeout("safety: no time left")
                verdict = self.host.call("safety", self._validate(digest), budget)  # a timed-out call still fills the cache when it ends
            if not isinstance(verdict, dict) or "decision" not in verdict:
                raise ValueError(f"unexpected SafetyAgent result: {str(verdict)[:120]}")
            decision = str(verdict["decision"])
            self.reviews += 1
            md = verdict.get("metadata") if isinstance(verdict.get("metadata"), dict) else {}
            comp = verdict.get("component_risks") if isinstance(verdict.get("component_risks"), dict) else {}
            self.last = {"decision": decision, "risk": verdict.get("risk_score"), "level": verdict.get("risk_level"),
                         "blockers": md.get("blockers") or [], "warnings": md.get("warnings") or [], "degraded": verdict.get("degraded_components") or [],
                         "details": (verdict.get("details") or [])[:3],
                         "componentRisks": {str(k): round(float(v), 3) for k, v in comp.items() if isinstance(v, (int, float))}}
            ctx.flags["safety_real"] = self.last
            if decision == "block":
                self.blocks += 1
                self.consecutive_blocks += 1
                if self.enforcing and self.consecutive_blocks <= self.ADVISORY_AFTER:
                    # hold fire: keep squad organisation/stance (harmless bookkeeping), drop everything else
                    keep = [a for a in ctx.actions if a.get("command") in ("CreateSquad", "SetStance")]
                    ctx.flags.setdefault("rejected", []).extend({"command": a.get("command"), "reason": "real-safety-block"} for a in ctx.actions if a not in keep)
                    ctx.actions = keep
                    ctx.notes.append("SafetyAgent blocked this order set")
                elif self.enforcing:
                    ctx.notes.append(f"SafetyAgent blocked {self.consecutive_blocks} decisions in a row: treated as advisory (check its configuration)")
            else:
                self.consecutive_blocks = 0
            _mark(ctx, "safety", "real")
        except Exception as e:  # noqa: BLE001
            _mark(ctx, "safety", f"lite ({_why(e)})")


# ====================================================================== Evaluation
class RealEvaluation(EvaluationAgent):
    """Outcome attribution stays domain (objective names are GangUP's); the real EvaluationAgent forecasts system health."""
    EVERY = 60  # decisions between health forecasts

    def __init__(self, host: RealAgentHost, caps: dict | None = None) -> None:
        super().__init__()
        self.host = host
        self.n = 0
        self.window = {"ms": 0.0, "rejected": 0, "proposed": 0, "fallback": 0}
        self.last_forecast: dict = {}

    def run(self, ctx: Context) -> None:
        super().run(ctx)
        self.n += 1
        rej = len(ctx.flags.get("rejected", []))
        self.window["rejected"] += rej
        self.window["proposed"] += len(ctx.actions) + rej
        self.window["fallback"] += 1 if ctx.flags.get("fallback") else 0
        if self.n % self.EVERY == 0 and self.host.usable("evaluation"):
            w, self.window = dict(self.window), {"ms": 0.0, "rejected": 0, "proposed": 0, "fallback": 0}
            state = {"agent_performance_metrics": {"rejected_action_ratio": w["rejected"] / max(1, w["proposed"]), "fallback_rate": w["fallback"] / self.EVERY,
                                                   "decisions": self.EVERY}}

            self.host.background("evaluation", self.forecast_job(state))
        _mark(ctx, "evaluation", "real" if self.host.usable("evaluation") else "lite (agent unavailable)")

    def forecast_job(self, state: dict):
        def job(agent: Any) -> Any:
            out = agent.predict(state)
            pred = (out or {}).get("prediction", {}) if isinstance(out, dict) else {}
            self.last_forecast = {"status": (out or {}).get("status"), "confidence": (out or {}).get("confidence"),
                                  "health": (pred.get("health_forecast") or {}).get("status")}
            return out

        return job

    def probe(self, timeout: float = 30.0) -> dict:
        """One forecast, run now and waited for (diagnostics): proves the real EvaluationAgent answers, outside the periodic schedule."""
        state = {"agent_performance_metrics": {"rejected_action_ratio": 0.0, "fallback_rate": 0.0, "decisions": 1}}
        out = self.host.call("evaluation", self.forecast_job(state), timeout)
        return dict(self.last_forecast) or {"status": str(type(out).__name__)}

    def report(self) -> dict:
        r = super().report()
        r["realForecast"] = self.last_forecast
        return r


# ====================================================================== Observability
class RealObservability(ObservabilityAgent):
    """Domain counters stay (they feed /v1/stats); every FLUSH decisions a batch goes to the real ObservabilityAgent."""
    FLUSH = 40  # decisions per batch sent to the real ObservabilityAgent (its report takes hundreds of ms)

    def __init__(self, host: RealAgentHost, telemetry_path: str | None = None, caps: dict | None = None) -> None:
        super().__init__(telemetry_path)
        self.host = host
        self.pending: list = []
        self.sent = 0
        self.last_report: dict = {}

    def record(self, ctx: Context, total_ms: float) -> None:
        super().record(ctx, total_ms)
        rej = len(ctx.flags.get("rejected", []))
        self.pending.append({"ms": total_ms, "timings": dict(ctx.timings), "ok": len(ctx.actions), "rej": rej,
                             "stages": dict(ctx.flags.get("stages", {})), "tick": ctx.obs["tick"], "errors": dict(ctx.errors)})
        if len(self.pending) >= self.FLUSH:
            self.flush()
        if self.host.usable("observability"):
            ctx.flags.setdefault("stages", {})["observability"] = "real"

    def flush(self) -> None:
        if self.pending and self.host.usable("observability"):
            batch, self.pending = self.pending, []
            latencies = [{"subject": "gangup.decision", "duration_ms": b["ms"], "status": "error" if b["errors"] else "ok"} for b in batch]
            for b in batch[-3:]:
                latencies += [{"subject": f"gangup.stage.{k}", "duration_ms": v} for k, v in b["timings"].items()]
            payload = {
                "task_name": "gangup.decide", "agent_name": "gangup.slai", "operation_name": "decide", "service": "gangup-slai",
                "latencies": latencies,
                "throughput": [{"subject": "gangup.orders", "count": sum(b["ok"] + b["rej"] for b in batch), "success_count": sum(b["ok"] for b in batch),
                                "failure_count": sum(b["rej"] for b in batch)}],
                "events": [{"event_type": "gangup.decision.batch", "message": f"{len(batch)} decisions, last tick {batch[-1]['tick']}", "severity": "info",
                            "payload": {"degradedStages": sorted({k for b in batch for k, v in b["stages"].items() if not str(v).startswith('real')})}}],
            }

            def job(agent: Any) -> Any:
                out = agent.perform_task(payload)
                if isinstance(out, dict):
                    self.last_report = {k: out.get(k) for k in ("status", "health", "alerts", "summary") if k in out} or {"keys": sorted(out)[:8]}
                return out

            if self.host.background("observability", job):
                self.sent += 1

    def snapshot(self) -> dict:
        s = super().snapshot()
        s["realBatchesSent"] = self.sent
        s["realLastReport"] = self.last_report
        return s
