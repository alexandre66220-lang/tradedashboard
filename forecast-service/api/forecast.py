"""Vercel Python function: POST /api/forecast (same JSON contract as the dashboard's /api/forecast)."""
import hmac
import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from forecast_core import InsufficientData, compare_variants, ml_forecast  # noqa: E402

MAX_BODY = 4 * 1024 * 1024
MIN_CANDLES, MAX_CANDLES = 100, 5000
MAX_CONTEXT = 4
MAX_SPREAD_BPS = 1000


def _number(v) -> float:
    if isinstance(v, bool):
        raise ValueError("not a number")
    x = float(v)
    if not math.isfinite(x):
        raise ValueError("not finite")
    return x


def parse_context(raw) -> list[dict]:
    """Optional price history of the other instruments: [{epic, time: [...], close: [...]}], oldest first."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_CONTEXT:
        raise ValueError(f"context must be a list of at most {MAX_CONTEXT} series")
    out = []
    for item in raw:
        try:
            times = [_number(v) for v in item["time"]]
            closes = [_number(v) for v in item["close"]]
        except (TypeError, KeyError, ValueError):
            raise ValueError("each context series needs numeric time and close lists")
        if len(times) != len(closes) or len(times) > MAX_CANDLES:
            raise ValueError("context series must have equal lengths of at most 5000 items")
        if closes and min(closes) <= 0:
            raise ValueError("context prices must be positive")
        pairs = sorted(dict(zip(times, closes)).items())
        out.append({"time": [p[0] for p in pairs], "close": [p[1] for p in pairs]})
    return out


def parse_request(raw: bytes) -> dict:
    """Validates the payload; raises ValueError with a message safe to return to the caller."""
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise ValueError("invalid JSON")
    if not isinstance(body, dict):
        raise ValueError("body must be an object")
    res = body.get("resolutionMinutes")
    horizon = body.get("horizon")
    if not isinstance(res, int) or isinstance(res, bool) or not 1 <= res <= 10080:
        raise ValueError("resolutionMinutes must be an integer between 1 and 10080")
    if not isinstance(horizon, int) or isinstance(horizon, bool) or not 1 <= horizon <= 14400:
        raise ValueError("horizon must be an integer between 1 and 14400")
    raw_candles = body.get("candles")
    if not isinstance(raw_candles, list) or not MIN_CANDLES <= len(raw_candles) <= MAX_CANDLES:
        raise ValueError(f"candles must be a list of {MIN_CANDLES} to {MAX_CANDLES} items")
    by_time: dict[float, dict] = {}
    for k in raw_candles:
        try:
            row = {f: float(k[f]) for f in ("time", "open", "high", "low", "close")}
        except (TypeError, KeyError, ValueError):
            raise ValueError("each candle needs numeric time/open/high/low/close")
        if not all(math.isfinite(v) for v in row.values()) or min(row["open"], row["high"], row["low"], row["close"]) <= 0:
            raise ValueError("candle values must be finite and positive")
        vol = k.get("volume")  # optional: the model only uses it when most candles have one
        if isinstance(vol, (int, float)) and not isinstance(vol, bool) and math.isfinite(vol) and vol >= 0:
            row["volume"] = float(vol)
        by_time[row["time"]] = row
    candles = [by_time[k] for k in sorted(by_time)]
    if len(candles) < MIN_CANDLES:
        raise ValueError("not enough distinct candles")
    spread = body.get("spreadBps")
    if spread is not None:
        try:
            spread = _number(spread)
        except (TypeError, ValueError):
            raise ValueError("spreadBps must be a number")
        if not 0 <= spread <= MAX_SPREAD_BPS:
            raise ValueError(f"spreadBps must be between 0 and {MAX_SPREAD_BPS}")
    mode = body.get("mode", "forecast")
    if mode not in ("forecast", "compare"):
        raise ValueError("mode must be 'forecast' or 'compare'")
    return {
        "candles": candles,
        "resolutionMinutes": res,
        "horizon": horizon,
        "context": parse_context(body.get("context")),
        "spreadBps": spread,
        "mode": mode,
    }


def authorized(header: str | None, token: str) -> bool:
    return hmac.compare_digest((header or "").encode(), f"Bearer {token}".encode())


class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # health check, no data
        self._send(200, {"status": "ok"})

    def do_POST(self):
        token = os.environ.get("FORECAST_SERVICE_TOKEN")
        if not token:  # fail closed
            return self._send(503, {"error": "FORECAST_SERVICE_TOKEN is not configured"})
        if not authorized(self.headers.get("Authorization"), token):
            return self._send(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._send(400, {"error": "invalid Content-Length"})
        if length <= 0 or length > MAX_BODY:
            return self._send(413 if length > MAX_BODY else 400, {"error": "invalid body size"})
        try:
            req = parse_request(self.rfile.read(length))
            args = (req["candles"], req["resolutionMinutes"], req["horizon"], req["context"], req["spreadBps"])
            result = {"variants": compare_variants(*args)} if req["mode"] == "compare" else ml_forecast(*args)
        except InsufficientData as e:
            return self._send(422, {"error": str(e)})
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        except Exception:  # never echo internals or data
            return self._send(500, {"error": "forecast failed"})
        self._send(200, result)

    def log_message(self, *args):  # no request logging: payloads are market data, keep logs quiet
        pass
