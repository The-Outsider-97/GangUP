"""Find the SLAI framework checkout (the folder that contains ``src/agents``) and make it importable.

GangUP lives inside the SLAI repository (``<SLAI>/applications/GangUP``). The real agents are imported as
``src.agents.*`` and they in turn import ``checkpointing``, ``logs`` ... so the *repository root* has to be on
``sys.path``. Resolution order:

  1. an explicit path (``--slai-root`` / argument)
  2. the ``SLAI_ROOT`` environment variable
  3. walking up from this file (``.../applications/GangUP/slai/bridge`` -> ... -> repository root)
"""
from __future__ import annotations

import os
import sys

MARKER = os.path.join("src", "agents", "agent_factory.py")


def is_slai_root(path: str | None) -> bool:
    return bool(path) and os.path.isfile(os.path.join(path, MARKER))  # type: ignore[arg-type]


def find_root(explicit: str | None = None) -> str | None:
    """Return the absolute repository root, or None when no SLAI checkout can be found."""
    candidates: list[str] = []
    if explicit:
        candidates.append(explicit)
    env = os.environ.get("SLAI_ROOT")
    if env:
        candidates.append(env)
    here = os.path.dirname(os.path.abspath(__file__))
    cur = here
    for _ in range(8):
        candidates.append(cur)
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    for c in candidates:
        c = os.path.abspath(os.path.expanduser(c))
        if is_slai_root(c):
            return c
    return None


def activate(root: str) -> str:
    """Put the repository root first on ``sys.path`` (idempotent) and return it."""
    root = os.path.abspath(root)
    if not is_slai_root(root):
        raise FileNotFoundError(f"{root!r} is not a SLAI checkout (missing {MARKER})")
    if root in sys.path:
        sys.path.remove(root)
    sys.path.insert(0, root)
    return root
