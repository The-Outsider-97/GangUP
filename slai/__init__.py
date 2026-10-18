"""SLAI — Self-Learning Artificial Intelligence for GangUP (GDD v0.3, chapters 12–13).

A standalone, dependency-free (Python stdlib only) decision service. The authoritative TypeScript game engine owns
physics, damage, visibility and victory; SLAI only *proposes* validated commands from legal observations.
"""

__version__ = "0.3.0"
OBS_SCHEMA = "gangup.obs.v1"
ACT_SCHEMA = "gangup.act.v1"
