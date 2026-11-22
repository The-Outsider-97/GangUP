"""GangUP's tactics library, persisted in and retrieved from SLAI's authorized knowledge repository.

Why this exists: the earlier adapter seeded tactics with ``KnowledgeAgent.add_document`` and then queried the agent. SLAI's
KnowledgeAgent refuses un-scoped writes (``KNW-1006``, PermissionError), the circuit breaker opened on the first seed, and
the stage fell back to the built-in lookup on every decision. The check was right; the caller was wrong. SLAI's governed
store is ``assurance.KnowledgeRepository`` (immutable revisions, project scoping, row-level ACL) searched with
``ScopedLexicalRetriever``. This module is the GangUP side of that contract:

  * the application boundary (this file, not request data) creates the *trusted* ``AccessContext``: principal
    ``gangup-runtime``, member of project ``gangup``, write + review permission (SLAI requires review to activate a
    record; the maintainers' ``validated`` flag is that review), nothing else - no global publication, no attestation,
    no other project;
  * every tactic is one ``kind="tactic"`` record in the ``gangup`` project scope with status ACTIVE;
  * seeding is idempotent: unchanged tactics are left alone, edited ones get a new revision (history is kept), tactics
    removed or no longer validated are archived rather than deleted;
  * retrieval passes ``project_id="gangup"`` so scope filtering happens in SQL before ranking.

Nothing here weakens SLAI's authorization, and nothing GangUP-specific lives in SLAI.
"""
from __future__ import annotations

import time
from typing import Any

PROJECT = "gangup"
PRINCIPAL = "gangup-runtime"
KIND = "tactic"
SOURCE_ID = "gangup-tactics-library"
RECORD_PREFIX = "gangup:tactic:"


class KnowledgeStoreError(RuntimeError):
    """The governed store could not be opened, seeded or searched (the message says why)."""


def _api() -> dict[str, Any]:
    """SLAI's assurance API, imported lazily so GangUP without SLAI (lite mode) never needs it."""
    try:
        from src.agents.knowledge.assurance import KnowledgeRepository, ScopedLexicalRetriever  # type: ignore
        from src.agents.knowledge.assurance.contracts import AccessContext, Lifecycle, RecordDraft, Scope  # type: ignore
    except Exception as e:  # noqa: BLE001
        raise KnowledgeStoreError(f"SLAI knowledge assurance API unavailable ({type(e).__name__}: {e})") from e
    return {"Repo": KnowledgeRepository, "Retriever": ScopedLexicalRetriever, "Access": AccessContext,
            "Lifecycle": Lifecycle, "Draft": RecordDraft, "Scope": Scope}


def tactic_text(t: dict) -> str:
    """Indexable text: the situation tags the tactic applies to plus its readable name. Matches the tags ``situation_tags`` emits."""
    return " ".join(t["when"]) + " " + t["id"].replace("-", " ")


def tactic_payload(t: dict) -> dict:
    """Payload kept in the record: the library entry itself (so the repository, not a side file, is the source at runtime)."""
    # "statement" and "title" are the plaintext fields SLAI's retriever indexes; "tactic" carries the full entry.
    return {"statement": tactic_text(t), "title": t["id"].replace("-", " "), "tactic": dict(t)}


class TacticStore:
    def __init__(self, path: str, tactics: list[dict]) -> None:
        self.path = path
        self.tactics = [t for t in tactics if t.get("validated")]
        self.repo: Any = None
        self.retriever: Any = None
        self.access: Any = None
        self._api: dict[str, Any] = {}
        # state ladder for the diagnostics endpoint
        self.opened = False
        self.seeded = 0       # records created or revised in this process
        self.unchanged = 0    # already current in the store
        self.archived = 0
        self.searches = 0
        self.hits = 0
        self.errors = 0
        self.last_error: str | None = None
        self.last_search_ms: float | None = None

    # ------------------------------------------------------------------ open + seed
    def open(self) -> "TacticStore":
        if self.opened:
            return self
        api = self._api = _api()
        try:
            self.repo = api["Repo"](self.path)
            self.retriever = api["Retriever"](self.repo)
            # Trusted boundary: constructed here from constants, never from request data. SLAI requires ``can_review`` to
            # activate a record; GangUP's review is the ``validated`` flag its maintainers set in tactics.json, and only
            # validated tactics are ever seeded. No global publication, no attestation, no other project.
            self.access = api["Access"](principal_id=PRINCIPAL, project_ids=frozenset({PROJECT}), can_write=True, can_review=True)
            self.seed()
            self.opened = True
        except KnowledgeStoreError:
            raise
        except Exception as e:  # noqa: BLE001 - authorization denials, sqlite errors ...
            self.errors += 1
            self.last_error = f"{type(e).__name__}: {e}"
            raise KnowledgeStoreError(self.last_error) from e
        return self

    def _draft(self, t: dict, status: Any) -> Any:
        a = self._api
        return a["Draft"](kind=KIND, scope=a["Scope"].PROJECT, project_id=PROJECT, payload=tactic_payload(t),
                          status=status, source_ids=(SOURCE_ID,))

    def seed(self) -> None:
        """Make the store's ACTIVE tactics equal the validated library. Idempotent; revisions, never deletions."""
        a = self._api
        active = a["Lifecycle"].ACTIVE
        wanted = {RECORD_PREFIX + t["id"]: t for t in self.tactics}
        for rid, t in wanted.items():
            current = self.repo.get(rid, self.access)
            draft = self._draft(t, active)
            if current is None:
                self.repo.create(draft, self.access, record_id=rid, reason="seed gangup tactics library")
                self.seeded += 1
            elif current.draft.payload != draft.payload or current.draft.status != active:
                self.repo.revise(rid, current.revision, draft, self.access, reason="tactics library changed")
                self.seeded += 1
            else:
                self.unchanged += 1
        # Tactics that were removed from the library (or are no longer validated) stop being retrievable.
        for rev in self.repo.query(self.access, kind=KIND, project_id=PROJECT, limit=1000):
            if rev.record_id.startswith(RECORD_PREFIX) and rev.record_id not in wanted:
                self.repo.revise(rev.record_id, rev.revision, self._draft(rev.draft.payload["tactic"], a["Lifecycle"].ARCHIVED),
                                 self.access, reason="removed from tactics library")
                self.archived += 1

    # ------------------------------------------------------------------ retrieval
    def search(self, tags: set[str], k: int | None = None) -> list[str]:
        """Tactic ids the repository ranks for these situation tags, scope-filtered in SQL. Raises KnowledgeStoreError on failure."""
        if not self.opened:
            self.open()
        query = " ".join(sorted(tags)).strip()
        if not query:
            return []
        t0 = time.perf_counter()
        try:
            res = self.retriever.search(query, self.access, project_id=PROJECT, kind=KIND, k=min(100, k or len(self.tactics) + 2))
        except Exception as e:  # noqa: BLE001
            self.errors += 1
            self.last_error = f"{type(e).__name__}: {e}"
            raise KnowledgeStoreError(self.last_error) from e
        finally:
            self.last_search_ms = round((time.perf_counter() - t0) * 1000.0, 3)
        self.searches += 1
        ids = [h.record_id[len(RECORD_PREFIX):] for h in res.hits if h.record_id.startswith(RECORD_PREFIX)]
        self.hits += len(ids)
        return ids

    def status(self) -> dict:
        return {"path": self.path, "opened": self.opened, "project": PROJECT, "principal": PRINCIPAL,
                "recordsSeededThisRun": self.seeded, "recordsUnchanged": self.unchanged, "recordsArchived": self.archived,
                "searches": self.searches, "tacticsReturned": self.hits, "errors": self.errors, "lastError": self.last_error,
                "lastSearchMs": self.last_search_ms}
