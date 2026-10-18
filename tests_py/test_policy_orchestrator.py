import os
import random
import tempfile
import unittest

from slai.agents.perception import build_situation
from slai.features import MAIN_FEATURES, MAIN_OBJECTIVES, SQUAD_FEATURES, SQUAD_OBJECTIVES, main_features, squad_features

NS, NM = len(SQUAD_FEATURES), len(MAIN_FEATURES)
from slai.orchestrator import Orchestrator
from slai.policy import Head, TacticalDecisionPolicy, legal_main_objectives, legal_squad_objectives, softmax
from slai.schema import SchemaError

from .helpers import make_obs


def orch(tmp: str) -> Orchestrator:
    return Orchestrator(adaptive_path=os.path.join(tmp, "adaptive.json"))


class PolicyTests(unittest.TestCase):
    def test_softmax_normalises_and_is_stable(self):
        p = softmax([1000.0, 1001.0, 999.0])
        self.assertAlmostEqual(sum(p), 1.0)
        self.assertEqual(max(range(3), key=lambda i: p[i]), 1)

    def test_feature_vectors_have_declared_width_and_are_finite(self):
        obs = make_obs(squads={1: 5}, enemies=[{"x": 60, "y": 30}])
        sit = build_situation(obs)
        sq = obs["squads"][0]
        xs, xm = squad_features(obs, sit, sq), main_features(obs, sit)
        self.assertEqual(len(xs), NS)
        self.assertEqual(len(xm), NM)
        self.assertTrue(all(abs(v) < 1e6 and v == v for v in xs + xm))

    def test_legal_mask_blocks_unjustified_objectives(self):
        blind = make_obs(squads={1: 4})
        sit = build_situation(blind)
        self.assertNotIn("PressTarget", legal_squad_objectives(blind, sit, blind["squads"][0]))
        self.assertNotIn("Engage", legal_main_objectives(blind, sit))
        self.assertNotIn("Resupply", legal_main_objectives(blind, sit))
        seen = make_obs(squads={1: 4}, enemies=[{"x": 80, "y": 30}], pickup={"x": 50.0, "y": 30.0})
        sit = build_situation(seen)
        self.assertIn("PressTarget", legal_squad_objectives(seen, sit, seen["squads"][0]))
        self.assertIn("Engage", legal_main_objectives(seen, sit))
        self.assertIn("Resupply", legal_main_objectives(seen, sit))

    def test_choice_never_leaves_legal_set_even_with_adversarial_weights(self):
        pol = TacticalDecisionPolicy()
        pol.squad.b["Disengage"] = 1e6  # illegal-in-context winner must be masked out
        legal = {"Hold", "Reposition"}
        obj, _, _ = pol.choose_squad([0.0] * NS, legal)
        self.assertIn(obj, legal)
        with self.assertRaises(ValueError):
            pol.choose_squad([0.0] * NS, set())

    def test_wrong_feature_width_rejected(self):
        with self.assertRaises(ValueError):
            Head(SQUAD_OBJECTIVES, NS).scores([0.0] * 3)

    def test_deterministic_argmax_and_sampling_seeded(self):
        pol = TacticalDecisionPolicy()
        x = [0.1] * NS
        legal = set(SQUAD_OBJECTIVES)
        self.assertEqual(pol.choose_squad(x, legal)[0], pol.choose_squad(x, legal)[0])
        pol.squad.b["Hold"], pol.squad.b["Reposition"] = 0.2, 0.1
        a = [pol.choose_squad(x, legal, temperature=1.0, rng=random.Random(5))[0] for _ in range(5)]
        b = [pol.choose_squad(x, legal, temperature=1.0, rng=random.Random(5))[0] for _ in range(5)]
        self.assertEqual(a, b)

    def test_save_load_roundtrip(self):
        pol = TacticalDecisionPolicy()
        pol.squad.b["Hold"] = 0.75
        pol.main.W["Engage"][3] = -0.5
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "w.json")
            pol.save(p)
            q = TacticalDecisionPolicy.load(p)
        self.assertEqual(q.squad.b["Hold"], 0.75)
        self.assertEqual(q.main.W["Engage"][3], -0.5)

    def test_missing_or_corrupt_weights_fall_back_untrained(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(TacticalDecisionPolicy.load(os.path.join(d, "none.json")).trained)
            bad = os.path.join(d, "bad.json")
            with open(bad, "w") as fh:
                fh.write("{not json")
            self.assertFalse(TacticalDecisionPolicy.load(bad).trained)


class OrchestratorTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.o = orch(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_response_envelope_and_generation_echo(self):
        obs = make_obs(generation=7, squads={1: 5, 2: 4}, enemies=[{"x": 70, "y": 30}])
        r = self.o.decide(obs)
        self.assertEqual(r["schema"], "gangup.act.v1")
        self.assertEqual(r["generation"], 7)
        for a in r["actions"]:
            self.assertEqual(a["generation"], 7)
            self.assertGreater(a["expiresAt"], a["issuedAt"])
        self.assertLessEqual(len(r["actions"]), obs["budget"]["maxActions"])

    def test_no_action_targets_a_hidden_enemy(self):
        obs = make_obs(squads={1: 5}, enemies=[{"x": 70, "y": 30}], lastknown=[{"id": 4242, "x": 60.0, "y": 20.0, "age": 1.0}])
        r = self.o.decide(obs)
        vis = {e["id"] for e in obs["enemies"]["visible"]}
        for a in r["actions"]:
            t = a.get("target")
            if t and t.get("id", -1) >= 0:
                self.assertIn(t["id"], vis)

    def test_dead_main_issues_nothing_destructive(self):
        obs = make_obs(squads={1: 5})
        obs["own"]["main"]["alive"] = False
        r = self.o.decide(obs)
        self.assertFalse([a for a in r["actions"] if a["command"] == "MainGoal"])

    def test_malformed_observation_raises_schema_error(self):
        with self.assertRaises(SchemaError):
            self.o.decide({"schema": "gangup.obs.v1"})

    def test_unassigned_soldiers_get_organised_into_squads(self):
        obs = make_obs(unassigned=8)
        r = self.o.decide(obs)
        self.assertTrue([a for a in r["actions"] if a["command"] == "CreateSquad"])
        for a in r["actions"]:
            if a["command"] == "CreateSquad":
                self.assertLessEqual(len(a["members"]), 10)

    def test_low_hp_with_close_threat_retreats(self):
        obs = make_obs(main_hp=20.0, squads={1: 3}, enemies=[{"x": 85, "y": 30}, {"x": 84, "y": 31}, {"kind": "main", "x": 80, "y": 30, "hp": 90}])
        r = self.o.decide(obs)
        goals = [a for a in r["actions"] if a["command"] == "MainGoal"]
        self.assertTrue(goals)
        self.assertEqual(goals[-1]["goal"], "Retreat")

    def test_latency_is_within_budget(self):
        obs = make_obs(squads={i: 8 for i in range(1, 6)}, enemies=[{"x": 60 + i, "y": 30 + i} for i in range(10)])
        r = self.o.decide(obs)
        self.assertLess(r["meta"]["latencyMs"], obs["budget"]["deadlineMs"])

    def test_stats_snapshot_shape(self):
        self.o.decide(make_obs(squads={1: 3}))
        s = self.o.stats()
        self.assertIn("policy", s)
        self.assertIn("evaluation", s)

    def test_match_end_updates_adaptive_profile_without_crashing(self):
        self.o.decide(make_obs(squads={1: 3}))
        self.o.match_end(42, 1, 1)
        self.assertEqual(self.o.stats()["adaptive"]["matches"], 1)


if __name__ == "__main__":
    unittest.main()
