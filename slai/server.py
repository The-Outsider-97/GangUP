"""SLAI HTTP service (stdlib only) — also serves the built game so a single command runs everything.

  python3 -m slai.server --port 8765            # serves ./dist and the SLAI API
Endpoints:
  GET  /v1/health      liveness + policy info
  GET  /v1/stats       observability snapshot
  POST /v1/decide      {observation, feedback?} -> {schema, generation, actions, meta}
  POST /v1/match_end   {seed, team, winner}      -> post-match learning step
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import __version__
from .orchestrator import Orchestrator
from .policy import DEFAULT_WEIGHTS
from .schema import SchemaError

MAX_BODY = 4 * 1024 * 1024
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_handler(orch: Orchestrator, dist_dir: str, quiet: bool):
    lock = threading.Lock()  # one decision at a time keeps per-match state simple and replays reproducible

    class Handler(BaseHTTPRequestHandler):
        server_version = f"SLAI/{__version__}"

        def log_message(self, fmt, *args):  # noqa: A003
            if not quiet:
                sys.stderr.write("[slai] " + fmt % args + "\n")

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

        def _json(self, code: int, body: dict) -> None:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):  # noqa: N802
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):  # noqa: N802
            path = urlparse(self.path).path
            if path == "/v1/health":
                return self._json(200, {"ok": True, "service": __version__, "policy": orch.policy.version, "trained": orch.policy.trained})
            if path == "/v1/stats":
                return self._json(200, orch.stats())
            return self._static(path)

        def do_POST(self):  # noqa: N802
            path = urlparse(self.path).path
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if n <= 0 or n > MAX_BODY:
                    return self._json(413 if n > MAX_BODY else 400, {"error": "bad body size"})
                body = json.loads(self.rfile.read(n))
            except (ValueError, json.JSONDecodeError):
                return self._json(400, {"error": "invalid json"})
            if path == "/v1/decide":
                try:
                    with lock:
                        resp = orch.decide(body.get("observation"), body.get("feedback"))
                    return self._json(200, resp)
                except SchemaError as e:
                    return self._json(400, {"error": f"schema: {e}"})
                except Exception as e:  # noqa: BLE001
                    orch.observability.note_error()
                    return self._json(500, {"error": f"{type(e).__name__}: {e}"})
            if path == "/v1/match_end":
                try:
                    with lock:
                        out = orch.match_end(int(body["seed"]), int(body["team"]), body.get("winner"))
                    return self._json(200, out)
                except (KeyError, ValueError, TypeError):
                    return self._json(400, {"error": "need seed, team, winner"})
            return self._json(404, {"error": "not found"})

        def _static(self, path: str) -> None:
            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            full = os.path.normpath(os.path.join(dist_dir, rel))
            if not full.startswith(os.path.abspath(dist_dir)) or not os.path.isfile(full):  # no path traversal
                return self._json(404, {"error": "not found", "hint": "run `npm run build` to create dist/"})
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if full.endswith(".js"):
                ctype = "text/javascript"
            with open(full, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)

    return Handler


def serve(host: str = "127.0.0.1", port: int = 8765, dist_dir: str | None = None, weights: str = DEFAULT_WEIGHTS,
          telemetry: str | None = None, quiet: bool = False, adaptive: str | None = None) -> ThreadingHTTPServer:
    orch = Orchestrator(weights_path=weights, adaptive_path=adaptive, telemetry_path=telemetry)
    dist = os.path.abspath(dist_dir or os.path.join(ROOT, "dist"))
    srv = ThreadingHTTPServer((host, port), make_handler(orch, dist, quiet))
    srv.orchestrator = orch  # type: ignore[attr-defined]
    return srv


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="GangUP SLAI service + game host")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--dist", default=None, help="built game directory (default ./dist)")
    ap.add_argument("--weights", default=DEFAULT_WEIGHTS)
    ap.add_argument("--telemetry", default=None, help="append decision telemetry (JSONL) to this file")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    srv = serve(args.host, args.port, args.dist, args.weights, args.telemetry, args.quiet)
    o = srv.orchestrator  # type: ignore[attr-defined]
    print(f"GangUP + SLAI {__version__} on http://{args.host}:{args.port}/  (policy: {o.policy.version}, trained={o.policy.trained})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        srv.server_close()


if __name__ == "__main__":
    main()
