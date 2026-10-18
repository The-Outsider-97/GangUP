"""Tests for the bridge to the real SLAI agents.

Most tests drive the bridge with *contract fakes*: small objects that implement exactly the public methods the adapters call on
the real agents (``perform_task``, ``add_document``/``retrieve``, ``decompose_task``, ``assess_risk``/``coordinate_tasks``,
``validate_action``, ``predict``) with the result shapes read from ``src/agents``. They prove the bridge's behaviour (what is
asked of each agent, how answers change the decision, time-boxing, circuit breaking, fallback, strict mode) without needing
torch & friends. ``RealCollaborativeObservabilityTests`` additionally runs the genuine CollaborativeAgent and
ObservabilityAgent when a SLAI checkout is reachable (skipped otherwise).
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import types
import typing
import unittest
from unittest import mock

from slai.agents import Context
from slai.agents.perception import build_situation
from slai.bridge import locate
from slai.bridge.adapters import RealSafety
from slai.bridge.host import STAGES, RealAgentHost, StageBusy, StageTimeout, StageUnavailable
from slai.orchestrator import Orchestrator
from slai.schema import COMMANDS

from .helpers import make_obs


# ----------------------------------------------------------------------------------------------- contract fakes
class FakeTensor:
    def __init__(self, v):
        self.v = list(v)

    def detach(self):
        return self

    def cpu(self):
        return self

    def reshape(self, *_):
        return self

    def tolist(self):
        return list(self.v)


class Fake:
    """Base: records calls, can raise or sleep on demand."""

    def __init__(self, fail: str | None = None, delay: float = 0.0):
        self.calls: list = []
        self.fail, self.delay = fail, delay

    def _enter(self, what):
        self.calls.append(what)
        if self.delay:
            time.sleep(self.delay)
        if self.fail:
            raise RuntimeError(self.fail)


class FakeTokenizer:
    """Like the real one without its BPE files: a handful of special tokens, everything else would be [UNK]."""

    def __init__(self):
        self.vocab = {"[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3, "[MASK]": 4}

    def add_tokens(self, tokens, special=False):
        new = [t for t in tokens if t not in self.vocab]
        for t in new:
            self.vocab[t] = len(self.vocab)
        return len(new)


class FakePerception(Fake):
    def __init__(self, **kw):
        super().__init__(**kw)
        self.n = 0
        self.tokenizer = FakeTokenizer()

    def perform_task(self, td):
        self._enter(td)
        self.n += 1
        return {"status": "success", "output": FakeTensor([1.0, 0.0, 0.0 + 0.1 * self.n]), "representation": {}}


class FakeKnowledge(Fake):
    def __init__(self, only=None, **kw):
        super().__init__(**kw)
        self.docs, self.only = {}, only

    def add_document(self, text, doc_id=None, metadata=None):
        self.docs[doc_id] = {"doc_id": doc_id, "text": text, "tokens": text.split(), "metadata": metadata or {}}

    def retrieve(self, query, k=5):
        self._enter(query)
        q = set(query.split())
        out = [(0.5, d) for d in self.docs.values() if q & set(d["tokens"]) and (self.only is None or d["metadata"].get("tactic") in self.only)]
        return out[:k]


class FakeTask:
    def __init__(self, name, task_type, preconditions=None, effects=None, methods=None, duration=1.0, **kw):
        self.name, self.task_type, self.preconditions, self.methods, self.id = name, task_type, preconditions or [], methods or [], name


def fake_planning_module():
    mods = {}
    for n in ("src", "src.agents", "src.agents.planning", "src.agents.planning.planning_types"):
        mods[n] = types.ModuleType(n)
    mods["src.agents.planning.planning_types"].Task = FakeTask
    mods["src.agents.planning.planning_types"].TaskType = types.SimpleNamespace(PRIMITIVE="primitive", ABSTRACT="abstract")
    return mods


class FakePlanner(Fake):
    def __init__(self, infeasible=(), **kw):
        super().__init__(**kw)
        self.library, self.world_state, self.infeasible = {}, {}, set(infeasible)

    def register_task(self, t):
        self.library[t.name] = t

    def decompose_task(self, task, state):
        self._enter(task.name)
        if any(task.name == f"gu_achieve_{o}" for o in self.infeasible):
            return None
        prims = task.methods[0]
        if any(not all(f(state) for f in p.preconditions) for p in prims):
            return None
        return prims


class FakeCollaborative(Fake):
    def __init__(self, recommend="human_review", always=False, **kw):
        super().__init__(**kw)
        self.always = always  # a collapsed adaptive threshold: every assessment recommends review
        self.runtime_config = types.SimpleNamespace(delegate_during_coordination=True)
        self.recommend, self.assessed, self.coordinated = recommend, [], []

    def assess_risk(self, risk_score, task_type="general", source_agent="unknown", context=None):
        self._enter("assess")
        self.assessed.append((risk_score, source_agent, context))
        return types.SimpleNamespace(recommended_action=self.recommend if (self.always or risk_score >= 0.6) else "proceed")

    def coordinate_tasks(self, tasks, available_agents, optimization_goals=None, constraints=None):
        self._enter("coordinate")
        assert self.runtime_config.delegate_during_coordination is False, "delegation must be disabled before coordinating"
        self.coordinated.append((tasks, available_agents))
        out = {}
        used: dict = {}
        for t in sorted(tasks, key=lambda x: -x["priority"]):
            cand = [(m["current_load"] + used.get(n, 0), n) for n, m in available_agents.items() if set(t["requirements"]) <= set(m["capabilities"])]
            if cand:
                _, n = min(cand)
                used[n] = used.get(n, 0) + 1
                out[t["task_id"]] = {"task_id": t["task_id"], "status": "assigned", "agent": n}
            else:
                out[t["task_id"]] = {"task_id": t["task_id"], "status": "unassigned", "agent": None}
        return {"status": "success", "assignments": out}


class FakeSafety(Fake):
    def __init__(self, decision="allow", **kw):
        super().__init__(**kw)
        self.decision = decision

    def validate_action(self, action_params, action_context=None):
        self._enter((action_params, action_context))
        return {"decision": self.decision, "approved": self.decision == "allow", "risk_score": 0.1 if self.decision == "allow" else 0.9, "risk_level": "low"}


class FakeLearning(Fake):
    def perform_task(self, td):
        self._enter(td)
        return {"status": "ok", "mode": "observe", "learning": {"adaptive_guidance": {"g": 1}}}


class FakeEvaluation(Fake):
    def predict(self, state=None):
        self._enter(state)
        return {"status": "success", "confidence": 0.7, "prediction": {"health_forecast": {"status": "normal"}}}


class FakeObservability(Fake):
    def perform_task(self, payload):
        self._enter(payload)
        return {"status": "ok", "health": {"status": "healthy"}}


def make_host(**overrides) -> tuple[RealAgentHost, dict]:
    fakes = {"perception": FakePerception(), "learning": FakeLearning(), "knowledge": FakeKnowledge(), "planning": FakePlanner(),
             "collaborative": FakeCollaborative(), "safety": FakeSafety(), "evaluation": FakeEvaluation(), "observability": FakeObservability()}
    fakes.update(overrides)
    host = RealAgentHost(log=lambda m: None)
    host.started = True
    for n, f in fakes.items():
        host.inject(n, f)
    return host, fakes


def drain(host: RealAgentHost, timeout: float = 3.0) -> None:
    end = time.time() + timeout
    while time.time() < end and any(s.run_lock.locked() for s in host.slots.values()):
        time.sleep(0.01)


def real_orch(tmp: str, host: RealAgentHost, **kw) -> Orchestrator:
    with mock.patch.dict(sys.modules, fake_planning_module()):
        return Orchestrator(agents="real", host=host, adaptive_path=os.path.join(tmp, "adaptive.json"), **kw)


def fight_obs(**kw):
    args = dict(squads={1: 6, 2: 6}, unassigned=4, enemies=[{"x": 66 + i, "y": 26 + 2 * i} for i in range(4)], pickup={"x": 50.0, "y": 30.0})
    args.update(kw)
    return make_obs(**args)


def assert_legal(tc: unittest.TestCase, obs: dict, resp: dict) -> None:
    tc.assertEqual(resp["generation"], obs["generation"])
    for a in resp["actions"]:
        tc.assertIn(a["command"], COMMANDS)
        tc.assertEqual(a["generation"], obs["generation"])


# ----------------------------------------------------------------------------------------------- locating SLAI
class LocateTests(unittest.TestCase):
    def test_find_root_accepts_only_a_real_checkout(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(locate.is_slai_root(d))
            os.makedirs(os.path.join(d, "src", "agents"))
            open(os.path.join(d, "src", "agents", "agent_factory.py"), "w").close()
            self.assertTrue(locate.is_slai_root(d))
            self.assertEqual(locate.find_root(d), os.path.abspath(d))
            with self.assertRaises(FileNotFoundError):
                locate.activate(os.path.join(d, "nope"))

    def test_activate_puts_root_first_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "src", "agents"))
            open(os.path.join(d, "src", "agents", "agent_factory.py"), "w").close()
            saved = list(sys.path)
            try:
                locate.activate(d)
                locate.activate(d)
                self.assertEqual(sys.path[0], os.path.abspath(d))
                self.assertEqual(sys.path.count(os.path.abspath(d)), 1)
            finally:
                sys.path[:] = saved

    def test_missing_checkout_leaves_every_slot_unavailable_with_a_reason(self):
        with mock.patch.object(locate, "find_root", return_value=None):
            host = RealAgentHost(log=lambda m: None).start()
        self.assertIn("could not find the SLAI repository", host.fatal)
        self.assertEqual(host.ready_count(), 0)
        self.assertEqual(set(host.missing()), set(STAGES))


# ----------------------------------------------------------------------------------------------- guarded calls
class HostTests(unittest.TestCase):
    def test_success_is_timed_and_counted(self):
        host, f = make_host()
        self.assertEqual(host.call("learning", lambda a: 7, 1.0), 7)
        v = host.status()["agents"]["learning"]
        self.assertEqual((v["calls"], v["failures"], v["state"]), (1, 0, "ready"))

    def test_repeated_failures_open_the_breaker_and_it_reports_why(self):
        host, f = make_host()

        def boom(_):
            raise ValueError("kaput")

        for _ in range(RealAgentHost.TRIP_AFTER):
            with self.assertRaises(ValueError):
                host.call("safety", boom, 1.0)
        self.assertFalse(host.usable("safety"))
        with self.assertRaises(StageUnavailable):
            host.call("safety", lambda a: 1, 1.0)
        self.assertIn("kaput", host.status()["agents"]["safety"]["lastError"])

    def test_timeout_abandons_the_call_and_blocks_pile_up(self):
        host, f = make_host()
        with self.assertRaises(StageTimeout):
            host.call("planning", lambda a: time.sleep(0.4), 0.05)
        with self.assertRaises(StageBusy):  # the abandoned call still owns the agent
            host.call("planning", lambda a: 1, 0.5)
        drain(host)
        self.assertEqual(host.call("planning", lambda a: 2, 0.5), 2)

    def test_background_never_queues_behind_a_running_call(self):
        host, f = make_host()
        self.assertTrue(host.background("observability", lambda a: time.sleep(0.2)))
        self.assertFalse(host.background("observability", lambda a: None))
        self.assertEqual(host.dropped_background, 1)
        drain(host)

    def test_unavailable_slot_raises_and_disabled_slot_is_reported(self):
        host = RealAgentHost(enabled=("safety",), log=lambda m: None)
        with self.assertRaises(StageUnavailable):
            host.call("perception", lambda a: 1, 1.0)
        self.assertEqual(host.slots["perception"].state, "disabled")


# ----------------------------------------------------------------------------------------------- the adapters
class RealPipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_all_eight_stages_are_served_by_the_real_agents(self):
        host, f = make_host()
        o = real_orch(self.tmp.name, host)
        obs = fight_obs()
        for i in range(3):
            resp = o.decide(dict(obs, tick=obs["tick"] + 30 * i))
        drain(host)
        assert_legal(self, obs, resp)
        meta = resp["meta"]
        self.assertEqual(meta["mode"], "real")
        self.assertEqual({k: v for k, v in meta["stages"].items()}, {s: "real" for s in STAGES})
        self.assertIn("scene", meta)
        sent = f["perception"].calls[-1]  # the last decision's snapshot, described only in words the tokenizer was given
        self.assertEqual(sent["modality"], "text")
        self.assertIn("ratio", sent["input_data"])
        self.assertTrue(set(sent["input_data"].split()) <= set(o.perception.VOCAB), sent["input_data"])
        self.assertTrue(set(o.perception.VOCAB) <= set(f["perception"].tokenizer.vocab))  # nothing would embed as [UNK]
        self.assertTrue(f["knowledge"].docs and all(k.startswith("gangup:") for k in f["knowledge"].docs))
        self.assertTrue(f["planning"].library)
        self.assertTrue(f["safety"].calls)
        self.assertTrue(f["learning"].calls)  # first decision of a match sends a performance signal
        sig = f["learning"].calls[0]["signal"]
        self.assertEqual((f["learning"].calls[0]["mode"], sig["kind"], sig["source_agent"]), ("observe", "performance", "gangup.slai"))

    def test_orchestrator_summary_and_stats_expose_the_real_agents(self):
        host, f = make_host()
        o = real_orch(self.tmp.name, host)
        o.decide(fight_obs())
        s = o.agents_summary()
        self.assertEqual((s["mode"], s["ready"], s["total"], s["missing"]), ("real", 8, 8, []))
        st = o.stats()
        self.assertEqual(st["agentMode"], "real")
        self.assertEqual(st["realAgents"]["agents"]["planning"]["state"], "ready")
        self.assertIn("collaborative", st["realUse"])
        self.assertEqual(Orchestrator(adaptive_path=os.path.join(self.tmp.name, "a.json")).agents_summary()["mode"], "lite")

    def test_knowledge_retrieval_decides_which_tactics_apply(self):
        obs = fight_obs()
        host, f = make_host()
        full = real_orch(self.tmp.name, host).decide(obs)["meta"]["tactics"]
        self.assertGreaterEqual(len(full), 2, "scenario should trigger several tactics")
        keep = full[0]
        host2, f2 = make_host(knowledge=FakeKnowledge(only={keep}))
        o2 = real_orch(self.tmp.name, host2)
        self.assertEqual(o2.decide(obs)["meta"]["tactics"], [keep])
        self.assertEqual(o2.stats()["realUse"]["knowledge"]["applicableButNotRetrieved"], len(full) - 1)

    def test_planner_masks_infeasible_objectives(self):
        obs = fight_obs()
        lite = Orchestrator(adaptive_path=os.path.join(self.tmp.name, "l.json")).decide(obs)["meta"]["objectives"]
        banned = {o for o in set(lite.values()) if o in ("PressTarget", "HarassFlank")}
        if not banned:
            self.skipTest("policy did not choose an attacking objective in this scenario")
        host, f = make_host(planning=FakePlanner(infeasible=banned), collaborative=FakeCollaborative(recommend="proceed"))
        meta = real_orch(self.tmp.name, host).decide(obs)["meta"]
        self.assertFalse(banned & set(meta["objectives"].values()), meta["objectives"])
        self.assertGreater(meta["htnMasked"], 0)
        self.assertEqual(meta["stages"]["planning"], "real")

    def test_planner_facts_follow_the_situation(self):
        from slai.bridge.adapters import RealPlanning

        blind = RealPlanning.facts(build_situation(make_obs(squads={1: 4})))
        self.assertEqual((blind["enemy_visible"], blind["enemy_known"], blind["pickup_open"]), (False, False, False))
        seen = RealPlanning.facts(build_situation(fight_obs()))
        self.assertTrue(seen["enemy_visible"] and seen["pickup_open"])

    def test_collaborative_vetoes_reckless_attacks_and_arbitrates_roles(self):
        host, f = make_host()
        o = real_orch(self.tmp.name, host)
        self.assertFalse(f["collaborative"].runtime_config.delegate_during_coordination, "delegation must be switched off at start-up")
        obs = fight_obs(enemies=[{"x": 80 + i * 0.4, "y": 26 + i * 0.3} for i in range(24)])
        sit = build_situation(obs)
        # reckless attack against ~24 enemies -> real risk assessment says human_review -> demoted
        ctx = Context(obs=obs, deadline=time.monotonic() + 5)
        ctx.situation = sit
        ctx.objectives = {1: "PressTarget", 2: "HarassFlank"}
        o.collaborative._deconflict(ctx, obs, sit)
        self.assertEqual(ctx.objectives[1], "Hold")
        self.assertIn(ctx.objectives[2], ("Reposition", "ProtectMain"))  # demoted; with the Main in danger it may then be sent to escort
        self.assertEqual(len(f["collaborative"].assessed), 2)
        self.assertEqual(o.collaborative.vetoes, 2)
        # two squads claim the supply and two the flanks: coordinate_tasks arbitrates
        calm = fight_obs(enemies=[{"x": 40, "y": 30}])
        sit = build_situation(calm)
        sit["danger"] = False
        ctx = Context(obs=calm, deadline=time.monotonic() + 5)
        ctx.situation = sit
        ctx.objectives = {1: "ContestSupply", 2: "ContestSupply"}
        f["collaborative"].recommend = "proceed"
        o.collaborative._deconflict(ctx, calm, sit)
        self.assertEqual(sorted(ctx.objectives.values()), ["ContestSupply", "Hold"])
        self.assertEqual(f["collaborative"].coordinated[-1][0][0]["task_id"], "role-supply")
        ctx.objectives = {1: "HarassFlank", 2: "HarassFlank"}
        o.collaborative._deconflict(ctx, calm, sit)
        self.assertEqual(ctx.objectives, {1: "HarassFlank", 2: "HarassFlank"})
        self.assertEqual(sorted(ctx.flags["lanes"].values()), ["north", "south"])

    def test_a_collapsed_agent_threshold_cannot_veto_a_fair_fight(self):
        host, f = make_host(collaborative=FakeCollaborative(always=True))
        o = real_orch(self.tmp.name, host)
        fair = fight_obs(enemies=[{"x": 70, "y": 30}, {"x": 71, "y": 31}])
        sit = build_situation(fair)
        ctx = Context(obs=fair, deadline=time.monotonic() + 5)
        ctx.situation = sit
        ctx.objectives = {1: "PressTarget", 2: "HarassFlank"}
        o.collaborative._deconflict(ctx, fair, sit)
        self.assertEqual(ctx.objectives, {1: "PressTarget", 2: "HarassFlank"})
        self.assertEqual(len(f["collaborative"].assessed), 2)  # it was consulted, it just cannot overrule the floor

    def test_collaborative_without_delegation_control_falls_back_to_domain_rules(self):
        class Frozen:  # a config object whose flag cannot be changed
            __slots__ = ()
            delegate_during_coordination = True

        fake = FakeCollaborative(recommend="proceed")
        fake.runtime_config = Frozen()
        host, f = make_host(collaborative=fake)
        o = real_orch(self.tmp.name, host)
        self.assertFalse(o.collaborative.can_coordinate)
        calm = fight_obs(enemies=[{"x": 40, "y": 30}])
        sit = build_situation(calm)
        ctx = Context(obs=calm, deadline=time.monotonic() + 5)
        ctx.situation = sit
        ctx.objectives = {1: "ContestSupply", 2: "ContestSupply"}
        o.collaborative._deconflict(ctx, calm, sit)
        self.assertEqual(fake.coordinated, [])  # never asked to coordinate
        self.assertEqual(sorted(ctx.objectives.values()), ["ContestSupply", "Hold"])  # domain rule still de-conflicted

    def test_safety_block_holds_fire_but_keeps_bookkeeping_then_turns_advisory(self):
        obs = fight_obs()
        host, f = make_host(safety=FakeSafety(decision="block"))
        o = real_orch(self.tmp.name, host, safety_enforcing=True)
        resp = o.decide(obs)
        cmds = {a["command"] for a in resp["actions"]}
        self.assertTrue(cmds <= {"CreateSquad", "SetStance"}, cmds)
        self.assertGreater(resp["meta"]["rejectedBySafety"], 0)
        self.assertEqual(resp["meta"]["safetyVerdict"]["decision"], "block")
        for _ in range(RealSafety.ADVISORY_AFTER + 1):  # persistent blocking is treated as mis-calibration, not as a reason to freeze the AI
            resp = o.decide(obs)
        self.assertTrue(any(a["command"] not in ("CreateSquad", "SetStance") for a in resp["actions"]))
        self.assertTrue(any("advisory" in n for n in resp["meta"]["notes"]))
        allow_host, _ = make_host(safety=FakeSafety(decision="allow"))
        resp = real_orch(self.tmp.name, allow_host).decide(obs)
        self.assertTrue(any(a["command"] not in ("CreateSquad", "SetStance") for a in resp["actions"]))

    def test_safety_verdicts_are_recorded_but_not_enforced_by_default(self):
        host, f = make_host(safety=FakeSafety(decision="block"))
        o = real_orch(self.tmp.name, host)
        self.assertFalse(o.safety.enforcing)
        resp = o.decide(fight_obs())
        self.assertTrue(any(a["command"] not in ("CreateSquad", "SetStance") for a in resp["actions"]))
        self.assertEqual(resp["meta"]["safetyVerdict"]["decision"], "block")
        self.assertEqual(resp["meta"]["stages"]["safety"], "real")
        self.assertEqual(o.stats()["realUse"]["safety"]["blocks"], 1)

    def test_safety_verdict_keeps_the_reasons_the_agent_gave(self):
        class Reasoned(FakeSafety):
            def validate_action(self, action_params, action_context=None):
                out = super().validate_action(action_params, action_context)
                out.update(metadata={"blockers": ["cyber_safety_degraded"], "warnings": ["w"]}, degraded_components=["cyber_safety"],
                           component_risks={"cyber_safety": 0.9, "constitutional": 0.0}, details=["Cyber risk exceeds the configured action threshold."])
                return out

        host, f = make_host(safety=Reasoned(decision="block"))
        o = real_orch(self.tmp.name, host)
        o.decide(fight_obs())
        last = o.safety.last
        self.assertEqual((last["blockers"], last["degraded"]), (["cyber_safety_degraded"], ["cyber_safety"]))
        self.assertEqual(last["componentRisks"]["cyber_safety"], 0.9)

    def test_every_stage_failure_falls_back_to_a_legal_decision_and_says_why(self):
        sync_stages = {"perception": FakePerception, "knowledge": FakeKnowledge, "planning": FakePlanner, "safety": FakeSafety}
        for name, cls in sync_stages.items():
            with self.subTest(stage=name):
                host, f = make_host(**{name: cls(fail="induced failure")})
                o = real_orch(self.tmp.name, host)
                obs = fight_obs()
                resp = o.decide(obs)
                assert_legal(self, obs, resp)
                self.assertTrue(resp["meta"]["stages"][name].startswith("lite"), resp["meta"]["stages"])
                self.assertIn("induced failure", resp["meta"]["stages"][name])
                self.assertEqual(resp["meta"]["errors"], {})
        host, f = make_host(collaborative=FakeCollaborative(fail="induced failure"))
        obs = fight_obs(enemies=[{"x": 80 + i, "y": 26 + i} for i in range(14)])
        resp = real_orch(self.tmp.name, host).decide(obs)
        assert_legal(self, obs, resp)

    def test_background_agents_failing_never_touches_the_decision(self):
        host, f = make_host(learning=FakeLearning(fail="x"), evaluation=FakeEvaluation(fail="x"), observability=FakeObservability(fail="x"))
        o = real_orch(self.tmp.name, host)
        obs = fight_obs()
        for i in range(70):
            resp = o.decide(dict(obs, tick=obs["tick"] + i))
        drain(host)
        assert_legal(self, obs, resp)
        st = host.status()["agents"]
        self.assertGreater(st["learning"]["failures"], 0)
        self.assertGreater(st["observability"]["failures"], 0)

    def test_slow_agent_is_time_boxed_and_not_called_again_while_busy(self):
        host, f = make_host(perception=FakePerception(delay=0.4))
        o = real_orch(self.tmp.name, host, budgets={"perception": 40})
        obs = fight_obs()
        t0 = time.perf_counter()
        seen = []
        for i in range(5):
            seen.append(o.decide(dict(obs, tick=obs["tick"] + i))["meta"]["stages"]["perception"])
        self.assertLess(time.perf_counter() - t0, 1.2, "decisions must not wait for the slow agent")
        self.assertTrue(all(s.startswith("lite") for s in seen), seen)
        self.assertTrue(any("busy" in s or "circuit open" in s for s in seen), seen)
        drain(host)

    def test_outcome_signal_is_sent_at_match_end(self):
        host, f = make_host()
        o = real_orch(self.tmp.name, host)
        o.decide(fight_obs())
        out = o.match_end(42, 1, 1)
        drain(host)
        self.assertEqual(out["reward"], 1.0)
        sig = f["learning"].calls[-1]["signal"]
        self.assertEqual((sig["kind"], sig["metric"], sig["value"], sig["validated"]), ("outcome", "match_result", 1.0, True))

    def test_observability_batches_decisions_into_one_real_call(self):
        host, f = make_host()
        o = real_orch(self.tmp.name, host)
        obs = fight_obs()
        for i in range(40):
            o.decide(dict(obs, tick=obs["tick"] + i))
        drain(host)
        calls = f["observability"].calls
        self.assertEqual(len(calls), 1)
        p = calls[0]
        self.assertEqual((p["task_name"], p["agent_name"], p["operation_name"]), ("gangup.decide", "gangup.slai", "decide"))
        self.assertTrue(p["latencies"] and p["throughput"] and p["events"])

    def test_strict_mode_refuses_to_start_without_all_agents(self):
        host = RealAgentHost(log=lambda m: None)
        host.started = True
        for n in STAGES:
            if n != "safety":
                host.inject(n, Fake())
        host.slots["safety"].state, host.slots["safety"].error = "unavailable", "ImportError: torch"
        with self.assertRaises(RuntimeError) as cm:
            real_orch(self.tmp.name, host, strict=True)
        self.assertIn("safety", str(cm.exception))
        self.assertIn("torch", str(cm.exception))

    def test_lite_mode_does_not_need_the_bridge(self):
        o = Orchestrator(adaptive_path=os.path.join(self.tmp.name, "a.json"))
        self.assertEqual(o.mode, "lite")
        self.assertEqual(o.decide(make_obs(squads={1: 5}, enemies=[{"x": 60, "y": 30}]))["meta"]["mode"], "lite")


# ----------------------------------------------------------------------------------------------- the genuine agents
class CompatTests(unittest.TestCase):
    """Defects found in the SLAI checkout by the first run on a real machine (see slai/bridge/compat.py)."""

    @staticmethod
    def broken_modules():
        class Own:  # stands in for planning_types.Any (SLAI's own class)
            pass

        tok = types.ModuleType("src.agents.base.modules.base_tokenizer")  # uses Literal without importing it
        ptypes = types.ModuleType("src.agents.planning.planning_types")
        ptypes.Any = Own
        pagent = types.ModuleType("src.agents.planning_agent")
        pagent.Any = typing.Any  # replaced by `from planning_errors import *`
        return Own, tok, pagent, {"src.agents.base.modules.base_tokenizer": tok, "src.agents.planning.planning_types": ptypes,
                                  "src.agents.planning_agent": pagent}

    def test_missing_literal_and_shadowed_any_are_repaired_in_memory_once(self):
        from slai.bridge import compat

        Own, tok, pagent, mods = self.broken_modules()
        with mock.patch.dict(sys.modules, mods):
            with self.assertRaises(TypeError):
                isinstance(1, pagent.Any)  # the failure the user saw: "typing.Any cannot be used with isinstance()"
            done = compat.apply()
            self.assertEqual(len(done), 2, done)
            self.assertIs(tok.Literal, typing.Literal)
            self.assertIs(pagent.Any, Own)
            self.assertFalse(isinstance(1, pagent.Any))
            self.assertTrue(isinstance(Own(), pagent.Any))
            self.assertEqual(compat.apply(), [])  # idempotent

    def test_bpe_that_folds_a_word_into_one_symbol_no_longer_crashes(self):
        from slai.bridge import compat

        class BytePairEncoder:  # SLAI's implementation, reproduced: loops min(pairs) without a single-symbol guard
            def __init__(self, merges, word_to_id=None, unk_token="[UNK]"):
                self.bpe_ranks = {tuple(m): i for i, m in enumerate(merges)}
                self.cache, self.word_to_id, self.unk_token = {}, word_to_id or {}, unk_token

            @staticmethod
            def get_pairs(word):
                return {(a, b) for a, b in zip(word, word[1:])}

            def bpe(self, token):
                word = tuple(token) + ("</w>",)
                pairs = self.get_pairs(word)
                while True:
                    bigram = min(pairs, key=lambda p: self.bpe_ranks.get(p, float("inf")))  # ValueError once word is one symbol
                    if bigram not in self.bpe_ranks:
                        break
                    first, second = bigram
                    new, i = [], 0
                    while i < len(word):
                        if i < len(word) - 1 and word[i] == first and word[i + 1] == second:
                            new.append(first + second)
                            i += 2
                        else:
                            new.append(word[i])
                            i += 1
                    word = tuple(new)
                    pairs = self.get_pairs(word)
                return list(word)

        mod = types.ModuleType("src.agents.perception.modules.tokenizer")
        mod.BytePairEncoder = BytePairEncoder
        with mock.patch.dict(sys.modules, {"src.agents.perception.modules.tokenizer": mod}):
            with self.assertRaises(ValueError):
                BytePairEncoder([("a", "b"), ("ab", "</w>")]).bpe("ab")
            done = compat.apply()
            self.assertEqual(len(done), 1, done)
            enc = BytePairEncoder([("a", "b"), ("ab", "</w>"), ("c", "d")])
            self.assertEqual(enc.bpe("ab"), ["ab</w>"])          # folded into a single end-of-word symbol, as the merges say
            self.assertEqual(enc.bpe("abcd"), ["ab", "cd"])       # unmerged tail: the sentinel is dropped as before
            self.assertEqual(enc.bpe("x"), ["x"])
            self.assertEqual(enc.bpe(""), ["[UNK]"])
            self.assertEqual(compat.apply(), [])                  # idempotent

    def test_healthy_or_absent_modules_are_left_alone(self):
        from slai.bridge import compat

        Own, tok, pagent, mods = self.broken_modules()
        tok.Literal, pagent.Any = typing.Literal, Own
        with mock.patch.dict(sys.modules, mods):
            self.assertEqual(compat.apply(), [])
        with mock.patch.dict(sys.modules, {k: None for k in mods}):  # not imported at all
            self.assertEqual(compat.apply(), [])

    def test_host_repairs_modules_as_each_agent_loads_and_reports_it(self):
        Own, tok, pagent, mods = self.broken_modules()

        class Factory:
            def create(self, name, **kw):
                return FakeSafety()

        host = RealAgentHost(log=lambda m: None, enabled=("safety",))
        host.factory = Factory()
        with mock.patch.dict(sys.modules, mods):
            host._load(host.slots["safety"])
        self.assertEqual(host.slots["safety"].state, "ready")
        self.assertEqual(len(host.compat), 2)
        self.assertEqual(host.status()["compat"], host.compat)
        self.assertIs(pagent.Any, Own)


class WarmupAndSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_first_calls_are_paid_at_start_up_not_in_a_decision(self):
        host, f = make_host()
        o = real_orch(self.tmp.name, host)
        self.assertEqual(set(o.warm_ms), {"collaborative", "knowledge", "planning", "perception", "safety"})
        self.assertTrue(all(v is not None for v in o.warm_ms.values()), o.warm_ms)
        self.assertEqual(len(f["perception"].calls), 2)  # first inference, then the steady-state one that is measured
        self.assertEqual(o.perception.vocab_seeded, len(o.perception.VOCAB))
        self.assertGreater(o.perception.steady_ms, 0.0)
        self.assertEqual(len(f["safety"].calls), 2)  # first call, then the steady-state call that is measured
        self.assertEqual(len(o.safety.warm_ms), 2)

    def test_a_failing_warm_up_does_not_stop_the_server_and_the_stage_falls_back(self):
        host, f = make_host(perception=FakePerception(fail="no tokenizer"), safety=FakeSafety(fail="no model"))
        o = real_orch(self.tmp.name, host)
        self.assertIsNone(o.warm_ms["perception"])
        self.assertIsNone(o.warm_ms["safety"])
        obs = fight_obs()
        resp = o.decide(obs)
        assert_legal(self, obs, resp)
        self.assertIn("no tokenizer", resp["meta"]["stages"]["perception"])
        self.assertIn("no model", host.slots["safety"].last_trace)  # the traceback is kept for the diagnostics

    def test_a_verdict_is_reused_for_the_same_order_shape(self):
        host, f = make_host()
        o = real_orch(self.tmp.name, host)
        obs = fight_obs()
        o.decide(obs)
        n = len(f["safety"].calls)
        resp = o.decide(dict(obs, tick=obs["tick"] + 30))
        self.assertEqual(len(f["safety"].calls), n)
        self.assertGreaterEqual(o.safety.cache_hits, 1)
        self.assertEqual(resp["meta"]["stages"]["safety"], "real")
        self.assertEqual(o.stats()["realUse"]["safety"]["cacheHits"], o.safety.cache_hits)

    def test_a_review_slower_than_a_decision_runs_in_the_background_and_its_verdict_applies_later(self):
        host, f = make_host(safety=FakeSafety(delay=0.35))  # the real SafetyAgent needs seconds per review
        o = real_orch(self.tmp.name, host, budgets={"safety": 50})
        self.assertEqual(o.safety.mode, "async")  # measured at warm-up: 350 ms > 60 % of the 50 ms budget
        obs = fight_obs()
        t0 = time.perf_counter()
        first = o.decide(obs)
        self.assertLess(time.perf_counter() - t0, 0.3)  # the decision did not wait for the review
        self.assertEqual(first["meta"]["stages"]["safety"], "real (async: review pending)")
        drain(host)
        self.assertEqual(o.safety.dispatched, 1)
        second = o.decide(dict(obs, tick=obs["tick"] + 30))
        self.assertEqual(second["meta"]["stages"]["safety"], "real")
        self.assertGreaterEqual(o.safety.cache_hits, 1)

    def test_a_late_block_verdict_holds_fire_for_that_order_shape(self):
        host, f = make_host(safety=FakeSafety(decision="block", delay=0.3))
        o = real_orch(self.tmp.name, host, budgets={"safety": 50}, safety_enforcing=True)
        obs = fight_obs()
        first = o.decide(obs)
        self.assertTrue(any(a["command"] not in ("CreateSquad", "SetStance") for a in first["actions"]))  # not judged yet: legal orders go out
        drain(host)
        second = o.decide(dict(obs, tick=obs["tick"] + 30))
        self.assertTrue({a["command"] for a in second["actions"]} <= {"CreateSquad", "SetStance"})
        self.assertEqual(second["meta"]["safetyVerdict"]["decision"], "block")

    def test_a_fast_review_still_gates_the_decision_synchronously(self):
        host, f = make_host()
        o = real_orch(self.tmp.name, host)
        self.assertEqual(o.safety.mode, "sync")
        resp = o.decide(fight_obs())
        self.assertEqual(resp["meta"]["stages"]["safety"], "real")
        self.assertEqual(o.safety.dispatched, 0)

    def test_an_unavailable_agent_in_async_mode_reports_the_fallback(self):
        host, f = make_host(safety=FakeSafety(delay=0.3))
        o = real_orch(self.tmp.name, host, budgets={"safety": 50})
        host.slots["safety"].state = "unavailable"
        resp = o.decide(fight_obs())
        self.assertTrue(resp["meta"]["stages"]["safety"].startswith("lite"), resp["meta"]["stages"])

    def test_evaluation_probe_gets_a_real_forecast_on_demand(self):
        host, f = make_host()
        o = real_orch(self.tmp.name, host)
        self.assertEqual(f["evaluation"].calls, [])
        out = o.evaluation.probe()
        self.assertEqual(out["health"], "normal")
        self.assertEqual(len(f["evaluation"].calls), 1)
        self.assertEqual(host.slots["evaluation"].calls, 1)


def _real_host(enabled):
    root = locate.find_root()
    if not root:
        raise unittest.SkipTest("no SLAI checkout reachable")
    cwd = os.getcwd()
    try:
        from slai.bridge import GANGUP_AGENT_CONFIG

        host = RealAgentHost(enabled=enabled, agent_config=GANGUP_AGENT_CONFIG, log=lambda m: None, chdir=False).start()
    finally:
        os.chdir(cwd)
    if host.missing():
        raise unittest.SkipTest("real agents unavailable here: " + "; ".join(f"{n}: {host.slots[n].error}" for n in host.missing()))
    return host


class RealCollaborativeObservabilityTests(unittest.TestCase):
    """The genuine CollaborativeAgent and ObservabilityAgent from <SLAI>/src/agents (dependency-light)."""

    @classmethod
    def setUpClass(cls):
        cls.host = _real_host(("collaborative", "observability"))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.o = Orchestrator(agents="real", host=self.host, adaptive_path=os.path.join(self.tmp.name, "a.json"))

    def test_delegation_is_disabled_so_coordination_cannot_run_foreign_tasks(self):
        self.assertFalse(self.host.instance("collaborative").runtime_config.delegate_during_coordination)

    def test_genuine_risk_assessment_vetoes_a_hopeless_attack_but_not_a_fair_one(self):
        hopeless = fight_obs(enemies=[{"x": 80 + i * 0.4, "y": 26 + i * 0.3} for i in range(28)])
        sit = build_situation(hopeless)
        ctx = Context(obs=hopeless, deadline=time.monotonic() + 5)
        ctx.situation = sit
        ctx.objectives = {1: "PressTarget"}
        self.o.collaborative._deconflict(ctx, hopeless, sit)
        self.assertEqual(ctx.objectives[1], "Hold")
        self.assertEqual(ctx.flags["stages"]["collaborative"], "real")
        fair = fight_obs(enemies=[{"x": 70, "y": 30}, {"x": 71, "y": 31}])
        sit = build_situation(fair)
        ctx = Context(obs=fair, deadline=time.monotonic() + 5)
        ctx.situation = sit
        ctx.objectives = {1: "PressTarget"}
        self.o.collaborative._deconflict(ctx, fair, sit)
        self.assertEqual(ctx.objectives[1], "PressTarget")

    def test_genuine_risk_model_drift_cannot_make_the_ai_passive(self):
        agent = self.host.instance("collaborative")
        for _ in range(120):  # drive the agent's own adaptive threshold to its floor
            agent.assess_risk(0.9, task_type="squad_objective", source_agent="risk-squad1", context={})
        fair = fight_obs(enemies=[{"x": 70, "y": 30}, {"x": 71, "y": 31}])
        sit = build_situation(fair)
        ctx = Context(obs=fair, deadline=time.monotonic() + 5)
        ctx.situation = sit
        ctx.objectives = {1: "PressTarget"}
        self.o.collaborative._deconflict(ctx, fair, sit)
        self.assertEqual(ctx.objectives[1], "PressTarget")

    def test_genuine_coordinate_tasks_gives_the_supply_to_the_nearest_squad(self):
        obs = fight_obs(enemies=[{"x": 40, "y": 30}])
        sit = build_situation(obs)
        sit["danger"] = False
        ctx = Context(obs=obs, deadline=time.monotonic() + 5)
        ctx.situation = sit
        ctx.objectives = {1: "ContestSupply", 2: "ContestSupply"}
        self.o.collaborative._deconflict(ctx, obs, sit)
        self.assertEqual(sorted(ctx.objectives.values()), ["ContestSupply", "Hold"])
        self.assertEqual(ctx.flags["stages"]["collaborative"], "real")
        self.assertGreaterEqual(self.o.collaborative.arbitrations, 1)

    def test_full_decisions_with_the_genuine_agents_are_legal_and_batched_to_observability(self):
        obs = fight_obs()
        for i in range(41):
            resp = self.o.decide(dict(obs, tick=obs["tick"] + i))
        drain(self.host, 10.0)
        assert_legal(self, obs, resp)
        self.assertEqual(resp["meta"]["stages"]["collaborative"], "real")
        self.assertEqual(resp["meta"]["stages"]["observability"], "real")
        self.assertGreaterEqual(self.host.status()["agents"]["observability"]["calls"], 1)
        self.assertEqual(self.host.status()["agents"]["observability"]["failures"], 0)


if __name__ == "__main__":
    unittest.main()
