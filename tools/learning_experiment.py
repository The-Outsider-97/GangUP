"""Train -> validate -> gate -> restore -> test experiment for GangUP's persistent learning (real engine, real service).

Protocol (all numbers come from real headless engine matches; nothing is simulated):

  seeds      train 100000+ | validation 20000+ | test 30000+ (the test seeds are used once, after the candidate is chosen)
  design     every seed is played on BOTH sides (mirrored); a seed's two games are one paired observation
  opponent   the engine's scripted baseline director at --difficulty
  arms       imitation        learning=off (the shipped imitation policy = "previous production")
             untrained        learning=evaluate on an empty state dir (must equal imitation game for game)
             candidate        learning=evaluate restored from the trained checkpoint, in a *fresh process*
  training   learning=train, one service per hyper-parameter config, ``--train-games`` games each
  selection  by validation paired difference against imitation only
  gate       the selected candidate is promoted only if the lower 95% bootstrap bound of its validation improvement is
             > --gate-lower (default 0 = demonstrated improvement); otherwise it is rolled back (production stays imitation)
  checks     evaluation never trains (parameter hash / training step / optimizer steps unchanged), restore determinism
             (two independent restores play identical games), candidate vs imitation head to head via --url-green/--url-red

Usage:  python tools/learning_experiment.py --out /tmp/exp --configs '[{"name":"c1","hyper":{...}}]'
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from learning_lib import ROOT, Service, fresh_dir, paired_diff, per_seed, play, score, slai_score, summarize, wilson  # noqa: E402


def mirrored(url: str, seeds: int, seed0: int, out: str, learn: bool, **kw) -> list[dict]:
    """``seeds`` engine seeds, each played with the learner on both sides (two runs with opposite starting sides)."""
    rows = play("slai", seeds, seed0, url, out, learn=learn, slai_team=1, **kw)
    rows += play("slai", seeds, seed0, url, out, learn=learn, slai_team=0, **kw)
    return rows


def games_key(rows: list[dict]) -> list:
    return sorted((r["seed"], r["slaiTeam"], r["winner"], r["reason"], round(r["seconds"], 3), tuple(r["kills"]) if r.get("kills") is not None else None) for r in rows)


def head_state(svc: Service) -> dict:
    st = svc.get("/v1/learning")
    return {h: {"hash": v["parameterHash"], "step": v["trainingStep"], "consumed": v["consumedEpisodes"]} for h, v in st["heads"].items()} | {
        "optimizerSteps": st["pipeline"]["optimizerSteps"], "checkpointsRestored": st["pipeline"]["checkpointsRestored"]}


def train(cfg: dict, args, workdir: str, port: int) -> dict:
    d = fresh_dir(workdir)
    svc = Service(port, "train", d + "/state", d + "/adaptive.json", cfg["hyper"], cfg.get("batch", 4), cfg.get("shaping", 0.3), cfg.get("seed", 1),
                  env={"SLAI_ROOT": args.slai_root}, log=d + "/service.log")
    rows, curve = [], []
    t0 = time.time()
    try:
        chunk = 20
        for i in range(0, args.train_games, chunk):
            part = play("slai", chunk, 100000 + i, svc.url, d + "/train.jsonl", slai_team=1)
            rows += part
            s = svc.get("/v1/learning")
            curve.append({"games": i + chunk, "scoreRate": summarize(part)["scoreRate"], "optimizerSteps": s["pipeline"]["optimizerSteps"],
                          "heads": {h: {"step": v["trainingStep"], "paramDelta": v["lastUpdate"]["param_delta_norm"], "grad": v["lastUpdate"]["grad_norm"]}
                                    for h, v in s["heads"].items()}})
            print(f"[train {cfg['name']}] {i + chunk}/{args.train_games} last{chunk}={curve[-1]['scoreRate']:.2f} steps={curve[-1]['optimizerSteps']}", flush=True)
        final = svc.get("/v1/learning")
    finally:
        svc.stop(graceful=True)  # SIGTERM: flush + checkpoint
    return {"config": cfg, "seconds": round(time.time() - t0), "curve": curve, "trainSummary": summarize(rows), "stateDir": d + "/state",
            "pipeline": final["pipeline"], "ledger": final["ledger"], "heads": {h: {k: v[k] for k in ("trainingStep", "consumedEpisodes", "parameterHash", "checkpointId")} for h, v in final["heads"].items()}}


def evaluate_arm(name: str, state: str | None, mode: str, seeds: int, seed0: int, args, port: int, out: str, hyper: dict | None = None) -> dict:
    """One fresh service process (restore happens here), mirrored games with learning feedback disabled in the client."""
    work = fresh_dir(out + f"/{name}")
    if state:
        shutil.copytree(state, work + "/state", dirs_exist_ok=True)  # evaluation must not touch the candidate's own files
    svc = Service(port, mode, work + "/state" if state else (work + "/state"), work + "/adaptive.json", hyper, 4, 0.3, 0,
                  env={"SLAI_ROOT": args.slai_root}, log=work + "/service.log")
    try:
        before = head_state(svc) if mode != "off" else None
        rows = mirrored(svc.url, seeds, seed0, work + "/games.jsonl", learn=False)
        after = head_state(svc) if mode != "off" else None
    finally:
        svc.stop(graceful=True)
    return {"name": name, "rows": rows, "summary": summarize(rows), "before": before, "after": after}


def parallel(jobs: list) -> list:
    out = [None] * len(jobs)

    def run(i, fn):
        try:
            out[i] = fn()
        except Exception as e:  # noqa: BLE001
            out[i] = {"error": f"{type(e).__name__}: {e}"}
            print("JOB FAILED:", out[i], flush=True)

    ts = [threading.Thread(target=run, args=(i, f)) for i, f in enumerate(jobs)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return out


def head_to_head(cand_state: str, seeds: int, seed0: int, args, port: int, out: str) -> dict:
    """Candidate (evaluate) against the imitation policy, both through the same engine; each seed on both sides."""
    work = fresh_dir(out + "/h2h")
    shutil.copytree(cand_state, work + "/state")
    a = Service(port, "evaluate", work + "/state", work + "/adaptive-a.json", None, 4, 0.3, 0, env={"SLAI_ROOT": args.slai_root}, log=work + "/cand.log")
    b = Service(port + 1, "off", None, work + "/adaptive-b.json", None, 4, 0.3, 0, env={"SLAI_ROOT": args.slai_root}, log=work + "/imit.log")
    rows = []
    try:
        for cand_green in (True, False):
            urls = (a.url, b.url) if cand_green else (b.url, a.url)
            part = play("selfplay", seeds, seed0, urls=urls, out=work + "/games.jsonl", learn=False)
            for r in part:
                r["candTeam"] = 0 if cand_green else 1
            rows += part
    finally:
        a.stop()
        b.stop()
    pts = []
    for r in rows:
        pts.append(0.5 if r.get("timedOut") or r.get("winner") is None else (1.0 if r["winner"] == r["candTeam"] else 0.0))
    n = len(rows)
    per = {}
    for r, p in zip(rows, pts):
        per.setdefault(r["seed"], []).append(p)
    seedmean = {s: sum(v) / len(v) for s, v in per.items()}
    lo, hi = wilson(sum(pts), n)
    return {"games": n, "candidateWins": sum(1 for p in pts if p == 1.0), "candidateLosses": sum(1 for p in pts if p == 0.0), "drawsOrTimeouts": sum(1 for p in pts if p == 0.5),
            "candidateScoreRate": sum(pts) / n if n else None, "candidateScoreRate95": [lo, hi],
            "vsEven": paired_diff({s: 0.5 for s in seedmean}, seedmean)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--configs", required=True, help='JSON list of {"name", "hyper", "batch"?, "shaping"?}')
    ap.add_argument("--train-games", type=int, default=240)
    ap.add_argument("--val-seeds", type=int, default=24)
    ap.add_argument("--test-seeds", type=int, default=40)
    ap.add_argument("--gate-lower", type=float, default=0.0)
    ap.add_argument("--slai-root", default=os.environ.get("SLAI_ROOT", ""))
    ap.add_argument("--port", type=int, default=19100)
    ap.add_argument("--skip-test", action="store_true")
    args = ap.parse_args()
    os.environ["SLAI_ROOT"] = args.slai_root
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    configs = json.loads(args.configs)
    report: dict = {"protocol": {"trainSeeds": "100000+", "validationSeeds": f"20000..{20000 + args.val_seeds - 1}", "testSeeds": f"30000..{30000 + args.test_seeds - 1}",
                                 "design": "each seed on both sides (mirrored); paired by seed", "gateLower": args.gate_lower, "trainGames": args.train_games}}

    def save():
        with open(out + "/report.json", "w") as f:
            json.dump(report, f, indent=1, default=str)

    # 1. train every config (two at a time: the machine has two cores) while nothing else competes for them
    trained = []
    for i in range(0, len(configs), 2):
        batch = configs[i:i + 2]
        trained += parallel([(lambda c=c, j=j: train(c, args, out + f"/train-{c['name']}", args.port + 10 * (i + j))) for j, c in enumerate(batch)])
    report["training"] = {t["config"]["name"]: {k: v for k, v in t.items() if k != "config"} | {"config": t["config"]} for t in trained if "error" not in t}
    report["trainingFailures"] = [t for t in trained if "error" in t]
    save()

    # 2. validation: imitation, untrained-evaluate, and every candidate
    jobs = [lambda: evaluate_arm("val-imitation", None, "off", args.val_seeds, 20000, args, args.port + 100, out),
            lambda: evaluate_arm("val-untrained", None, "evaluate", args.val_seeds, 20000, args, args.port + 110, out)]
    for k, t in enumerate(x for x in trained if "error" not in x):
        jobs.append(lambda t=t, k=k: evaluate_arm("val-" + t["config"]["name"], t["stateDir"], "evaluate", args.val_seeds, 20000, args, args.port + 120 + 10 * k, out))
    res = {r["name"]: r for r in parallel_n(jobs, 2) if r and "error" not in r}
    imit, untr = res["val-imitation"], res.get("val-untrained")
    ref = per_seed(imit["rows"])
    val: dict = {"imitation": imit["summary"], "untrained": untr["summary"] if untr else None,
                 "untrainedEqualsImitationGameForGame": bool(untr) and games_key(untr["rows"]) == games_key(imit["rows"]),
                 "untrainedStateUnchanged": bool(untr) and untr["before"] == untr["after"]}
    cand = {}
    for t in trained:
        if "error" in t:
            continue
        n = "val-" + t["config"]["name"]
        r = res.get(n)
        if not r:
            continue
        cand[t["config"]["name"]] = {"summary": r["summary"], "vsImitation": paired_diff(ref, per_seed(r["rows"])), "evalDidNotTrain": r["before"] == r["after"]}
    val["candidates"] = cand
    report["validation"] = val
    save()
    if not cand:
        report["decision"] = {"promoted": False, "reason": "no candidate could be evaluated"}
        save()
        return
    best = max(cand, key=lambda n: cand[n]["vsImitation"]["mean"])
    lower = cand[best]["vsImitation"]["ci95"][0]
    promote = lower > args.gate_lower
    report["decision"] = {"selected": best, "validationImprovement": cand[best]["vsImitation"], "gate": f"lower 95% bound > {args.gate_lower}", "promoted": promote,
                          "action": "candidate promoted" if promote else "ROLLED BACK: production stays the imitation policy (previous production)"}
    save()
    if args.skip_test:
        return

    # 3. test (touched once) for the selected candidate, whether or not it was promoted
    bt = next(t for t in trained if "error" not in t and t["config"]["name"] == best)
    ts = args.test_seeds
    jobs = [lambda: evaluate_arm("test-imitation", None, "off", ts, 30000, args, args.port + 300, out),
            lambda: evaluate_arm("test-candidate", bt["stateDir"], "evaluate", ts, 30000, args, args.port + 310, out)]
    tr = {r["name"]: r for r in parallel_n(jobs, 2) if r and "error" not in r}
    ti, tc = tr["test-imitation"], tr["test-candidate"]
    report["test"] = {"imitation": ti["summary"], "candidateRestoredFreshProcess": tc["summary"], "candidateVsImitation": paired_diff(per_seed(ti["rows"]), per_seed(tc["rows"])),
                      "evalDidNotTrain": tc["before"] == tc["after"], "candidateHeadsRestored": tc["before"]}
    save()
    # 4. restore determinism: a second independent restore must play the same games on a small seed set
    k = max(4, ts // 5)
    r1 = evaluate_arm("det-1", bt["stateDir"], "evaluate", k, 30000, args, args.port + 320, out)
    r2 = evaluate_arm("det-2", bt["stateDir"], "evaluate", k, 30000, args, args.port + 330, out)
    report["restoreDeterminism"] = {"seeds": k, "identicalGames": games_key(r1["rows"]) == games_key(r2["rows"])}
    # 5. head to head
    report["headToHead"] = head_to_head(bt["stateDir"], max(10, ts // 2), 31000, args, args.port + 340, out)
    save()
    print(json.dumps({k2: report[k2] for k2 in ("decision", "test", "restoreDeterminism", "headToHead")}, indent=1, default=str))


def parallel_n(jobs: list, width: int) -> list:
    out = []
    for i in range(0, len(jobs), width):
        out += parallel(jobs[i:i + width])
    return out


if __name__ == "__main__":
    main()
