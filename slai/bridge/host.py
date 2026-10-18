"""RealAgentHost: builds the *actual* SLAI agents (``src/agents``) through SLAI's own ``AgentFactory`` and guards every call.

Each of the eight roles of GDD 12.2 is a "slot":

    state        pending -> loading -> ready | unavailable | disabled
    breaker      closes again automatically: after repeated failures or timeouts a slot is bypassed for a cool-down
                 (15 s, doubling to 4 min) and then probed again. While a slot is bypassed the orchestrator uses the
                 documented domain fallback for that stage (and reports it), so a decision is always produced.
    time-boxing  a call that exceeds its budget is abandoned (its thread finishes in the background; the slot stays
                 "busy" until then, further calls are skipped instead of piling up).

Nothing here knows about GangUP; the stage adapters in ``adapters.py`` do.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any, Callable

import traceback

from . import compat, locate

STAGES = ("perception", "learning", "knowledge", "planning", "collaborative", "safety", "evaluation", "observability")


class StageUnavailable(RuntimeError):
    """The real agent is not loaded, disabled, or its circuit breaker is open."""


class StageBusy(RuntimeError):
    """A previous (timed-out) call into the same agent is still running."""


class StageTimeout(TimeoutError):
    """The call did not finish within its budget."""


class Slot:
    def __init__(self, name: str) -> None:
        self.name = name
        self.state = "pending"
        self.instance: Any = None
        self.cls = ""
        self.error: str | None = None
        self.load_ms = 0.0
        self.calls = 0
        self.failures = 0
        self.timeouts = 0
        self.skipped = 0
        self.consecutive = 0
        self.cooldown = 15.0
        self.open_until = 0.0
        self.last_error: str | None = None
        self.last_trace: str | None = None  # traceback of the last exception raised inside the agent (diagnostics)
        self.lat: deque = deque(maxlen=200)
        self.run_lock = threading.Lock()  # real agents are not promised to be re-entrant: one call at a time per agent

    def breaker_open(self) -> bool:
        return time.monotonic() < self.open_until

    def view(self) -> dict:
        lat = sorted(self.lat)
        p = lambda q: round(lat[min(len(lat) - 1, int(q * len(lat)))], 2) if lat else 0.0  # noqa: E731
        return {
            "state": self.state, "class": self.cls, "loadMs": round(self.load_ms), "error": self.error,
            "calls": self.calls, "failures": self.failures, "timeouts": self.timeouts, "skipped": self.skipped,
            "breakerOpen": self.breaker_open(), "lastError": self.last_error, "lastTrace": self.last_trace,
            "latencyMs": {"p50": p(0.5), "p95": p(0.95), "max": round(lat[-1], 2) if lat else 0.0},
        }


class RealAgentHost:
    TRIP_AFTER = 3
    MAX_COOLDOWN = 240.0

    def __init__(self, root: str | None = None, enabled: tuple[str, ...] | list[str] | None = None, log: Callable[[str], None] | None = None,
                 agent_config: dict[str, dict] | None = None, chdir: bool = True) -> None:
        self.requested_root = root
        self.root: str | None = None
        self.enabled = tuple(enabled) if enabled is not None else STAGES
        self.log = log or (lambda msg: print(f"[slai] {msg}", flush=True))
        self.agent_config = agent_config or {}
        self.chdir = chdir
        self.slots: dict[str, Slot] = {n: Slot(n) for n in STAGES}
        for n in STAGES:
            if n not in self.enabled:
                self.slots[n].state = "disabled"
        self.factory: Any = None
        self.shared_memory: Any = None
        self.executor = ThreadPoolExecutor(max_workers=12, thread_name_prefix="slai-real")
        self.started = False
        self.fatal: str | None = None
        self.dropped_background = 0
        self.compat: list[str] = []  # repairs applied to defective SLAI modules (see compat.py)

    # ------------------------------------------------------------------ start-up
    def start(self) -> "RealAgentHost":
        """Locate SLAI, create the factory and shared memory, then create every enabled agent (each isolated)."""
        self.started = True
        for stream in (sys.stdout, sys.stderr):  # the real agents print symbols (check marks, boxes): never let a legacy console codec kill a call
            try:
                stream.reconfigure(errors="replace")  # type: ignore[union-attr]
            except Exception:  # noqa: BLE001
                pass
        root = locate.find_root(self.requested_root)
        if root is None:
            self.fatal = ("could not find the SLAI repository (a folder containing src/agents/agent_factory.py). "
                          "Run from inside <SLAI>/applications/GangUP, or set SLAI_ROOT / pass --slai-root.")
            self._fail_all(self.fatal)
            return self
        self.root = locate.activate(root)
        if self.chdir:
            os.chdir(self.root)  # real agents write evaluation_logs/ etc. relative to the working directory
        self.log(f"SLAI repository: {self.root}")
        try:
            from src.agents.agent_factory import AgentFactory  # type: ignore
            self.factory = AgentFactory()
            try:
                from src.agents.collaborative.shared_memory import SharedMemory  # type: ignore
                self.shared_memory = SharedMemory()
            except Exception as e:  # noqa: BLE001 - SharedMemory is optional for several agents
                self.log(f"SharedMemory unavailable ({type(e).__name__}: {e}); agents will use their own")
        except Exception as e:  # noqa: BLE001
            self.fatal = f"AgentFactory could not be created: {type(e).__name__}: {e}"
            self._fail_all(self.fatal)
            return self
        for name in STAGES:
            slot = self.slots[name]
            if slot.state == "disabled":
                continue
            self._load(slot)
        return self

    def _fail_all(self, reason: str) -> None:
        for s in self.slots.values():
            if s.state != "disabled":
                s.state, s.error = "unavailable", reason

    def _load(self, slot: Slot) -> None:
        slot.state = "loading"
        self.log(f"loading real agent '{slot.name}' ...")
        t0 = time.perf_counter()
        try:
            kwargs: dict[str, Any] = {"shared_memory": self.shared_memory}
            cfg = self.agent_config.get(slot.name)
            if cfg:
                kwargs["config"] = dict(cfg)
            slot.instance = self.factory.create(slot.name, **kwargs)
            if slot.instance is None:
                raise RuntimeError("AgentFactory returned None")
            slot.cls = type(slot.instance).__name__
            for msg in compat.apply():  # modules are loaded now: repair known defects before the first call
                self.compat.append(msg)
                self.log(f"  compat: {msg}")
            slot.state = "ready"
            self.log(f"  ok   {slot.name:<13} {slot.cls} ({(time.perf_counter() - t0):.1f}s)")
        except Exception as e:  # noqa: BLE001
            slot.state = "unavailable"
            slot.error = f"{type(e).__name__}: {str(e)[:400]}"
            self.log(f"  FAIL {slot.name:<13} {slot.error}")
        finally:
            slot.load_ms = (time.perf_counter() - t0) * 1000.0

    def inject(self, name: str, instance: Any) -> None:
        """Install an already-built agent (tests, or an embedding application that owns its own factory)."""
        s = self.slots[name]
        s.instance, s.cls, s.state, s.error = instance, type(instance).__name__, "ready", None

    # ------------------------------------------------------------------ queries
    def usable(self, name: str) -> bool:
        s = self.slots[name]
        return s.state == "ready" and not s.breaker_open()

    def instance(self, name: str) -> Any:
        return self.slots[name].instance

    def ready_count(self) -> int:
        return sum(1 for s in self.slots.values() if s.state == "ready")

    def missing(self) -> list[str]:
        return [n for n, s in self.slots.items() if s.state in ("unavailable", "pending", "loading")]

    # ------------------------------------------------------------------ guarded calls
    def _trip(self, s: Slot) -> None:
        s.consecutive += 1
        if s.consecutive >= self.TRIP_AFTER:
            s.open_until = time.monotonic() + s.cooldown
            s.cooldown = min(self.MAX_COOLDOWN, s.cooldown * 2)
            s.consecutive = 0

    def call(self, name: str, fn: Callable[[Any], Any], budget_s: float | None = None) -> Any:
        """Run ``fn(agent)`` against the real agent with a time budget. Raises StageUnavailable / StageBusy / StageTimeout
        or whatever the agent raised (all counted on the slot)."""
        s = self.slots[name]
        if s.state != "ready":
            raise StageUnavailable(f"{name}: {s.state}")
        if s.breaker_open():
            raise StageUnavailable(f"{name}: circuit open")
        if not s.run_lock.acquire(blocking=False):
            s.skipped += 1
            raise StageBusy(f"{name}: busy (a previous call is still running)")
        t0 = time.perf_counter()
        s.calls += 1
        try:
            fut: Future = self.executor.submit(self._run, s, fn)
        except Exception:  # pragma: no cover - executor shut down
            s.run_lock.release()
            raise
        try:
            out = fut.result(timeout=budget_s)
        except FutureTimeout:
            s.timeouts += 1
            s.last_error = f"timeout after {budget_s * 1000:.0f} ms" if budget_s else "timeout"
            self._trip(s)
            raise StageTimeout(f"{name}: {s.last_error}") from None
        except Exception as e:  # noqa: BLE001
            s.failures += 1
            s.last_error = f"{type(e).__name__}: {str(e)[:300]}"
            s.last_trace = "".join(traceback.format_exception(type(e), e, e.__traceback__))[-2500:]
            self._trip(s)
            raise
        s.consecutive = 0
        s.cooldown = max(15.0, s.cooldown / 2)
        s.lat.append((time.perf_counter() - t0) * 1000.0)
        return out

    def _run(self, s: Slot, fn: Callable[[Any], Any]) -> Any:
        try:
            return fn(s.instance)
        except Exception as e:  # noqa: BLE001 - also reaches calls abandoned after a timeout, whose future nobody reads any more
            s.last_trace = "".join(traceback.format_exception(type(e), e, e.__traceback__))[-2500:]
            raise
        finally:
            s.run_lock.release()

    def background(self, name: str, fn: Callable[[Any], Any]) -> bool:
        """Fire-and-forget (observability, evaluation): never delays a decision, never queues behind a running call."""
        s = self.slots[name]
        if s.state != "ready" or s.breaker_open() or not s.run_lock.acquire(blocking=False):
            self.dropped_background += 1
            return False
        s.calls += 1

        def job() -> None:
            t0 = time.perf_counter()
            try:
                fn(s.instance)
                s.consecutive = 0
                s.lat.append((time.perf_counter() - t0) * 1000.0)
            except Exception as e:  # noqa: BLE001
                s.failures += 1
                s.last_error = f"{type(e).__name__}: {str(e)[:300]}"
                s.last_trace = "".join(traceback.format_exception(type(e), e, e.__traceback__))[-2500:]
                self._trip(s)
            finally:
                s.run_lock.release()

        try:
            self.executor.submit(job)
        except Exception:  # pragma: no cover
            s.run_lock.release()
            return False
        return True

    # ------------------------------------------------------------------ reporting
    def status(self) -> dict:
        return {
            "root": self.root, "fatal": self.fatal, "ready": self.ready_count(), "total": len(self.enabled),
            "droppedBackground": self.dropped_background, "compat": list(self.compat),
            "agents": {n: s.view() for n, s in self.slots.items()},
        }

    def close(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=True)
