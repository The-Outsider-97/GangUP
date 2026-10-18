"""Load-time repairs for defects in the SLAI repository that make a real agent fail on every call.

GangUP never edits files in the SLAI checkout. When an agent is created through ``AgentFactory`` and one of the known
defects below is present in the *loaded module object*, the bridge repairs that module in memory (and says so in its
log / ``/v1/health``). If SLAI fixes the defect upstream the check finds nothing to repair and the patch is a no-op.

Known defects (found by running ``python -m slai.bridge`` against the checkout):

* ``src/agents/base/modules/base_tokenizer.py`` calls ``cast(Literal[...], ...)`` (lines ~397 and ~678) but never imports
  ``Literal``. Every ``BaseTokenizer`` text normalisation, and therefore ``PerceptionAgent`` text inference, raises
  ``NameError: name 'Literal' is not defined``.   Upstream fix: add ``Literal`` to the ``from typing import ...`` line.

* ``src/agents/planning_agent.py`` imports SLAI's own ``Any`` class from ``planning_types`` and then runs
  ``from .planning.utils.planning_errors import *``; ``planning_errors`` has no ``__all__`` and does ``from typing import Any``,
  so ``Any`` becomes ``typing.Any`` and ``isinstance(value, Any)`` raises
  ``TypeError: typing.Any cannot be used with isinstance()`` in ``get_current_state_tuple`` (hence in every
  ``decompose_task``).   Upstream fix: re-import ``Any`` after the star imports, or give ``planning_errors`` an ``__all__``.

* ``src/agents/perception/modules/tokenizer.py``: ``BytePairEncoder.bpe`` loops ``min(pairs, ...)`` until no merge applies,
  but when the merges fold a word into a single symbol (``('ab</w>',)``) ``pairs`` is empty and ``min`` raises
  ``ValueError: min() iterable argument is empty``; every text containing such a word fails.
  Upstream fix: ``while len(word) > 1:`` (or ``if not pairs: break``) around the merge loop.
"""
from __future__ import annotations

import sys
import typing
from typing import Callable


def _tokenizer_literal() -> str | None:
    mod = sys.modules.get("src.agents.base.modules.base_tokenizer")
    if mod is None or hasattr(mod, "Literal"):
        return None
    mod.Literal = typing.Literal  # type: ignore[attr-defined]
    return "base_tokenizer: added the missing `Literal` import (PerceptionAgent text inference)"


def _planning_any() -> str | None:
    mod = sys.modules.get("src.agents.planning_agent")
    types = sys.modules.get("src.agents.planning.planning_types")
    if mod is None or types is None:
        return None
    own = getattr(types, "Any", None)
    if own is None or own is typing.Any or getattr(mod, "Any", None) is own:
        return None
    mod.Any = own  # type: ignore[attr-defined]
    return "planning_agent: restored SLAI's `Any` class that `planning_errors import *` replaced with typing.Any (PlanningAgent.decompose_task)"


def _fixed_bpe(self, token: str) -> list:
    """BytePairEncoder.bpe with the single-symbol guard; otherwise identical to SLAI's implementation."""
    if token in self.cache:
        return self.cache[token]
    if not token:
        return [self.unk_token]
    word = tuple(token) + ("</w>",)
    pairs = self.get_pairs(word)
    if not pairs:
        return [token] if token in self.word_to_id else [self.unk_token]
    while len(word) > 1:  # the guard: a word merged into one symbol has no pairs left
        pairs = self.get_pairs(word)
        bigram = min(pairs, key=lambda pair: self.bpe_ranks.get(pair, float("inf")))
        if bigram not in self.bpe_ranks:
            break
        first, second = bigram
        new_word: list = []
        i = 0
        while i < len(word):
            try:
                j = word.index(first, i)
            except ValueError:
                new_word.extend(word[i:])
                break
            new_word.extend(word[i:j])
            i = j
            if i < len(word) - 1 and word[i] == first and word[i + 1] == second:
                new_word.append(first + second)
                i += 2
            else:
                new_word.append(word[i])
                i += 1
        word = tuple(new_word)
    if word and word[-1] == "</w>":
        word = word[:-1]
    result = list(word)
    self.cache[token] = result
    return result


def _perception_bpe() -> str | None:
    mod = sys.modules.get("src.agents.perception.modules.tokenizer")
    cls = getattr(mod, "BytePairEncoder", None)
    if cls is None or getattr(cls.bpe, "_gangup_fixed", False):
        return None
    try:  # probe for the defect: merges that fold the word "ab" into the single symbol "ab</w>"
        cls([("a", "b"), ("ab", "</w>")], {}, "[UNK]").bpe("ab")
        return None
    except ValueError:
        pass
    except Exception:  # noqa: BLE001 - a different problem: not ours to repair
        return None
    _fixed_bpe._gangup_fixed = True  # type: ignore[attr-defined]
    cls.bpe = _fixed_bpe  # type: ignore[method-assign]
    return "perception tokenizer: BytePairEncoder.bpe no longer crashes when merges fold a word into one symbol (PerceptionAgent text inference)"


PATCHES: tuple[Callable[[], str | None], ...] = (_tokenizer_literal, _planning_any, _perception_bpe)


def apply() -> list[str]:
    """Run every repair whose target module is loaded and still defective; returns what was repaired (idempotent)."""
    done: list[str] = []
    for patch in PATCHES:
        try:
            msg = patch()
        except Exception:  # noqa: BLE001 - a failed repair must never take the host down
            msg = None
        if msg:
            done.append(msg)
    return done
