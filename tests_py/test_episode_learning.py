"""Episode identity, idempotent learning, acknowledged signal delivery, main-bias learning, stance hysteresis."""
from __future__ import annotations

import json
import os
import tempfile
import unittest

from slai.agents.planning import STANCE_MIN_DWELL, PlanningAgent, decide_stance
from slai.orchestrator import Orchestrator
from slai.policy import TacticalDecisionPolicy
from slai.schema import SchemaError, episode_key, validate_observation

from .helpers import make_obs
from .test_bridge import drain, fight_obs, make_host, real_orch


def sit(**kw):
    base = {"danger": False, "own_n": 12, "visible_count": 3, "ratio": 1.0}
    base.update(kw)
    return base


class StanceHysteresisTests(unittest.TestCase):
    def test_plain_rule_is_unchanged_without_context(self):
        self.assertEqual(decide_stance(sit()), "offensive")
        self.assertEqual(decide_stance(sit(ratio=0.3)), "defensive")
        self.assertEqual(decide_stance(sit(own_n=4)), "defensive")
        self.assertEqual(decide_stance(sit(danger=True)), "defensive")

    def test_danger_overrides_the_dwell_time(self):
        self.assertEqual(decide_stance(sit(danger=True), "offensive", 0), "defensive")

    def test_dwell_time_holds_the_current_stance(self):
        self.assertEqual(decide_stance(sit(ratio=0.3), "offensive", STANCE_MIN_DWELL - 1), "offensive")
        self.assertEqual(decide_stance(sit(ratio=0.3), "offensive", STANCE_MIN_DWELL), "defensive")

    def test_return_to_offensive_needs_a_margin(self):
        self.assertEqual(decide_stance(sit(ratio=0.45), "defensive", 999), "defensive")  # inside the band
        self.assertEqual(decide_stance(sit(ratio=0.6), "defensive", 999), "offensive")
        self.assertEqual(decide_stance(sit(own_n=5, ratio=1.0), "defensive", 999), "defensive")  # needs one soldier more than the trigger

    def test_borderline_ratio_does_not_flip_every_decision(self):
        pa = PlanningAgent(TacticalDecisionPolicy.load(os.path.join("slai", "data", "weights.json")))
        stance, switches = "offensive", 0
        for i in range(40):  # a decision every second; the ratio oscillates around the old threshold
            ratio = 0.35 if i % 2 == 0 else 0.45
            obs = make_obs(tick=600 + i * 60)
            obs["own"]["stance"] = stance
            new = pa._stance(obs, sit(ratio=ratio))
            switches += new != stance
            stance = new
        self.assertLessEqual(switches, 2, switches)


class EpisodeLearningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "adaptive.json")
        self.o = Orchestrator(adaptive_path=self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def play(self, episode=None, seed=42, team=1, n=4):
        resp = None
        for i in range(n):
            obs = make_obs(seed=seed, team=team, squads={1: 4, 2: 4}, tick=600 + i * 60, enemies=[{"x": 70, "y": 30}])
            if episode:
                obs["episode"] = episode
            resp = self.o.decide(obs)
        return resp

    def test_episode_field_is_validated(self):
        obs = make_obs()
        for bad in ("", 5, "x" * 65):
            with self.assertRaises(SchemaError):
                validate_observation(dict(obs, episode=bad))
        validate_observation(dict(obs, episode="abc"))
        self.assertEqual(episode_key(dict(obs, episode="abc")), ("abc", 1))
        self.assertEqual(episode_key(obs), (42, 1))

    def test_decision_id_names_the_episode_and_tick(self):
        r = self.play("ep-1", n=1)
        self.assertEqual(r["meta"]["decisionId"], "ep-1:1:600:1")

    def test_a_retried_match_end_is_learned_once(self):
        self.play("ep-1")
        a = self.o.match_end(42, 1, 1, "ep-1")
        b = self.o.match_end(42, 1, 1, "ep-1")
        self.assertNotIn("duplicate", a)
        self.assertTrue(b["duplicate"])
        self.assertEqual(self.o.stats()["adaptive"]["matches"], 1)
        self.assertEqual(self.o.stats()["adaptive"]["wins"], 1)

    def test_idempotency_survives_a_restart(self):
        self.play("ep-1")
        self.o.match_end(42, 1, 1, "ep-1")
        again = Orchestrator(adaptive_path=self.path)
        self.assertTrue(again.match_end(42, 1, 1, "ep-1")["duplicate"])
        self.assertEqual(again.stats()["adaptive"]["matches"], 1)

    def test_both_teams_of_one_episode_are_separate_results(self):
        self.play("ep-2", team=0)
        self.play("ep-2", team=1)
        self.o.match_end(42, 0, 1, "ep-2")
        out = self.o.match_end(42, 1, 1, "ep-2")
        self.assertNotIn("duplicate", out)
        self.assertEqual(self.o.stats()["adaptive"]["matches"], 2)

    def test_same_seed_in_two_games_does_not_share_state(self):
        self.play("ep-a", seed=7)
        self.play("ep-b", seed=7)
        self.assertEqual(len(self.o.learning.usage), 2)
        self.o.match_end(7, 1, 1, "ep-a")
        self.assertEqual(len(self.o.learning.usage), 1)  # the other game is untouched

    def test_without_an_episode_only_a_played_game_counts_and_only_once(self):
        self.assertIn("ignored", self.o.match_end(99, 1, 1))  # nothing was played for this seed
        self.play(None, seed=99)
        self.assertNotIn("ignored", self.o.match_end(99, 1, 1))
        self.assertIn("ignored", self.o.match_end(99, 1, 1))
        self.assertEqual(self.o.stats()["adaptive"]["matches"], 1)

    def test_main_objective_bias_is_learned_too(self):
        r = self.play("ep-m", n=6)
        used = r["meta"]["mainObjective"]
        before = dict(self.o.learning.profile["main_bias"])
        self.o.match_end(42, 1, 1, "ep-m")
        after = self.o.learning.profile["main_bias"]
        self.assertGreater(after[used], before[used])
        self.assertTrue(any(after[k] < before[k] for k in after if k != used))

    def test_a_loss_moves_away_from_the_objectives_used(self):
        r = self.play("ep-l", n=6)
        used = r["meta"]["mainObjective"]
        self.o.match_end(42, 1, 0, "ep-l")
        self.assertLess(self.o.learning.profile["main_bias"][used], 0)

    def test_profile_is_persisted_with_processed_episodes(self):
        self.play("ep-p")
        self.o.match_end(42, 1, None, "ep-p")
        with open(self.path, encoding="utf-8") as f:
            d = json.load(f)
        self.assertEqual(d["episodes"], ["ep-p:1"])
        self.assertEqual(d["draws"], 1)

    def test_abandoned_games_are_evicted(self):
        for i in range(60):
            obs = make_obs(seed=i)
            self.o.decide(obs)
        self.assertLessEqual(len(self.o.learning.usage), 32)
        self.assertLessEqual(len(self.o.learning.live), 32)


class AcknowledgedDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.host, self.f = make_host()
        self.o = real_orch(self.tmp.name, self.host)

    def tearDown(self):
        self.tmp.cleanup()

    def play(self, episode="ep-1"):
        obs = dict(fight_obs(), episode=episode)
        self.o.decide(obs)
        drain(self.host)

    def test_outcome_is_acknowledged_and_persisted(self):
        self.play()
        out = self.o.match_end(42, 1, 1, "ep-1")
        c = out["realLearning"]
        self.assertEqual(out["delivery"], "acked")
        self.assertEqual((c["acked"], c["failed"], c["pending"]), (c["submitted"], 0, 0))
        mem = self.f["learning"].learning_factory.learning_memory
        self.assertEqual(len(mem.saved), 1)
        self.assertTrue(mem.saved[0].endswith("learning_memory.pt"))
        sig = self.f["learning"].calls[-1]["signal"]
        self.assertEqual(sig["metadata"]["episode"], "ep-1")

    def test_a_refused_signal_is_not_counted_as_delivered_and_is_retried(self):
        self.play()
        acked0 = self.o.learning.counters()["acked"]  # the periodic performance signal sent during the decision
        self.f["learning"].status = "rejected"
        out = self.o.match_end(42, 1, 1, "ep-1")
        c = out["realLearning"]
        self.assertTrue(out["delivery"].startswith("pending"), out["delivery"])
        self.assertEqual((c["acked"], c["pending"]), (acked0, 1))
        self.assertGreaterEqual(c["failed"], 1)
        self.f["learning"].status = "recorded"
        self.host.slots["learning"].consecutive = 0
        self.host.slots["learning"].open_until = 0.0
        self.o.learning._retry_pending()
        drain(self.host)
        c = self.o.learning.counters()
        self.assertEqual((c["acked"], c["pending"]), (acked0 + 1, 0))

    def test_an_agent_that_raises_keeps_the_signal_pending(self):
        self.play()
        self.f["learning"].fail = "boom"
        out = self.o.match_end(42, 1, 1, "ep-1")
        self.assertTrue(out["delivery"].startswith("pending"))
        self.assertEqual(out["realLearning"]["pending"], 1)
        self.assertIn("boom", out["realLearning"]["lastError"])

    def test_the_profile_still_learns_when_the_agent_is_down(self):
        self.play()
        self.f["learning"].fail = "boom"
        self.o.match_end(42, 1, 1, "ep-1")
        self.assertEqual(self.o.stats()["adaptive"]["wins"], 1)

    def test_a_duplicate_match_end_sends_nothing_more(self):
        self.play()
        self.o.match_end(42, 1, 1, "ep-1")
        n = len(self.f["learning"].calls)
        out = self.o.match_end(42, 1, 1, "ep-1")
        self.assertTrue(out["duplicate"])
        self.assertEqual(len(self.f["learning"].calls), n)

    def test_signal_ids_are_unique_per_game_even_when_the_seed_repeats(self):
        self.play("ep-1")
        self.o.match_end(42, 1, 1, "ep-1")
        self.play("ep-2")
        self.o.match_end(42, 1, 0, "ep-2")
        ids = [c["signal"]["signal_id"] for c in self.f["learning"].calls if c["signal"]["kind"] == "outcome"]
        self.assertEqual(len(ids), 2)
        self.assertEqual(len(set(ids)), 2)
        self.assertEqual(self.o.learning.counters()["acked"], self.o.learning.counters()["submitted"])


if __name__ == "__main__":
    unittest.main()
