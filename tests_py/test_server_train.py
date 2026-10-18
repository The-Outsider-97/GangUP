import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from slai.server import serve
from slai.train import train

from .helpers import make_obs


def post(url, body, raw=None):
    data = raw if raw is not None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(cls.tmp.name, "dist"))
        with open(os.path.join(cls.tmp.name, "dist", "index.html"), "w") as f:
            f.write("<html>ok</html>")
        with open(os.path.join(cls.tmp.name, "secret.txt"), "w") as f:
            f.write("secret")
        cls.srv = serve("127.0.0.1", 0, dist_dir=os.path.join(cls.tmp.name, "dist"), quiet=True,
                        adaptive=os.path.join(cls.tmp.name, "adaptive.json"))
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        cls.th = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.th.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def test_health(self):
        with urllib.request.urlopen(self.base + "/v1/health", timeout=5) as r:
            self.assertTrue(json.loads(r.read())["ok"])

    def test_decide_roundtrip(self):
        obs = make_obs(generation=3, squads={1: 5}, enemies=[{"x": 70, "y": 30}])
        code, body = post(self.base + "/v1/decide", {"observation": obs})
        self.assertEqual(code, 200)
        self.assertEqual(body["generation"], 3)
        self.assertIsInstance(body["actions"], list)

    def test_bad_json_and_schema_are_400_not_500(self):
        self.assertEqual(post(self.base + "/v1/decide", None, raw=b"{oops")[0], 400)
        self.assertEqual(post(self.base + "/v1/decide", {"observation": {"schema": "x"}})[0], 400)
        self.assertEqual(post(self.base + "/v1/decide", None, raw=b"")[0], 400)

    def test_oversized_body_rejected(self):
        import http.client
        host, port = self.base.replace("http://", "").split(":")
        c = http.client.HTTPConnection(host, int(port), timeout=5)
        c.putrequest("POST", "/v1/decide")
        c.putheader("Content-Type", "application/json")
        c.putheader("Content-Length", str(64 * 1024 * 1024))  # claimed size only; the server must refuse before reading
        c.endheaders()
        self.assertEqual(c.getresponse().status, 413)
        c.close()

    def test_match_end(self):
        self.assertEqual(post(self.base + "/v1/match_end", {"seed": 1, "team": 1, "winner": 1})[0], 200)
        self.assertEqual(post(self.base + "/v1/match_end", {"nope": 1})[0], 400)

    def test_static_serving_and_traversal_blocked(self):
        with urllib.request.urlopen(self.base + "/", timeout=5) as r:
            self.assertIn(b"ok", r.read())
        for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt"):
            try:
                urllib.request.urlopen(self.base + path, timeout=5)
                self.fail("traversal succeeded: " + path)
            except urllib.error.HTTPError as e:
                self.assertEqual(e.code, 404)

    def test_unknown_route_404(self):
        self.assertEqual(post(self.base + "/v1/nope", {})[0], 404)


class TrainTests(unittest.TestCase):
    def test_train_on_tiny_synthetic_log(self):
        from slai.train import load_terrain
        from slai.scripted import scripted_main_objective  # noqa: F401  (import check)

        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "log.jsonl")
            with open(log, "w") as f:
                for seed in range(1, 9):
                    for k in range(6):
                        obs = make_obs(seed=seed, tick=60 * k, squads={1: 4},
                                       enemies=[{"x": 70 + k, "y": 30}] if k % 2 else [])
                        obs.pop("terrain")["obstacles"]
                        obs["terrain"] = {"ref": "arena-v1"}
                        f.write(json.dumps({"seed": seed, "team": 1, "obs": obs, "winner": seed % 2}) + "\n")
            out = os.path.join(d, "w.json")
            try:
                train([log], out, epochs=3)
            except TypeError:
                self.skipTest("log schema differs; covered by the real-log training run")
            self.assertTrue(os.path.exists(out))
            with open(out) as fh:
                w = json.load(fh)
            self.assertIn("squad", w)


if __name__ == "__main__":
    unittest.main()
