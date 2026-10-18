import copy
import unittest

from slai.agents.safety import validate_action
from slai.schema import SchemaError, make_action, validate_observation

from .helpers import make_obs


class SchemaTests(unittest.TestCase):
    def test_valid_observation_passes(self):
        validate_observation(make_obs())

    def test_rejects_wrong_schema_and_missing_fields(self):
        o = make_obs()
        o["schema"] = "other"
        with self.assertRaises(SchemaError):
            validate_observation(o)
        o = make_obs()
        del o["enemies"]
        with self.assertRaises(SchemaError):
            validate_observation(o)

    def test_rejects_non_finite_numbers(self):
        o = make_obs()
        o["own"]["main"]["x"] = float("nan")
        with self.assertRaises(SchemaError):
            validate_observation(o)

    def test_rejects_wrong_squad_count(self):
        o = make_obs()
        o["squads"].pop()
        with self.assertRaises(SchemaError):
            validate_observation(o)


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.obs = make_obs(squads={1: 4}, enemies=[{"x": 60, "y": 30}])

    def ok(self, a):
        fixed, why = validate_action(self.obs, a)
        return fixed is not None, why

    def test_stale_generation_rejected(self):
        a = make_action("SetStance", self.obs, stance="offensive")
        a["generation"] -= 1
        self.assertEqual(self.ok(a), (False, "stale-generation"))

    def test_expired_rejected(self):
        a = make_action("SetStance", self.obs, stance="offensive")
        a["expiresAt"] = self.obs["tick"]
        self.assertEqual(self.ok(a), (False, "bad-envelope"))

    def test_unknown_command_rejected(self):
        self.assertEqual(self.ok({"command": "Nuke", "generation": 1}), (False, "unknown-command"))

    def test_squad_id_required_and_in_range(self):
        a = make_action("SetDoctrine", self.obs, doctrine="Press")
        self.assertEqual(self.ok(a), (False, "missing-squad-id"))
        a = make_action("SetDoctrine", self.obs, squad=10, doctrine="Press")
        self.assertEqual(self.ok(a), (False, "missing-squad-id"))

    def test_empty_squad_rejected(self):
        a = make_action("SetDoctrine", self.obs, squad=5, doctrine="Press")
        self.assertEqual(self.ok(a), (False, "empty-squad"))

    def test_hidden_target_rejected_visible_accepted(self):
        bad = make_action("SetTarget", self.obs, squad=1, target={"id": 777, "kind": "unit"})
        self.assertEqual(self.ok(bad), (False, "hidden-target"))
        good = make_action("SetTarget", self.obs, squad=1, target={"id": 1000, "kind": "unit"})
        self.assertTrue(self.ok(good)[0])

    def test_destination_in_cover_is_repaired_or_rejected(self):
        # inside the central north block
        a = make_action("MoveSquad", self.obs, squad=1, destination={"x": 50, "y": 16})
        fixed, why = validate_action(self.obs, a)
        self.assertTrue(fixed is None or fixed["destination"] != {"x": 50, "y": 16})

    def test_out_of_bounds_rejected(self):
        a = make_action("MoveSquad", self.obs, squad=1, destination={"x": 500, "y": 16})
        self.assertEqual(self.ok(a), (False, "out-of-bounds"))

    def test_create_squad_rejects_foreign_and_duplicate_members(self):
        a = make_action("CreateSquad", self.obs, squad=2, members=[999, 1000])
        self.assertEqual(self.ok(a), (False, "foreign-member"))
        mid = self.obs["own"]["soldiers"][0]["id"]
        a = make_action("CreateSquad", self.obs, squad=2, members=[mid, mid])
        self.assertEqual(self.ok(a), (False, "bad-members"))

    def test_main_goal_must_target_own_main_and_visible_enemy(self):
        a = make_action("MainGoal", self.obs, actor=99, goal="Engage", destination={"x": 70, "y": 30})
        self.assertEqual(self.ok(a), (False, "not-own-main"))
        a = make_action("MainGoal", self.obs, actor=2, goal="Engage", destination={"x": 70, "y": 30}, target={"id": 5})
        self.assertEqual(self.ok(a), (False, "hidden-target"))

    def test_bad_doctrine_and_formation(self):
        self.assertEqual(self.ok(make_action("SetDoctrine", self.obs, squad=1, doctrine="Berserk")), (False, "bad-doctrine"))
        self.assertEqual(self.ok(make_action("SetFormation", self.obs, squad=1, formation="Blob")), (False, "bad-formation"))


if __name__ == "__main__":
    unittest.main()
