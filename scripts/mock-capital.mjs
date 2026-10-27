// Local mock of the few Capital.com endpoints used by the dashboard (tests only).
// Usage: node scripts/mock-capital.mjs [port]  then CAPITAL_BASE_URL=http://localhost:4010
import http from "node:http";

const port = Number(process.argv[2] || 4010);
const SESSION_TTL_MS = Number(process.env.MOCK_SESSION_TTL_MS || 600000);
const sessions = new Map();
const stats = { session: 0, prices: 0, markets: 0, other: 0 };

const BASE = { GOLD: 2650, OIL_CRUDE: 72, BTCUSD: 68000 };

// The price path is a pure function of (epic, step, candle index), so that pages requested with from / to line up.
const paths = new Map();
function pathFor(epic, stepMin) {
  const key = `${epic}|${stepMin}`;
  const end = Math.floor(Date.now() / 1000 / (stepMin * 60));
  let p = paths.get(key);
  if (p && p.end >= end) return p;
  const base = BASE[epic];
  const vol = (base / 2650) * 2 * Math.sqrt(stepMin);
  if (!p) {
    p = { start: end - 60000, end: end - 60001, rows: [] };
    p.seed = 42 + stepMin + epic.length;
    p.price = base;
    paths.set(key, p);
  }
  const rnd = () => ((p.seed = (p.seed * 16807) % 2147483647) / 2147483647) - 0.5;
  while (p.end < end) {
    p.end++;
    const i = p.end - p.start;
    const open = p.price;
    // Multiplicative steps keep prices positive over long histories
    const close = open * (1 + (rnd() * vol + 0.025 * vol * Math.sin(i / 40)) / base);
    const high = Math.max(open, close) + Math.abs(rnd()) * vol * 0.5;
    const low = Math.min(open, close) - Math.abs(rnd()) * vol * 0.5;
    p.price = close;
    p.rows.push({ open, close, high, low, volume: Math.round(100 + Math.abs(close - open) / vol * 40) });
  }
  return p;
}

const parseApiDate = (s) => Date.parse(`${s}Z`) / 1000;

function series(epic, stepMin, n, fromSec, toSec) {
  const step = stepMin * 60;
  const p = pathFor(epic, stepMin);
  const base = BASE[epic];
  // Candles starting at or before `toSec` (default: now), at or after `fromSec`, the latest `n` of them
  let last = toSec === undefined ? p.end : Math.min(p.end, Math.floor(toSec / step));
  let first = Math.max(p.start, last - n + 1);
  if (fromSec !== undefined) first = Math.max(first, Math.ceil(fromSec / step));
  const out = [];
  for (let k = first; k <= last; k++) {
    const r = p.rows[k - p.start];
    if (!r) continue;
    const iso = new Date(k * step * 1000).toISOString().slice(0, 19);
    const spread = base * 0.00006;
    const q = (v) => ({ bid: +(v - spread).toFixed(3), ask: +(v + spread).toFixed(3) });
    out.push({ snapshotTime: iso, snapshotTimeUTC: iso, openPrice: q(r.open), closePrice: q(r.close), highPrice: q(r.high), lowPrice: q(r.low), lastTradedVolume: r.volume });
  }
  return out;
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__stats") return send(res, 200, stats);
  if (url.pathname === "/ff_calendar_thisweek.json") {
    // events relative to now, with explicit UTC offsets like the real feed
    const at = (min) => new Date(Date.now() + min * 60000).toISOString().replace(/\.\d+Z$/, "+00:00");
    const ev = (title, country, min, impact, forecast = "", previous = "") => ({ title, country, date: at(min), impact, forecast, previous });
    const list = [
      ev("Non-Farm Employment Change", "USD", Number(process.env.MOCK_NEWS_MIN || 20), "High", "180K", "227K"),
      ev("ISM Services PMI", "USD", 190, "Medium", "52.1", "51.6"),
      ev("German Ifo Business Climate", "EUR", 60, "High", "86.0", "85.7"),
      ev("Crude Oil Inventories", "USD", 1560, "Medium", "-1.2M", "0.5M"),
      ev("Core CPI m/m", "USD", 2900, "High", "0.3%", "0.3%"),
      ev("Unemployment Claims", "USD", 400, "Low"),
      ev("Bank Holiday", "USD", 500, "Holiday"),
    ];
    return send(res, 200, process.env.MOCK_CAL_BAD ? { not: "a list" } : list);
  }
  if (url.pathname === "/ff_calendar_nextweek.json") return send(res, 404, {});
  if (req.headers["x-cap-api-key"] !== "test-key") return send(res, 401, { errorCode: "error.invalid.api.key" });
  if (req.method === "POST" && url.pathname === "/api/v1/session") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      stats.session++;
      const b = JSON.parse(body || "{}");
      if (b.identifier !== "me@test" || b.password !== "pw") return send(res, 401, { errorCode: "error.invalid.details" });
      const cst = "cst-" + Math.random().toString(36).slice(2);
      sessions.set(cst, Date.now());
      send(res, 200, { accountType: "CFD" }, { CST: cst, "X-SECURITY-TOKEN": "xst" });
    });
    return;
  }
  const cst = req.headers["cst"];
  const last = sessions.get(cst);
  if (!last || Date.now() - last > SESSION_TTL_MS) return send(res, 401, { errorCode: "error.invalid.session.token" });
  sessions.set(cst, Date.now());
  let m;
  if (req.method === "GET" && url.pathname === "/api/v1/clientsentiment") {
    if (process.env.MOCK_SENT_BAD) return send(res, 404, { errorCode: "error.not-found" });
    const known = { GOLD: 72, OIL_CRUDE: 41, BTCUSD: 55 };
    const ids = (url.searchParams.get("marketIds") || "").split(",").filter((i) => known[i]);
    return send(res, 200, { clientSentiments: ids.map((id) => ({ marketId: id, longPositionPercentage: known[id], shortPositionPercentage: 100 - known[id] })) });
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/v1\/prices\/(.+)$/))) {
    stats.prices++;
    if (!BASE[m[1]] || process.env.MOCK_MISSING === m[1]) return send(res, 404, { errorCode: "error.not-found.epic" });
    const stepMin = { MINUTE: 1, MINUTE_5: 5, MINUTE_15: 15, DAY: 1440, WEEK: 10080 }[url.searchParams.get("resolution")];
    if (!stepMin) return send(res, 400, { errorCode: "error.invalid.resolution" });
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if ((from && !Number.isFinite(parseApiDate(from))) || (to && !Number.isFinite(parseApiDate(to)))) return send(res, 400, { errorCode: "error.invalid.date" });
    const max = Math.min(Number(url.searchParams.get("max") || 10), 1000);
    return send(res, 200, { prices: series(m[1], stepMin, max, from ? parseApiDate(from) : undefined, to ? parseApiDate(to) : undefined), instrumentType: "COMMODITIES" });
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/v1\/markets\/(.+)$/))) {
    stats.markets++;
    return send(res, 200, { instrument: { epic: m[1], name: "Gold" }, snapshot: { marketStatus: process.env.MOCK_STATUS || "TRADEABLE", bid: 2650, offer: 2650 + Number(process.env.MOCK_SPREAD || 0.3) } });
  }
  stats.other++;
  send(res, 404, { errorCode: "error.not-found" });
}).listen(port, () => console.log(`mock capital on :${port}`));
