"""TacticalLearner: GangUP's adapter to SLAI's generic external-learning service (``src/agents/learning``).

SLAI owns the learner (a residual-softmax policy trained by REINFORCE, transition store, hashed atomic checkpoints). GangUP owns
what is specific to this game, and nothing else lives here:

* **what the policy sees**  the feature vectors of ``features.py`` (legitimate observation only),
* **what it may choose**    the legal / HTN-feasible objective masks of ``policy.py`` / the Planning stage,
* **its prior**             the supervised imitation policy's scores (plus knowledge and opponent-model biases). The learned part is a
                            bounded *residual* on top, so learning refines the prior and can never silently replace it,
* **what counts as reward** the match outcome (win +1 / loss -1 / draw 0) plus a small *potential-based* shaping term computed
                            from the team's own Main health and soldier count (see ``potential``),
* **identity**              a fingerprint of the feature and objective definitions, so weights are never loaded under a schema that
                            means something different, and a namespaced state directory per head.

Two heads learn separately: ``squad`` (8 objectives) and ``main`` (5 goals).

Modes
-----
``off``       nothing is recorded or learned; decisions are the imitation policy's argmax (the pre-learning behaviour).
``evaluate``  greedy answers from the restored checkpoint; episodes are accounted for but can never train (frozen policy).
``train``     answers are *sampled* from the learned policy (exploration restricted to legal objectives); finished episodes are fed to
              the learner, which updates, autosaves a checkpoint and keeps serving the updated parameters.

Every finished game is written to ``episodes.jsonl`` (one durable, idempotent line per ``episode:team``) with exactly what happened
to it: decisions recorded, whether an optimizer step ran, parameter hashes before and after. A repeated ``match_end`` is
recognised from that ledger, also after a restart.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from typing import Any

from .bridge import locate
from .features import MAIN_FEATURES, MAIN_OBJECTIVES, SQUAD_FEATURES, SQUAD_OBJECTIVES

LEARNING_SCHEMA = "gangup.learning.v1"
MODES = ("off", "evaluate", "train")
HEADS = {
    "squad": (SQUAD_FEATURES, SQUAD_OBJECTIVES),
    "main": (MAIN_FEATURES, MAIN_OBJECTIVES),
}
LEDGER_KEEP = 4096  # finished episodes remembered for idempotency (the file itself keeps everything)
IDLE_ABORT_S = 900.0  # a live episode with no decision for this long (quit, crash, timeout) is aborted, not leaked

DEFAULT_HYPER = {
    "learning_rate": 0.05, "gamma": 0.999, "baseline_momentum": 0.9, "entropy_coef": 0.0, "weight_decay": 0.0,
    "max_grad_norm": 5.0, "max_param_norm": 4.0, "advantage_clip": 5.0, "temperature": 2.0,
}


def schema_fingerprint(head: str) -> str:
    """Identity of what the feature vector and the action indices of a head mean (names and order)."""
    feats, objs = HEADS[head]
    blob = json.dumps({"schema": LEARNING_SCHEMA, "head": head, "features": list(feats), "actions": list(objs)}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def potential(sit: dict) -> float:
    """Φ(s) in [0, 1] from state the team legitimately knows: own Main health and own soldier count. Potential-based shaping
    (r = γΦ(s') − Φ(s)) leaves the optimal policy of the outcome reward unchanged; it only densifies credit."""
    return 0.5 * max(0.0, min(1.0, sit["hp_frac"])) + 0.5 * min(1.0, sit["own_n"] / 25.0)


class _Live:
    __slots__ = ("episode_id", "phi", "ids", "decisions", "tick", "seen", "started", "rejected")

    def __init__(self, episode_id: str, now: float) -> None:
        self.episode_id = episode_id
        self.phi: float | None = None
        self.ids: dict[str, list[str]] = {h: [] for h in HEADS}  # decisions of the previous tick awaiting their reward
        self.decisions = {h: 0 for h in HEADS}
        self.tick = -1
        self.seen = now
        self.started = False
        self.rejected = 0


class TacticalLearner:
    def __init__(self, mode: str = "off", state_dir: str | None = None, slai_root: str | None = None, hyper: dict | None = None,
                 seed: int = 0, min_episodes: int = 4, max_episodes: int = 8, shaping: float = 0.3, autosave_every: int = 1,
                 log=None) -> None:
        if mode not in MODES:
            raise ValueError(f"learning mode must be one of {MODES}")
        self.mode = mode
        self.shaping = float(shaping)
        self.log = log or (lambda msg: None)
        self.lock = threading.RLock()
        self.available = False
        self.error: str | None = None
        self.services: dict = {}
        self.live: dict[tuple, _Live] = {}
        self.ledger: dict[str, dict] = {}
        self.state_dir = os.path.abspath(state_dir) if state_dir else None
        self.c = {"decisions": 0, "answered": 0, "fallbacks": 0, "rejected": 0, "feedback": 0, "episodes_started": 0, "episodes_finished": 0,
                  "episodes_duplicate": 0, "episodes_unknown": 0, "episodes_aborted": 0, "updates_applied": 0, "updates_skipped": 0,
                  "executed_overrides": 0}
        self.last_error: str | None = None
        self.initial_hash: dict[str, str] = {}
        self._dispatch = None
        if mode == "off":
            return
        root = locate.find_root(slai_root)
        if root is None:
            self.error = "SLAI checkout not found: learning needs <SLAI>/src/agents/learning (set SLAI_ROOT or --slai-root)"
            return
        locate.activate(root)
        try:
            from src.agents.learning.external_dispatch import dispatch  # type: ignore
        except Exception as e:  # noqa: BLE001
            self.error = f"SLAI external learning unavailable: {type(e).__name__}: {e}"
            return
        self._dispatch = dispatch
        hyper = {**DEFAULT_HYPER, **(hyper or {})}
        for head, (feats, objs) in HEADS.items():
            fp = schema_fingerprint(head)
            ckpt = os.path.join(self.state_dir, f"{head}-{fp[:12]}") if self.state_dir else None
            res = dispatch(self.services, {
                "op": "configure", "name": f"gangup.{head}", "feature_dim": len(feats), "action_dim": len(objs), "hyper": hyper,
                "seed": seed, "learner_mode": mode, "learning_enabled": mode == "train", "min_episodes_per_update": min_episodes,
                "max_episodes_per_update": max_episodes, "checkpoint_dir": ckpt, "autosave_every_updates": autosave_every if ckpt else 0,
                "restore_on_start": True, "max_live_episodes": 64, "schema_fingerprint": fp})
            if res.get("status") != "ok":
                self.error = f"{head}: {res.get('code')}: {res.get('message')}"
                self.services.clear()
                return
            self.initial_hash[head] = res["policy"]["parameter_hash"]
            r = res.get("restore", {}).get("status")
            self.log(f"learning[{head}] {mode}: {r}, policy {res['policy']['policy_id']}, step {res['policy']['training_step']}")
        self._load_ledger()
        self.available = True

    # ------------------------------------------------------------------ ledger (durable idempotency + per-episode accounting)
    def _ledger_path(self) -> str | None:
        return os.path.join(self.state_dir, "episodes.jsonl") if self.state_dir else None

    def _load_ledger(self) -> None:
        path = self._ledger_path()
        if not path or not os.path.isfile(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f.readlines()[-LEDGER_KEEP:]:
                    try:
                        rec = json.loads(line)
                        self.ledger[rec["token"]] = rec
                    except (ValueError, KeyError):
                        continue  # a torn last line from an interrupted write must not block start-up
        except OSError as e:
            self.last_error = f"ledger unreadable: {e}"

    def _write_ledger(self, rec: dict) -> None:
        self.ledger[rec["token"]] = rec
        if len(self.ledger) > LEDGER_KEEP:
            self.ledger.pop(next(iter(self.ledger)))
        path = self._ledger_path()
        if not path:
            return
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, separators=(",", ":"), default=str) + "\n")
                f.flush()
                os.fsync(f.fileno())
        except OSError as e:
            self.last_error = f"ledger write failed: {e}"

    # ------------------------------------------------------------------ helpers
    def active(self) -> bool:
        return self.available and self.mode != "off"

    @staticmethod
    def _token(key: tuple) -> str:
        return f"{key[0]}:{key[1]}"

    def _call(self, payload: dict) -> dict:
        return self._dispatch(self.services, payload)  # type: ignore[misc]

    def _sweep(self, now: float) -> None:
        for key in [k for k, v in self.live.items() if now - v.seen > IDLE_ABORT_S]:
            self._abort(key, "idle")

    def _abort(self, key: tuple, reason: str) -> None:
        lv = self.live.pop(key, None)
        if lv is None:
            return
        if lv.started:
            for head in HEADS:
                self._call({"op": "abort_episode", "name": f"gangup.{head}", "episode_id": lv.episode_id, "reason": reason})
        self.c["episodes_aborted"] += 1

    # ------------------------------------------------------------------ per-decision protocol
    def begin_tick(self, key: tuple, obs: dict, sit: dict) -> _Live | None:
        """Called once per decision, before any head is asked: opens the episode if needed and pays the previous tick's shaped
        reward to the decisions that preceded it. Returns None when this game is not being learned from (fall back to the prior)."""
        if not self.active():
            return None
        now = time.monotonic()
        with self.lock:
            if self._token(key) in self.ledger:
                return None  # this episode already finished: a replayed/late observation can neither start nor extend it
            lv = self.live.get(key)
            if lv is None:
                if len(self.live) >= 32:
                    self._sweep(now)
                    if len(self.live) >= 32:
                        self._abort(next(iter(self.live)), "evicted")
                lv = self.live[key] = _Live(f"{key[0]}:{key[1]}", now)
                for head in HEADS:
                    res = self._call({"op": "start_episode", "name": f"gangup.{head}", "episode_id": lv.episode_id})
                    if res.get("status") != "ok":
                        self.c["rejected"] += 1
                        self.last_error = f"start_episode[{head}]: {res.get('code')}: {res.get('message')}"
                        self._abort(key, "start_failed")
                        return None
                lv.started = True
                self.c["episodes_started"] += 1
            if obs["tick"] < lv.tick:
                return None  # time went backwards inside one episode id: not a coherent trajectory
            lv.seen, lv.tick = now, obs["tick"]
            phi = potential(sit)
            if lv.phi is not None and self.shaping:
                r = self.shaping * (phi - lv.phi)
                for head in HEADS:
                    for did in lv.ids[head]:
                        res = self._call({"op": "feedback", "name": f"gangup.{head}", "episode_id": lv.episode_id, "decision_id": did, "reward": r})
                        if res.get("status") == "ok":
                            self.c["feedback"] += 1
            lv.phi = phi
            for head in HEADS:
                lv.ids[head] = []
            return lv

    def choose(self, lv: _Live, head: str, tick: int, tag: str, x: list[float], legal: set, scores: dict) -> tuple[str, dict] | None:
        """Ask the learner for one objective. ``scores`` are the prior logits (all objectives, finite); ``legal`` is the mask."""
        feats, objs = HEADS[head]
        did = f"{lv.episode_id}:{tick}:{head}:{tag}"
        self.c["decisions"] += 1
        res = self._call({
            "op": "decide", "name": f"gangup.{head}", "episode_id": lv.episode_id, "decision_id": did, "sequence": lv.decisions[head],
            "features": x, "action_mask": [o in legal for o in objs], "prior_logits": [float(scores[o]) for o in objs]})
        if res.get("status") != "ok":
            self.c["rejected"] += 1
            self.c["fallbacks"] += 1
            self.last_error = f"decide[{head}]: {res.get('code')}: {res.get('message')}"
            return None
        lv.decisions[head] += 1
        lv.ids[head].append(did)
        self.c["answered"] += 1
        return objs[res["action"]], {"id": did, "p": res["probability"], "greedy": res["greedy"], "policy": res["policy"]["policy_id"],
                                     "mode": res["episode_mode"]}

    def executed(self, lv: _Live, head: str, info: dict, objective: str) -> None:
        """The game executed ``objective`` instead of what the learner chose (guardrail override): that decision is not credited."""
        res = self._call({"op": "executed", "name": f"gangup.{head}", "episode_id": lv.episode_id, "decision_id": info["id"],
                          "action": HEADS[head][1].index(objective)})
        if res.get("status") == "ok":
            self.c["executed_overrides"] += 1

    # ------------------------------------------------------------------ episode end
    def finish(self, key: tuple, winner: int | None, truncated: bool = False) -> dict:
        """Close an episode. Idempotent per ``episode:team`` (durably). Returns what happened, never raises."""
        token = self._token(key)
        if not self.active():
            return {"status": "inactive", "reason": self.error or "learning off"}
        with self.lock:
            prior = self.ledger.get(token)
            if prior is not None:
                self.c["episodes_duplicate"] += 1
                return {"status": "duplicate", "token": token, "update": prior.get("update")}
            lv = self.live.pop(key, None)
            if lv is None or not lv.started:
                self.c["episodes_unknown"] += 1
                return {"status": "ignored", "reason": "no live episode (never seen by this service run)", "token": token}
            team = key[1]
            terminal = 0.0 if (winner is None or truncated) else (1.0 if winner == team else -1.0)
            # pay the last tick's shaped reward against the terminal state: no further observation exists, so Φ(terminal)=0 would
            # punish every ending equally; the outcome reward carries the final credit instead
            out: dict[str, Any] = {"status": "finished", "token": token, "terminal_reward": terminal, "decisions": dict(lv.decisions),
                                   "truncated": truncated, "heads": {}}
            before = {h: self.services[f"gangup.{h}"].policy.parameter_hash for h in HEADS}
            for head in HEADS:
                res = self._call({"op": "end_episode", "name": f"gangup.{head}", "episode_id": lv.episode_id, "terminal_reward": terminal,
                                  "terminated": not truncated, "truncated": truncated})
                upd = res.get("update") or {}
                out["heads"][head] = {
                    "status": res.get("status"), "code": res.get("code"), "updated": upd.get("updated"), "skip": upd.get("skip_reason"),
                    "transitions": upd.get("transitions"), "credited": upd.get("credited_transitions"), "grad_norm": upd.get("grad_norm"),
                    "param_delta": upd.get("param_delta_norm"), "step": upd.get("step_after"), "mean_return": upd.get("mean_return"),
                    "param_hash_before": upd.get("parameter_hash_before") or before[head], "param_hash_after": upd.get("parameter_hash_after")
                    or self.services[f"gangup.{head}"].policy.parameter_hash}
                if upd.get("updated"):
                    self.c["updates_applied"] += 1
                else:
                    self.c["updates_skipped"] += 1
            self.c["episodes_finished"] += 1
            self._write_ledger({"token": token, "at": time.time(), "mode": self.mode, "winner": winner, "terminal": terminal, "truncated": truncated,
                                "decisions": dict(lv.decisions), "heads": out["heads"]})
            return out

    def flush(self) -> dict:
        """Update on whatever is pending (train mode), e.g. at shutdown, then checkpoint."""
        out: dict = {}
        if not self.active() or self.mode != "train":
            return out
        with self.lock:
            for head in HEADS:
                res = self._call({"op": "flush", "name": f"gangup.{head}"})
                out[head] = (res.get("update") or {}).get("updated")
                self._call({"op": "checkpoint", "name": f"gangup.{head}", "reason": "flush"})
        return out

    # ------------------------------------------------------------------ reporting
    def status(self) -> dict:
        if not self.active():
            return {"mode": self.mode, "available": False, "error": self.error}
        with self.lock:
            heads = {}
            for h in HEADS:
                s = self.services[f"gangup.{h}"].status()
                p = s["policy"]
                lu = s.get("last_update") or {}
                heads[h] = {
                    "policyId": p["policy_id"], "trainingStep": p["training_step"], "consumedEpisodes": p["consumed_episodes"],
                    "consumedTransitions": p["consumed_transitions"], "parameterHash": p["parameter_hash"][:16],
                    "parametersChangedThisRun": p["parameter_hash"] != self.initial_hash.get(h), "checkpointId": p["checkpoint_id"],
                    "restoredFrom": p["restored_from"], "restore": s["restore"].get("status"), "store": s["store"], "updates": s["updates"],
                    "pendingEpisodes": s["store"].get("pending_episodes", s["store"].get("pending")), "lastUpdate": {
                        k: lu.get(k) for k in ("updated", "skip_reason", "grad_norm", "param_delta_norm", "credited_transitions", "mean_return")},
                    "counters": s["counters"], "lastError": s["last_error"]}
            c = self.c
            return {"mode": self.mode, "available": True, "schema": LEARNING_SCHEMA, "stateDir": self.state_dir, "live": len(self.live),
                    "ledger": len(self.ledger), "heads": heads, "counters": dict(c), "lastError": self.last_error,
                    # what each stage of the pipeline actually did, as separate facts (an acknowledgment is not an optimizer step)
                    "pipeline": {"decisionsRecorded": c["answered"], "rewardEventsRecorded": c["feedback"],
                                 "episodesFinished": c["episodes_finished"], "optimizerSteps": c["updates_applied"],
                                 "parametersChanged": any(v["parametersChangedThisRun"] for v in heads.values()),
                                 "checkpointsSaved": sum(v["counters"].get("checkpoints_saved", 0) for v in heads.values()),
                                 "checkpointsRestored": sum(v["counters"].get("checkpoints_restored", 0) for v in heads.values())}}
