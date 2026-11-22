"""The tactics library in SLAI's authorized knowledge repository (``slai.bridge.knowledge_store``).

These tests use the *real* ``assurance.KnowledgeRepository`` / ``ScopedLexicalRetriever`` / ACL from a SLAI checkout (skipped
when none is reachable). Only the heavyweight ``src.agents`` package ``__init__`` chain (torch, statsmodels ...) is bypassed
by registering namespace packages that point at the real directories - the assurance modules themselves are unmodified.
"""
from __future__ import annotations

import contextlib
import copy
import json
import os
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

from slai.bridge import locate
from slai.bridge.knowledge_store import KIND, PRINCIPAL, PROJECT, RECORD_PREFIX, KnowledgeStoreError, TacticStore

ROOT = locate.find_root(None)
TACTICS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "slai", "data", "tactics.json")


@contextlib.contextmanager
def assurance_importable():
    """Make ``src.agents.knowledge.assurance`` importable without importing every SLAI agent's dependencies."""
    mods = {}
    for name, rel in (("src", "src"), ("src.agents", "src/agents"), ("src.agents.knowledge", "src/agents/knowledge")):
        m = types.ModuleType(name)
        m.__path__ = [os.path.join(ROOT, *rel.split("/"))]
        mods[name] = m
    with mock.patch.dict(sys.modules, mods), mock.patch.object(sys, "path", [ROOT] + sys.path):
        yield


def library() -> list[dict]:
    with open(TACTICS, encoding="utf-8") as f:
        return [t for t in json.load(f)["tactics"] if t.get("validated")]


@unittest.skipIf(ROOT is None, "no SLAI checkout reachable (set SLAI_ROOT)")
class TacticStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "knowledge.sqlite")
        ctx = assurance_importable()
        ctx.__enter__()
        self.addCleanup(ctx.__exit__, None, None, None)
        self.tactics = library()

    def store(self, tactics=None) -> TacticStore:
        return TacticStore(self.db, self.tactics if tactics is None else tactics).open()

    def test_seeding_creates_one_active_project_scoped_record_per_validated_tactic(self):
        from src.agents.knowledge.assurance.contracts import Lifecycle, Scope  # type: ignore
        s = self.store()
        self.assertEqual((s.seeded, s.unchanged), (len(self.tactics), 0))
        for t in self.tactics:
            rev = s.repo.get(RECORD_PREFIX + t["id"], s.access)
            self.assertIsNotNone(rev, t["id"])
            self.assertEqual((rev.draft.kind, rev.draft.scope, rev.draft.project_id, rev.draft.status, rev.revision),
                             (KIND, Scope.PROJECT, PROJECT, Lifecycle.ACTIVE, 1))
            self.assertEqual(rev.draft.payload["tactic"], t)

    def test_seeding_is_idempotent_and_restart_safe(self):
        self.store()
        s2 = self.store()  # a new process opening the same file
        self.assertEqual((s2.seeded, s2.unchanged), (0, len(self.tactics)))
        self.assertTrue(all(s2.repo.get(RECORD_PREFIX + t["id"], s2.access).revision == 1 for t in self.tactics))

    def test_an_edited_tactic_gets_a_new_revision_and_history_is_kept(self):
        self.store()
        edited = copy.deepcopy(self.tactics)
        edited[0]["when"] = edited[0]["when"] + ["pickup_open"]
        s = self.store(edited)
        self.assertEqual((s.seeded, s.unchanged), (1, len(self.tactics) - 1))
        rid = RECORD_PREFIX + edited[0]["id"]
        self.assertEqual(s.repo.get(rid, s.access).revision, 2)
        self.assertEqual(s.repo.get(rid, s.access).draft.payload["tactic"]["when"], edited[0]["when"])

    def test_a_removed_tactic_is_archived_not_retrievable_and_not_deleted(self):
        self.store()
        s = self.store(self.tactics[1:])
        self.assertEqual(s.archived, 1)
        gone = self.tactics[0]
        self.assertNotIn(gone["id"], s.search(set(gone["when"])))
        self.assertIsNotNone(s.repo.get(RECORD_PREFIX + gone["id"], s.access))  # history remains

    def test_retrieval_returns_the_tactics_for_the_situation_tags(self):
        s = self.store()
        for t in self.tactics:
            self.assertIn(t["id"], s.search(set(t["when"])), t)
        self.assertEqual(s.search(set()), [])
        self.assertEqual(s.search({"zzz_unknown_tag"}), [])
        self.assertEqual((s.searches, s.errors), (len(self.tactics) + 1, 0))

    def test_authorization_is_not_weakened(self):
        from src.agents.knowledge.assurance.contracts import AccessContext, Lifecycle, RecordDraft, Scope  # type: ignore
        from src.agents.knowledge.utils.knowledge_errors import AuthorizationDenied  # type: ignore
        s = self.store()
        # the runtime principal may not publish globally or write into another project
        with self.assertRaises(AuthorizationDenied):
            s.repo.create(RecordDraft(kind=KIND, scope=Scope.GLOBAL, payload={"statement": "x"}, status=Lifecycle.ACTIVE), s.access)
        with self.assertRaises(AuthorizationDenied):
            s.repo.create(RecordDraft(kind=KIND, scope=Scope.PROJECT, project_id="someone-else", payload={"statement": "x"}), s.access)
        # a context that is not a member of the project cannot read the tactics (and cannot learn they exist)
        outsider = AccessContext(principal_id="outsider", project_ids=frozenset({"other"}), can_write=True)
        self.assertIsNone(s.repo.get(RECORD_PREFIX + self.tactics[0]["id"], outsider))
        self.assertEqual(s.repo.query(outsider, kind=KIND), [])
        self.assertEqual((s.access.principal_id, set(s.access.project_ids), s.access.can_publish_global, s.access.can_attest), (PRINCIPAL, {PROJECT}, False, False))

    def test_other_projects_records_never_leak_into_retrieval(self):
        from src.agents.knowledge.assurance.contracts import AccessContext, Lifecycle, RecordDraft, Scope  # type: ignore
        s = self.store()
        other = AccessContext(principal_id="other-app", project_ids=frozenset({"other"}), can_write=True, can_review=True)
        s.repo.create(RecordDraft(kind=KIND, scope=Scope.PROJECT, project_id="other", status=Lifecycle.ACTIVE,
                                  payload={"statement": "outnumbered outnumbered outnumbered secret", "title": "leak"}), other, record_id="other:leak")
        self.assertNotIn("leak", " ".join(s.search({"outnumbered", "secret"})))
        self.assertEqual(s.search({"secret"}), [])

    def test_failures_are_reported_not_swallowed(self):
        bad = os.path.join(self.tmp.name, "afile")
        open(bad, "w").close()
        with self.assertRaises(KnowledgeStoreError):
            TacticStore(os.path.join(bad, "sub", "k.sqlite"), self.tactics).open()  # parent is a file
        s = self.store()
        s.retriever = types.SimpleNamespace(search=mock.Mock(side_effect=RuntimeError("boom")))
        with self.assertRaises(KnowledgeStoreError):
            s.search({"outnumbered"})
        self.assertEqual((s.errors, s.last_error), (1, "RuntimeError: boom"))


@unittest.skipIf(ROOT is None, "no SLAI checkout reachable (set SLAI_ROOT)")
class RealKnowledgeAdapterTests(unittest.TestCase):
    """The adapter on the real repository: the stage is 'real' only because the repository answered."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        ctx = assurance_importable()
        ctx.__enter__()
        self.addCleanup(ctx.__exit__, None, None, None)

    def test_decisions_use_tactics_retrieved_from_the_repository(self):
        from slai.bridge.adapters import RealKnowledge
        from slai.bridge.host import RealAgentHost
        from slai.agents import Context
        from slai.agents.perception import build_situation
        from tests_py.helpers import make_obs
        host = RealAgentHost(log=lambda m: None)
        host.started = True
        k = RealKnowledge(host, None, {}, os.path.join(self.tmp.name, "k.sqlite"))
        self.assertTrue(k.warm(), k.store_error)
        obs = make_obs(squads={1: 6, 2: 6}, unassigned=4, enemies=[{"x": 66 + i, "y": 26 + 2 * i} for i in range(4)], pickup={"x": 50.0, "y": 30.0})
        ctx = Context(obs=obs, deadline=time.monotonic() + 5)
        ctx.situation = build_situation(obs)
        k.run(ctx)
        self.assertEqual(ctx.flags["stages"]["knowledge"], "real")
        self.assertGreater(k.queries, 0)
        self.assertEqual((k.fallbacks, k.status()["lastError"]), (0, None))
        self.assertEqual(k.status()["store"]["errors"], 0)
        self.assertTrue({t["id"] for t in ctx.knowledge} <= {t["id"] for t in k.retrieve(set(ctx.flags["tags"]))})  # only applicable tactics
        self.assertTrue(ctx.knowledge, "the scenario should trigger at least one tactic")


if __name__ == "__main__":
    unittest.main()
