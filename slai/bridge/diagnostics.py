"""``python -m slai.bridge`` : load every real SLAI agent, push synthetic decisions through the whole pipeline, and report
what each agent actually did (real / fallback + reason), how long it took and what failed.

Exit status 0 only when all eight stages were served by the real agents on every probe decision.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import time

from .. import __version__
from ..orchestrator import Orchestrator
from .host import STAGES

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def sample_observation(tick: int = 600, hostile: int = 3, seed: int = 4242, gap: float = 22.0) -> dict:
    with open(os.path.join(DATA, "terrain.json"), "r", encoding="utf-8") as f:
        t = json.load(f)
    team, mx, my = 1, 92.0, 30.0
    soldiers, squads, nid = [], [], 10
    for slot in range(1, 10):
        members = []
        if slot in (1, 2, 3):
            for k in range(6):
                soldiers.append({"id": nid, "x": mx - 6 + k * 0.5, "y": my + (slot - 2) * 3, "theta": 0.0, "hp": 30.0, "shield": 8.0, "squad": slot,
                                 "guard": False, "ammo": 24, "task": "Idle"})
                members.append(nid)
                nid += 1
        squads.append({"slot": slot, "members": members, "leader": members[0] if members else -1,
                       "move": {"kind": "Hold", "x": mx - 6, "y": my, "followId": -1}, "doctrine": "Defend", "formation": "Compact",
                       "target": {"kind": "none", "id": -1, "x": 0, "y": 0}, "blocked": 0,
                       "centroid": {"x": mx - 6, "y": my + (slot - 2) * 3} if members else None, "avgHp": 1.0 if members else 0.0, "avgAmmo": 24.0 if members else 0.0})
    for _ in range(4):  # unassigned pool -> exercises squad organisation
        soldiers.append({"id": nid, "x": mx - 3, "y": my + 1, "theta": 0.0, "hp": 30.0, "shield": 8.0, "squad": 0, "guard": False, "ammo": 24, "task": "Idle"})
        nid += 1
    vis = [{"id": 1000 + i, "kind": "soldier", "x": mx - gap - i * 0.3, "y": my + 1.5 * i - 4, "theta": 0.0, "hp": 30.0, "shield": 8.0} for i in range(hostile)]
    return {
        "schema": "gangup.obs.v1", "version": "0.3", "seed": seed, "tick": tick, "time": tick / 60.0, "generation": 1, "team": team, "difficulty": "normal",
        "own": {"main": {"id": 2, "x": mx, "y": my, "theta": 3.14, "hp": 80.0, "shield": 25.0, "alive": True, "mode": "rifle", "ammo": 50, "mag": 10,
                         "strain": 0.0, "shieldMax": 25.0},
                "soldiers": soldiers, "soldierCount": len(soldiers), "stance": "defensive",
                "streak": {"active": False, "remaining": 0.0, "cooldown": 0.0, "killsInWindow": 0}},
        "squads": squads, "unassigned": [s["id"] for s in soldiers if s["squad"] == 0],
        "enemies": {"visible": vis, "lastKnown": [], "enemyStreakActive": False},
        "terrain": {"width": t["width"], "height": t["height"], "obstacles": copy.deepcopy(t["obstacles"]), "supply": t["supply"],
                    "zone": t["zones"][team], "enemyZone": t["zones"][1 - team]},
        "resources": {"pickup": {"x": t["supply"]["x"], "y": t["supply"]["y"]} if isinstance(t.get("supply"), dict) and "x" in t["supply"] else None,
                      "nextPickupIn": 12.0, "nextWaveIn": 9.0, "waveBase": 5},
        "legal": {"stances": ["defensive", "offensive"], "doctrines": ["Defend", "Press", "Harass", "Disengage"], "formations": ["Compact", "Line", "Spread"],
                  "mainGoals": ["Engage", "MoveTo", "Retreat", "HoldNear", "Resupply"], "freeSlots": [4, 5, 6, 7, 8, 9], "maxSquadSize": 10},
        "budget": {"deadlineMs": 2000, "maxActions": 24},
    }


def probe_roles(orch: Orchestrator) -> dict:
    """Force the situations the CollaborativeAgent exists for: two squads claiming the same supply, two claiming flank lanes, a
    threatened Main needing an escort, and a reckless attack against superior numbers."""
    import time as _t

    from ..agents import Context
    from ..agents.perception import build_situation

    obs = sample_observation(hostile=12, gap=9.0)
    obs["resources"]["pickup"] = {"x": 50.0, "y": 30.0}
    ctx = Context(obs=obs, deadline=_t.monotonic() + 5.0)
    ctx.situation = build_situation(obs)
    ctx.situation["danger"] = True
    before = {1: "ContestSupply", 2: "ContestSupply", 3: "PressTarget"}
    ctx.objectives = dict(before)
    orch.collaborative._deconflict(ctx, obs, ctx.situation)
    ctx2 = Context(obs=obs, deadline=_t.monotonic() + 5.0)
    ctx2.situation = build_situation(obs)
    ctx2.situation["danger"] = False
    before2 = {1: "HarassFlank", 2: "HarassFlank", 3: "PressTarget"}
    ctx2.objectives = dict(before2)
    orch.collaborative._deconflict(ctx2, obs, ctx2.situation)
    return {"supplyAndEscort": {"before": before, "after": dict(ctx.objectives), "stage": ctx.flags.get("stages", {}).get("collaborative"), "notes": ctx.notes},
            "lanesAndRisk": {"before": before2, "after": dict(ctx2.objectives), "lanes": ctx2.flags.get("lanes"), "stage": ctx2.flags.get("stages", {}).get("collaborative"), "notes": ctx2.notes}}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m slai.bridge", description="Diagnose the real-SLAI-agent integration")
    ap.add_argument("--slai-root", default=None)
    ap.add_argument("--decisions", type=int, default=6, help="number of synthetic decisions to run (default 6)")
    ap.add_argument("--json", action="store_true", help="print the full machine-readable report")
    ap.add_argument("--only", default=None, help="comma separated stage names to load (default: all eight)")
    args = ap.parse_args(argv)
    enabled = tuple(x.strip() for x in args.only.split(",")) if args.only else STAGES
    print(f"GangUP SLAI bridge diagnostics (service {__version__})\n")
    t0 = time.time()
    from .host import RealAgentHost
    from . import GANGUP_AGENT_CONFIG

    host = RealAgentHost(root=args.slai_root, enabled=enabled, agent_config=GANGUP_AGENT_CONFIG, log=lambda m: print("  " + m, flush=True)).start()
    orch = Orchestrator(agents="real", host=host)
    print(f"\nloaded {host.ready_count()}/{len(host.enabled)} real agents in {time.time() - t0:.1f}s\n")

    per_stage: dict = {n: [] for n in STAGES}
    errors: list = []
    lat = []
    for i in range(args.decisions):
        obs = sample_observation(tick=600 + i * 30, hostile=3 + (i % 3) * 4)
        t1 = time.perf_counter()
        try:
            resp = orch.decide(obs)
        except Exception as e:  # noqa: BLE001
            errors.append(f"decision {i}: {type(e).__name__}: {e}")
            continue
        lat.append((time.perf_counter() - t1) * 1000)
        meta = resp["meta"]
        for n in STAGES:
            per_stage[n].append(meta["stages"].get(n, "-"))
        if meta.get("errors"):
            errors.append(f"decision {i}: stage errors {meta['errors']}")
    if orch.safety.mode == "async" and host.usable("safety") and lat:
        # a real review takes seconds: wait for the background reviews, then show that their verdicts now apply to the same order shapes
        end = time.time() + 60.0
        while orch.safety.inflight and time.time() < end:
            time.sleep(0.25)
        for i in range(args.decisions):
            obs = sample_observation(tick=600 + i * 30, hostile=3 + (i % 3) * 4)
            resp = orch.decide(obs)
            per_stage["safety"].append(resp["meta"]["stages"].get("safety", "-"))
        print(f"SafetyAgent (async mode): {orch.safety.dispatched} reviews dispatched, {orch.safety.cache_hits} decisions then served from its verdicts, "
              f"last verdict {json.dumps(orch.safety.last, default=str)}")
    try:
        orch.observability.flush()  # push the pending batch to the real ObservabilityAgent now
    except Exception as e:  # noqa: BLE001
        errors.append(f"observability flush: {type(e).__name__}: {e}")
    roles = {}
    if host.usable("collaborative"):
        try:
            roles = probe_roles(orch)
        except Exception as e:  # noqa: BLE001
            errors.append(f"role probe: {type(e).__name__}: {e}")
    if host.usable("evaluation"):
        try:  # the periodic forecast would only fire after 60 decisions: ask once, now, and wait for the answer
            probe_eval = orch.evaluation.probe()
            print(f"EvaluationAgent.predict probe: {json.dumps(probe_eval, default=str)}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"evaluation probe: {type(e).__name__}: {e}")
    time.sleep(3.0)  # let background calls (learning / evaluation / observability) finish
    orch.match_end(4242, 1, 1)
    time.sleep(1.0)

    st = host.status()
    ok_all = True
    print(f"{'stage':<14}{'loaded':<13}{'served by':<34}{'calls':>6}{'fail':>6}{'t/o':>5}{'p50 ms':>9}{'p95 ms':>9}")
    for n in STAGES:
        sl = st["agents"][n]
        served = per_stage[n]
        real = sum(1 for x in served if str(x).startswith("real"))
        pending = sum(1 for x in served if "async" in str(x))
        label = (f"{real}/{len(served)} real" + (f" ({pending} async)" if pending else "")) if served else "-"
        # "real" must mean the agent actually answered: loaded, served every decision, called at least once, no failures or timeouts
        stage_ok = sl["state"] == "ready" and served and real == len(served) and sl["calls"] > 0 and sl["failures"] == 0 and sl["timeouts"] == 0
        ok_all &= bool(stage_ok)
        print(f"{n:<14}{sl['state']:<13}{label:<34}{sl['calls']:>6}{sl['failures']:>6}{sl['timeouts']:>5}{sl['latencyMs']['p50']:>9}{sl['latencyMs']['p95']:>9}")
    print()
    for n in STAGES:
        sl = st["agents"][n]
        if sl["error"]:
            print(f"[{n}] LOAD ERROR: {sl['error']}")
        reasons = sorted({x for x in per_stage[n] if not str(x).startswith("real") and x != "-"})
        for r in reasons:
            print(f"[{n}] fallback used: {r}")
        if sl["lastError"]:
            print(f"[{n}] last runtime error: {sl['lastError']}")
        if sl["lastTrace"] and (sl["failures"] or sl["timeouts"]):
            print(f"[{n}] traceback (most recent call last):")
            for line in sl["lastTrace"].rstrip().splitlines()[-14:]:
                print("      " + line)
    if st.get("compat"):
        print("\nrepairs applied to defects in the SLAI checkout (nothing on disk was changed):")
        for c in st["compat"]:
            print("  -", c)
    for e in errors:
        print("ERROR", e)
    if lat:
        print(f"\ndecision latency over {len(lat)} runs: min {min(lat):.0f} ms, max {max(lat):.0f} ms (budget used here: 2000 ms; the game uses 400/1100/150 ms)")
    stats = orch.stats()
    if roles:
        print("\nCollaborativeAgent role probe (forced contest):")
        for k, v in roles.items():
            print(f"  {k}: {v['before']} -> {v['after']}  [{v['stage']}]" + (f" lanes={v['lanes']}" if v.get('lanes') else "") + (f"  {v['notes']}" if v['notes'] else ""))
    print("real-agent use:", json.dumps(stats.get("realUse", {}), default=str))
    if args.json:
        print(json.dumps({"status": st, "perStage": per_stage, "errors": errors, "stats": stats}, default=str, indent=1))
    print("\nRESULT:", "all eight stages served by the real SLAI agents" if ok_all and not errors else "NOT all stages are served by real agents (see lines above)")
    host.close()
    return 0 if ok_all and not errors else 1


if __name__ == "__main__":
    sys.exit(main())
