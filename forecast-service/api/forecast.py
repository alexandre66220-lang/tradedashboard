"""Vercel Python function: POST /api/forecast (same JSON contract as the dashboard's /api/forecast)."""
import hmac
import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from forecast_core import InsufficientData, ml_forecast  # noqa: E402

MAX_BODY = 4 * 1024 * 1024
MIN_CANDLES, MAX_CANDLES = 100, 5000


def parse_request(raw: bytes) -> tuple[list[dict], int, int]:
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
        by_time[row["time"]] = row
    candles = [by_time[k] for k in sorted(by_time)]
    if len(candles) < MIN_CANDLES:
        raise ValueError("not enough distinct candles")
    return candles, res, horizon


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
            candles, res, horizon = parse_request(self.rfile.read(length))
            result = ml_forecast(candles, res, horizon)
        except InsufficientData as e:
            return self._send(422, {"error": str(e)})
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        except Exception:  # never echo internals or data
            return self._send(500, {"error": "forecast failed"})
        self._send(200, result)

    def log_message(self, *args):  # no request logging: payloads are market data, keep logs quiet
        pass
