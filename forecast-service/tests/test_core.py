import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))

from forecast_core import InsufficientData, ml_forecast  # noqa: E402
import forecast as api  # noqa: E402


def make_candles(returns, step=300, start=1_700_000_000, price=2000.0, wick=0.0004):
    out, p = [], price
    for i, r in enumerate(returns):
        o, c = p, p * float(np.exp(r))
        out.append({"time": start + i * step, "open": o, "high": max(o, c) * (1 + wick), "low": min(o, c) * (1 - wick), "close": c})
        p = c
    return out


def random_walk(n, seed):
    return make_candles(np.random.default_rng(seed).normal(0, 0.001, n))


def momentum(n, seed, phi=0.4):
    rng = np.random.default_rng(seed)
    r = np.zeros(n)
    for i in range(1, n):
        r[i] = phi * r[i - 1] + rng.normal(0, 0.001)
    return make_candles(r)


class ForecastTests(unittest.TestCase):
    def test_random_walk_gives_no_edge(self):
        """If the backtest leaked future data, a pure random walk would score well above 50 %."""
        rates = []
        for seed in (1, 2, 3):
            f = ml_forecast(random_walk(1000, seed), 5, 30)
            rates.append(f["backtestHitRate"])
            self.assertGreater(f["backtestSamples"], 100)
        self.assertTrue(all(r is not None for r in rates))
        self.assertLess(abs(float(np.mean(rates)) - 0.5), 0.05, rates)

    def test_detects_real_signal(self):
        """AR(1) returns with phi=0.4 make the next-candle direction ~63 % predictable."""
        f = ml_forecast(momentum(1000, 11), 5, 5)
        self.assertGreater(f["backtestHitRate"], 0.56)
        bt = f["backtest"]
        self.assertGreater(bt["hitRate"] - bt["margin"], 0.5)  # significant even with the error margin
        # high-confidence predictions should do at least as well
        top = [b for b in bt["byConfidence"] if b["hitRate"] is not None]
        self.assertTrue(top and top[-1]["hitRate"] >= bt["hitRate"] - 0.02)

    def test_response_shape(self):
        f = ml_forecast(random_walk(600, 5), 5, 30)
        last = random_walk(600, 5)[-1]
        self.assertEqual(len(f["points"]), 6)
        self.assertEqual(f["points"][0]["time"], int(last["time"]) + 300)
        for p in f["points"]:
            self.assertLess(p["low"], p["value"])
            self.assertLess(p["value"], p["high"])
        self.assertIn(f["direction"], ("up", "down", "flat"))
        self.assertTrue(0.5 <= f["confidence"] <= 1)
        self.assertEqual(len(f["backtest"]["byConfidence"]), 4)
        json.dumps(f, allow_nan=False)

    def test_daily_and_weekly_resolutions(self):
        day = ml_forecast(random_walk(1000, 8), 1440, 1440)
        week = ml_forecast(random_walk(1000, 9), 10080, 10080)
        self.assertEqual(len(day["points"]), 1)
        self.assertEqual(len(week["points"]), 1)

    def test_too_little_history(self):
        with self.assertRaises(InsufficientData):
            ml_forecast(random_walk(120, 1), 5, 30)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), api.handler)
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def post(self, body, token="s3cret", raw=None):
        data = raw if raw is not None else json.dumps(body).encode()
        req = urllib.request.Request(self.url, data=data, method="POST", headers={"Content-Type": "application/json"})
        if token is not None:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def payload(self, n=500):
        return {"epic": "GOLD", "resolution": "MINUTE_5", "resolutionMinutes": 5, "horizon": 30, "candles": random_walk(n, 4)}

    def setUp(self):
        os.environ["FORECAST_SERVICE_TOKEN"] = "s3cret"

    def test_auth(self):
        self.assertEqual(self.post(self.payload(), token=None)[0], 401)
        self.assertEqual(self.post(self.payload(), token="wrong")[0], 401)
        del os.environ["FORECAST_SERVICE_TOKEN"]
        self.assertEqual(self.post(self.payload())[0], 503)  # fails closed

    def test_ok_and_validation(self):
        status, body = self.post(self.payload())
        self.assertEqual(status, 200)
        self.assertEqual(len(body["points"]), 6)
        self.assertEqual(self.post(None, raw=b"not json")[0], 400)
        bad = self.payload()
        bad["candles"][10]["close"] = -1
        self.assertEqual(self.post(bad)[0], 400)
        bad = self.payload()
        bad["horizon"] = 0
        self.assertEqual(self.post(bad)[0], 400)
        self.assertEqual(self.post(self.payload(n=120))[0], 422)

    def test_health(self):
        with urllib.request.urlopen(self.url, timeout=10) as r:
            self.assertEqual(json.loads(r.read()), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
