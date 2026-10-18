"""Shared agent plumbing: a Context travels through the pipeline; every agent is isolated and time-boxed."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Context:
    obs: dict
    deadline: float  # absolute monotonic deadline (seconds)
    situation: dict = field(default_factory=dict)
    features: dict = field(default_factory=dict)
    objectives: dict = field(default_factory=dict)  # squad slot -> chosen objective
    main_objective: str = "HoldNear"
    stance: str = "defensive"
    actions: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    knowledge: list = field(default_factory=list)
    timings: dict = field(default_factory=dict)
    errors: dict = field(default_factory=dict)
    flags: dict = field(default_factory=dict)
    confidence: float = 1.0

    def time_left(self) -> float:
        return self.deadline - time.monotonic()


class Agent:
    """Base class. Subclasses set `name` and implement `run(ctx)`."""

    name = "agent"

    def run(self, ctx: Context) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def safe_run(self, ctx: Context) -> bool:
        t0 = time.perf_counter()
        try:
            self.run(ctx)
            return True
        except Exception as e:  # noqa: BLE001 - an agent failure must never take the service down
            ctx.errors[self.name] = f"{type(e).__name__}: {e}"
            return False
        finally:
            ctx.timings[self.name] = (time.perf_counter() - t0) * 1000.0
