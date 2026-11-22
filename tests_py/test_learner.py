"""TacticalLearner: the GangUP side of SLAI's external learning (lifecycle, persistence, safety).

The learner, its optimizer and its checkpoints are SLAI's real ones (``src/agents/learning``; numpy only). The *inputs* are synthetic
(features, masks, priors, outcomes) so that each guarantee can be asserted exactly. These tests prove the plumbing - episode ids,
masks, credit, idempotency, atomic checkpoints, restore, frozen evaluation, schema identity. They do not, and cannot, show that the
trained policy plays better; ``tools/learning_experiment.py`` measures that on real engine games.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest import mock

from slai import learner as L
from slai.bridge import locate
from slai.features import SQUAD_FEATURES, SQUAD_OBJECTIVES, MAIN_FEATURES, MAIN_OBJECTIVES

ROOT = locate.find_root(None)
OBJ = list(SQUAD_OBJECTIVES)
SIT = {"hp_frac": 0.8, "own_n": 12}
HYPER = {"learning_rate": 1.0, "temperature": 1.0, "max_param_norm": 8.0}


def mk(mode: str, d: str | None, **kw) -> L.TacticalLearner:
    kw.setdefault("hyper", HYPER)
    kw.setdefault("min_episodes", 1)
    kw.setdefault("max_episodes", 2)
    kw.setdefault("shaping", 0.0)
    t = L.TacticalLearner(mode, d, ROOT, **kw)
    assert t.available or mode == "off", t.error
    return t


def x_squad(v: float = 1.0) -> list[float]:
    return [v] * len(SQUAD_FEATURES)


def x_main(v: float = 1.0) -> list[float]:
    return [v] * len(MAIN_FEATURES)


def play(t: L.TacticalLearner, key: tuple, winner, *, ticks: int = 3, legal=None, truncated: bool = False, override: str | None = None) -> dict:
    prior = {o: 0.0 for o in OBJ}
    legal = set(legal or OBJ)
    picks = []
    for tick in range(ticks):
        lv = t.begin_tick(key, {"tick": tick}, SIT)
        assert lv is not None
        sq = t.choose(lv, "squad", tick, "s1", x_squad(), legal, prior)
        mn = t.choose(lv, "main", tick, "m", x_main(), set(MAIN_OBJECTIVES), {o: 0.0 for o in MAIN_OBJECTIVES})
        assert sq is not None and mn is not None
        if override and tick == 0:
            t.executed(lv, "squad", sq[1], override)
        picks.append(sq[0])
    out = t.finish(key, winner, truncated=truncated)
    out["picks"] = picks
    return out


@unittest.skipIf(ROOT is None, "no SLAI checkout reachable (set SLAI_ROOT)")
class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_off_records_and_learns_nothing(self):
        t = L.TacticalLearner("off", self.tmp.name, ROOT)
        self.assertFalse(t.active())
        self.assertIsNone(t.begin_tick(("e", 0), {"tick": 0}, SIT))
        self.assertEqual(t.finish(("e", 0), 0)["status"], "inactive")
        self.assertEqual(os.listdir(self.tmp.name), [])

    def test_train_episode_updates_parameters_and_is_ledgered(self):
        t = mk("train", self.tmp.name)
        h0 = {h: t.services[f"gangup.{h}"].policy.parameter_hash for h in L.HEADS}
        out = play(t, ("ep-1", 0), winner=0)
        self.assertEqual(out["status"], "finished")
        for h in L.HEADS:
            self.assertTrue(out["heads"][h]["updated"], out)
            self.assertNotEqual(out["heads"][h]["param_hash_after"], h0[h])
            self.assertGreater(out["heads"][h]["grad_norm"], 0.0)
        self.assertEqual(t.status()["pipeline"]["optimizerSteps"], 2)
        with open(os.path.join(self.tmp.name, "episodes.jsonl")) as f:
            rec = [json.loads(x) for x in f]
        self.assertEqual([(r["token"], r["terminal"], r["truncated"]) for r in rec], [("ep-1:0", 1.0, False)])

    def test_finishing_twice_is_idempotent_and_survives_a_restart(self):
        t = mk("train", self.tmp.name)
        play(t, ("ep-1", 0), winner=0)
        steps = t.status()["pipeline"]["optimizerSteps"]
        self.assertEqual(t.finish(("ep-1", 0), 0)["status"], "duplicate")
        self.assertEqual(t.status()["pipeline"]["optimizerSteps"], steps)
        t2 = mk("train", self.tmp.name)  # new process, same directory
        self.assertIsNone(t2.begin_tick(("ep-1", 0), {"tick": 0}, SIT), "a finished episode can neither restart nor extend")
        self.assertEqual(t2.finish(("ep-1", 0), 0)["status"], "duplicate")
        self.assertEqual(t2.status()["pipeline"]["optimizerSteps"], 0)

    def test_the_two_teams_of_one_episode_are_separate_results(self):
        t = mk("train", self.tmp.name)
        a, b = play(t, ("ep", 0), winner=0), play(t, ("ep", 1), winner=0)
        self.assertEqual((a["terminal_reward"], b["terminal_reward"]), (1.0, -1.0))

    def test_unknown_episode_is_ignored_not_learned(self):
        t = mk("train", self.tmp.name)
        self.assertEqual(t.finish(("never-seen", 0), 0)["status"], "ignored")
        self.assertEqual(t.status()["pipeline"]["optimizerSteps"], 0)

    def test_truncated_game_ends_with_zero_terminal_reward_and_is_flagged(self):
        t = mk("train", self.tmp.name)
        out = play(t, ("ep-t", 0), winner=0, truncated=True)
        self.assertEqual((out["terminal_reward"], out["truncated"]), (0.0, True))

    def test_illegal_objectives_are_never_chosen(self):
        t = mk("train", self.tmp.name, seed=3)
        legal = OBJ[:2]
        for i in range(12):
            out = play(t, (f"m{i}", 0), winner=0, legal=legal, ticks=4)
            self.assertTrue(set(out["picks"]) <= set(legal), out["picks"])

    def test_a_guardrail_override_removes_credit_for_that_decision(self):
        t = mk("train", self.tmp.name)
        out = play(t, ("ep-o", 0), winner=0, ticks=3, override=OBJ[0])
        self.assertEqual(t.c["executed_overrides"], 1)
        self.assertLess(out["heads"]["squad"]["credited"], out["heads"]["squad"]["transitions"])

    def test_an_idle_live_episode_is_aborted_not_leaked(self):
        t = mk("train", self.tmp.name)
        lv = t.begin_tick(("idle", 0), {"tick": 0}, SIT)
        t.choose(lv, "squad", 0, "s1", x_squad(), set(OBJ), {o: 0.0 for o in OBJ})
        with mock.patch.object(L, "IDLE_ABORT_S", -1.0):
            t._sweep(__import__("time").monotonic())
        self.assertEqual((len(t.live), t.c["episodes_aborted"]), (0, 1))
        self.assertEqual(t.status()["pipeline"]["optimizerSteps"], 0)


@unittest.skipIf(ROOT is None, "no SLAI checkout reachable (set SLAI_ROOT)")
class PersistenceAndEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def train_to_prefer(self, winner_obj: str, games: int = 30) -> L.TacticalLearner:
        """A task with a known answer: the game is won iff the squad picked ``winner_obj`` at tick 0."""
        t = mk("train", self.tmp.name, seed=7, hyper={"learning_rate": 2.0, "temperature": 1.0, "max_param_norm": 8.0}, min_episodes=2, max_episodes=4)
        for i in range(games):
            key = (f"g{i}", 0)
            lv = t.begin_tick(key, {"tick": 0}, SIT)
            pick = t.choose(lv, "squad", 0, "s1", x_squad(), set(OBJ), {o: 0.0 for o in OBJ})
            t.choose(lv, "main", 0, "m", x_main(), set(MAIN_OBJECTIVES), {o: 0.0 for o in MAIN_OBJECTIVES})
            t.finish(key, 0 if pick[0] == winner_obj else 1)
        t.flush()
        return t

    def test_credit_reaches_the_policy_and_the_updated_policy_is_what_serves_next(self):
        target = OBJ[3]
        untrained = mk("evaluate", None).services["gangup.squad"].policy.parameter_hash
        t = self.train_to_prefer(target)
        self.assertNotEqual(t.services["gangup.squad"].policy.parameter_hash, untrained)
        lv = t.begin_tick(("probe", 1), {"tick": 0}, SIT)
        pick = t.choose(lv, "squad", 0, "s1", x_squad(), set(OBJ), {o: 0.0 for o in OBJ})
        self.assertGreater(pick[1]["p"], 1.0 / len(OBJ), "the updated policy, not the prior, is what serves the next decision")
        self.assertEqual(pick[0] if pick[1]["greedy"] else target, target)

    def test_checkpoint_restore_serves_the_same_parameters_and_evaluation_never_trains(self):
        target = OBJ[3]
        t = self.train_to_prefer(target)
        trained = {h: t.services[f"gangup.{h}"].policy.parameter_hash for h in L.HEADS}
        r = mk("evaluate", self.tmp.name)  # fresh process, same state dir
        self.assertEqual({h: r.services[f"gangup.{h}"].policy.parameter_hash for h in L.HEADS}, trained)
        self.assertEqual(r.status()["pipeline"]["checkpointsRestored"], 2)
        for i in range(6):
            out = play(r, (f"e{i}", 0), winner=0)
            self.assertTrue(all(h["updated"] in (False, None) for h in out["heads"].values()), out)
            self.assertEqual(out["picks"], [target] * 3, "evaluation is greedy from the restored policy")
        self.assertEqual(r.status()["pipeline"]["optimizerSteps"], 0)
        self.assertEqual({h: r.services[f"gangup.{h}"].policy.parameter_hash for h in L.HEADS}, trained)

    def test_weights_are_not_loaded_under_a_different_schema(self):
        self.train_to_prefer(OBJ[3], games=10)
        with mock.patch.object(L, "schema_fingerprint", side_effect=lambda h: "f" * 64 if h == "squad" else L.hashlib.sha256(h.encode()).hexdigest()):
            r = mk("evaluate", self.tmp.name)
        # a different fingerprint selects a different namespaced directory: nothing is restored for the squad head
        self.assertEqual(r.status()["heads"]["squad"]["restore"], "fresh_start")
        self.assertEqual(r.status()["heads"]["squad"]["trainingStep"], 0)

    def test_the_state_directory_is_namespaced_by_head_and_schema(self):
        mk("train", self.tmp.name)
        dirs = sorted(d for d in os.listdir(self.tmp.name) if os.path.isdir(os.path.join(self.tmp.name, d)))
        self.assertEqual(dirs, sorted(f"{h}-{L.schema_fingerprint(h)[:12]}" for h in L.HEADS))


@unittest.skipIf(ROOT is None, "no SLAI checkout reachable (set SLAI_ROOT)")
class OrchestratorIntegrationTests(unittest.TestCase):
    """Game state -> observation -> decision (learner serves the objectives) -> match end -> update -> checkpoint -> restart -> decision."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def orch(self, mode: str):
        from slai.orchestrator import Orchestrator
        return Orchestrator(adaptive_path=os.path.join(self.tmp.name, "adaptive.json"), learning=mode, learning_dir=os.path.join(self.tmp.name, "state"),
                            slai_root=ROOT, learning_opts={"hyper": HYPER, "min_episodes": 1, "max_episodes": 2, "shaping": 0.3})

    def obs(self, tick: int, episode: str = "ep-int"):
        from tests_py.helpers import make_obs
        o = make_obs(squads={1: 6, 2: 6}, unassigned=4, enemies=[{"x": 66 + i, "y": 26 + 2 * i} for i in range(4)], pickup={"x": 50.0, "y": 30.0}, tick=tick)
        o["episode"] = episode
        return o

    def test_decisions_are_served_by_the_learner_and_the_full_cycle_persists(self):
        o = self.orch("train")
        for tick in (600, 612, 624):
            resp = o.decide(self.obs(tick))
            self.assertTrue(resp["meta"]["learner"]["active"], resp["meta"].get("learner"))
            self.assertEqual(resp["meta"]["learner"]["mode"], "train")
        before = o.learner.status()
        self.assertGreater(before["pipeline"]["decisionsRecorded"], 0)
        self.assertEqual(before["pipeline"]["optimizerSteps"], 0, "recorded decisions are not an update")
        adaptive_matches = o.learning.profile["matches"]
        end = o.match_end(42, 1, 1, "ep-int")
        self.assertTrue(all(h["updated"] for h in end["learner"]["heads"].values()), end)
        after = o.learner.status()
        self.assertEqual(after["pipeline"]["optimizerSteps"], 2)
        self.assertTrue(after["pipeline"]["parametersChanged"])
        self.assertEqual(o.learning.profile["matches"], adaptive_matches + 1)  # the opponent profile still counts the game
        self.assertEqual(o.match_end(42, 1, 1, "ep-int")["learner"]["status"], "duplicate")
        o.close()
        trained = {h: v["parameterHash"] for h, v in after["heads"].items()}
        r = self.orch("evaluate")  # restart: restored from the checkpoint written by the training run
        restored = r.learner.status()
        self.assertEqual({h: v["parameterHash"] for h, v in restored["heads"].items()}, trained)
        self.assertGreaterEqual(restored["pipeline"]["checkpointsRestored"], 2)
        resp = r.decide(self.obs(600, "ep-next"))
        self.assertEqual(resp["meta"]["learner"]["mode"], "evaluate")
        r.match_end(42, 1, 1, "ep-next")
        self.assertEqual(r.learner.status()["pipeline"]["optimizerSteps"], 0)

    def test_a_truncated_match_is_accounted_for_without_touching_the_opponent_profile(self):
        o = self.orch("train")
        o.decide(self.obs(600, "ep-cut"))
        matches = o.learning.profile["matches"]
        out = o.match_end(42, 1, None, "ep-cut", truncated=True)
        self.assertEqual((out["truncated"], out["learner"]["truncated"], out["learner"]["terminal_reward"]), (True, True, 0.0))
        self.assertEqual(o.learning.profile["matches"], matches)


class PotentialTests(unittest.TestCase):
    def test_potential_is_bounded_and_monotone_in_health_and_strength(self):
        self.assertEqual(L.potential({"hp_frac": 0.0, "own_n": 0}), 0.0)
        self.assertEqual(L.potential({"hp_frac": 1.0, "own_n": 25}), 1.0)
        self.assertEqual(L.potential({"hp_frac": 2.0, "own_n": 99}), 1.0)
        self.assertLess(L.potential({"hp_frac": 0.4, "own_n": 10}), L.potential({"hp_frac": 0.6, "own_n": 10}))
        self.assertLess(L.potential({"hp_frac": 0.5, "own_n": 5}), L.potential({"hp_frac": 0.5, "own_n": 8}))

    def test_fingerprints_differ_by_head_and_are_stable(self):
        self.assertNotEqual(L.schema_fingerprint("squad"), L.schema_fingerprint("main"))
        self.assertEqual(L.schema_fingerprint("squad"), L.schema_fingerprint("squad"))


if __name__ == "__main__":
    unittest.main()
