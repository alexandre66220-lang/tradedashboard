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

from forecast_core import Config, InsufficientData, compare_variants, ml_forecast  # noqa: E402
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


def with_volume(candles, volume):
    return [{**k, "volume": float(v)} for k, v in zip(candles, volume)]


def planted_volume(n, seed):
    """The direction of the next move is only visible in the volume: high volume = next candle up."""
    rng = np.random.default_rng(seed)
    z = rng.choice([-1.0, 1.0], n)
    r = np.zeros(n)
    r[1:] = 0.0012 * z[:-1] + rng.normal(0, 0.0006, n - 1)
    volume = np.where(z > 0, 300.0, 100.0) * rng.uniform(0.8, 1.2, n)
    return with_volume(make_candles(r), volume)


def planted_leader(n, seed):
    """The other instrument leads: this one repeats what the other did one candle earlier."""
    rng = np.random.default_rng(seed)
    r2 = rng.normal(0, 0.001, n)
    r = np.zeros(n)
    r[1:] = 0.8 * r2[:-1] + rng.normal(0, 0.0005, n - 1)
    own = make_candles(r)
    other = make_candles(r2, price=70.0)
    ctx = [{"epic": "OTHER", "time": [k["time"] for k in other], "close": [k["close"] for k in other]}]
    return own, ctx


def regimes(n, seed):
    """Quiet and wild stretches. In quiet ones moves are far smaller than the spread; direction is AR(1)-predictable."""
    rng = np.random.default_rng(seed)
    r = np.zeros(n)
    sigma = 0.0001
    for i in range(1, n):
        if i % 60 == 0:
            sigma = rng.choice([0.0001, 0.0015])
        r[i] = 0.4 * r[i - 1] + rng.normal(0, sigma)
    return make_candles(r)


class ExtraInformationTests(unittest.TestCase):
    def test_volume_features_find_a_volume_only_signal(self):
        candles = planted_volume(1200, 1)
        with_vol = ml_forecast(candles, 5, 5, cfg=Config(cross=False, cost=False))
        without = ml_forecast([{k: v for k, v in c.items() if k != "volume"} for c in candles], 5, 5, cfg=Config(cross=False, cost=False))
        self.assertIn("volume", with_vol["features"])
        self.assertNotIn("volume", without["features"])
        self.assertGreater(with_vol["backtestHitRate"], 0.75)
        self.assertLess(without["backtestHitRate"], 0.6)

    def test_missing_volume_is_ignored(self):
        candles = planted_volume(400, 2)
        for c in candles[::2]:
            c["volume"] = 0.0  # half the candles without a volume: not trustworthy
        self.assertNotIn("volume", ml_forecast(candles, 5, 5)["features"])

    def test_other_instrument_leading_is_used(self):
        own, ctx = planted_leader(1200, 3)
        alone = ml_forecast(own, 5, 5, cfg=Config(volume=False, cost=False))
        with_ctx = ml_forecast(own, 5, 5, ctx, cfg=Config(volume=False, cost=False))
        self.assertIn("autres instruments", with_ctx["features"])
        self.assertGreater(with_ctx["backtestHitRate"], 0.8)
        self.assertLess(alone["backtestHitRate"], 0.6)

    def test_context_never_uses_the_future(self):
        """Shifting the other instrument one candle into the past (the future for us) must not matter more than the real alignment."""
        own, ctx = planted_leader(900, 4)
        # a context that only becomes known after our candle (shifted one step late) carries no information
        late = [{**ctx[0], "time": [t + 300 for t in ctx[0]["time"]]}]
        real = ml_forecast(own, 5, 5, ctx, cfg=Config(volume=False, cost=False))["backtestHitRate"]
        shifted = ml_forecast(own, 5, 5, late, cfg=Config(volume=False, cost=False))["backtestHitRate"]
        self.assertGreater(real, 0.8)
        self.assertLess(shifted, 0.65)

    def test_cost_aware_target_abstains_when_moves_cannot_beat_the_spread(self):
        candles = regimes(1500, 5)
        spread = 8.0  # 0.08 %: bigger than any move of a quiet stretch
        plain = ml_forecast(candles, 5, 5, spread_bps=spread, cfg=Config(volume=False, cross=False, cost=False))["backtest"]
        aware = ml_forecast(candles, 5, 5, spread_bps=spread, cfg=Config(volume=False, cross=False, cost=True))["backtest"]
        self.assertGreater(plain["coverage"], 0.7)  # without the cost target it trades through the quiet stretches too
        self.assertLess(aware["coverage"], plain["coverage"] - 0.2)
        self.assertGreater(aware["avgNetBps"], plain["avgNetBps"])

    def test_compare_lists_variants_that_have_their_data(self):
        own, ctx = planted_leader(900, 6)
        rows = compare_variants(own, 5, 5, ctx, spread_bps=1.0)
        names = [r["name"] for r in rows]
        self.assertEqual(names[0], "Prix seul (version 1)")
        self.assertNotIn("+ volume", names)  # no volume given: this variant would equal the first one
        self.assertEqual(sum(r["live"] for r in rows), 1)
        self.assertEqual([r for r in rows if r["name"].startswith("Version 2, plus prudente")][0]["live"], False)
        price_only = rows[0]["hitRate"]
        best_cross = max(r["hitRate"] for r in rows if "autres instruments" in r["features"])
        self.assertGreater(best_cross, price_only + 0.1)
        json.dumps(rows, allow_nan=False)


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

    def test_context_spread_volume_and_compare(self):
        own, ctx = planted_leader(500, 7)
        body = {"epic": "GOLD", "resolution": "MINUTE_5", "resolutionMinutes": 5, "horizon": 30, "candles": with_volume(own, [100] * 500),
                "context": ctx, "spreadBps": 2.0}
        status, out = self.post(body)
        self.assertEqual(status, 200)
        self.assertEqual(out["features"], ["prix", "volume", "autres instruments", "coût du spread"])
        self.assertTrue(out["source"].startswith("ML v2"))
        status, out = self.post({**body, "mode": "compare"})
        self.assertEqual(status, 200)
        self.assertTrue(out["variants"])
        for bad in (
            {"spreadBps": -1},
            {"spreadBps": "x"},
            {"mode": "train"},
            {"context": "nope"},
            {"context": [{"time": [1, 2], "close": [1]}]},
            {"context": [{"time": [1], "close": [-1]}]},
            {"context": [{"time": [1]}] * 5},
        ):
            self.assertEqual(self.post({**body, **bad})[0], 400, bad)

    def test_health(self):
        with urllib.request.urlopen(self.url, timeout=10) as r:
            self.assertEqual(json.loads(r.read()), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
