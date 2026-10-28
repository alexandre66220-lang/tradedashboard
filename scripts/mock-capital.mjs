// Local mock of the few Capital.com endpoints used by the dashboard (tests only).
// Usage: node scripts/mock-capital.mjs [port]  then CAPITAL_BASE_URL=http://localhost:4010
import http from "node:http";

const port = Number(process.argv[2] || 4010);
const SESSION_TTL_MS = Number(process.env.MOCK_SESSION_TTL_MS || 600000);
const sessions = new Map();
const stats = { session: 0, prices: 0, markets: 0, other: 0 };

const positions = new Map();
const deals = new Map();
const activities = [];

const BASE = { GOLD: 2650, OIL_CRUDE: 72, BTCUSD: 68000, US100: 21000, US500: 6000, EURUSD: 1.08 };

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
    const q = (v) => ({ bid: +(v - spread).toFixed(5), ask: +(v + spread).toFixed(5) });
    out.push({ snapshotTime: iso, snapshotTimeUTC: iso, openPrice: q(r.open), closePrice: q(r.close), highPrice: q(r.high), lowPrice: q(r.low), lastTradedVolume: r.volume });
  }
  return out;
}

// Current quote: follows the last 5-minute candle (the chart default) so that levels taken from the chart make sense
const quoteOf = (epic) => {
  const mid = BASE[epic] ? pathFor(epic, 5).price : 2650;
  const spread = Number(process.env.MOCK_SPREAD || (BASE[epic] || 2650) * 0.00011);
  return { bid: +(mid - spread / 2).toFixed(5), offer: +(mid + spread / 2).toFixed(5) };
};

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
  if (url.pathname === "/__close") {
    // Tests only: the broker closes a position by itself (stop or target hit) and logs it in the activity
    const id = url.searchParams.get("dealId");
    const level = Number(url.searchParams.get("level"));
    if (!positions.has(id)) return send(res, 404, {});
    positions.delete(id);
    activities.push({ dateUTC: new Date().toISOString().slice(0, 19), dealId: id, details: { level, actions: [{ actionType: "POSITION_CLOSED", affectedDealId: id }] } });
    return send(res, 200, { closed: id });
  }
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
    const known = { GOLD: 72, OIL_CRUDE: 41, BTCUSD: 55, US100: 63, US500: 58, EURUSD: 47 };
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
    return send(res, 200, { instrument: { epic: m[1], name: "Gold" }, snapshot: { marketStatus: process.env.MOCK_STATUS || "TRADEABLE", ...quoteOf(m[1]) } });
  }
  // Demo trading (tests only): positions are kept in memory
  if (url.pathname === "/api/v1/positions" && req.method === "GET") {
    return send(res, 200, {
      positions: [...positions.values()].map((p) => ({
        position: { dealId: p.dealId, dealReference: p.ref, size: p.size, direction: p.direction, level: p.level, stopLevel: p.stopLevel ?? null, profitLevel: p.profitLevel ?? null, createdDateUTC: p.created, upl: 0, currency: "USD" },
        market: { epic: p.epic, instrumentName: "Gold", ...quoteOf(p.epic) },
      })),
    });
  }
  if (url.pathname === "/api/v1/positions" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      stats.orders = (stats.orders || 0) + 1;
      const b = JSON.parse(body || "{}");
      const ref = "o_" + Math.random().toString(36).slice(2, 10);
      if (process.env.MOCK_REJECT) deals.set(ref, { dealStatus: "REJECTED", reason: "INSUFFICIENT_FUNDS" });
      else {
        const dealId = "d_" + Math.random().toString(36).slice(2, 10);
        const q = quoteOf(b.epic);
        const level = b.direction === "BUY" ? q.offer : q.bid;
        positions.set(dealId, { dealId, ref, epic: b.epic, size: b.size, direction: b.direction, level, stopLevel: b.stopLevel, profitLevel: b.profitLevel, created: new Date().toISOString().slice(0, 23) });
        deals.set(ref, { dealStatus: "ACCEPTED", dealId, level });
      }
      send(res, 200, { dealReference: ref });
    });
    return;
  }
  if (url.pathname === "/api/v1/history/activity" && req.method === "GET") {
    if (process.env.MOCK_NO_ACTIVITY) return send(res, 200, { activities: [] });
    return send(res, 200, { activities });
  }
  if ((m = url.pathname.match(/^\/api\/v1\/positions\/(.+)$/)) && req.method === "PUT") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = positions.get(m[1]);
      if (!p) return send(res, 404, { errorCode: "error.not-found.dealId" });
      const b = JSON.parse(body || "{}");
      if (typeof b.stopLevel === "number") p.stopLevel = b.stopLevel;
      if (typeof b.profitLevel === "number") p.profitLevel = b.profitLevel;
      const ref = "u_" + Math.random().toString(36).slice(2, 10);
      deals.set(ref, { dealStatus: "ACCEPTED", dealId: m[1], level: p.level });
      send(res, 200, { dealReference: ref });
    });
    return;
  }
  if ((m = url.pathname.match(/^\/api\/v1\/positions\/(.+)$/)) && req.method === "DELETE") {
    if (!positions.has(m[1])) return send(res, 404, { errorCode: "error.not-found.dealId" });
    positions.delete(m[1]);
    const ref = "c_" + Math.random().toString(36).slice(2, 10);
    deals.set(ref, { dealStatus: "ACCEPTED", dealId: m[1], level: 2650 });
    return send(res, 200, { dealReference: ref });
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/v1\/confirms\/(.+)$/))) {
    const d = deals.get(m[1]);
    return d ? send(res, 200, { dealReference: m[1], ...d }) : send(res, 404, { errorCode: "error.not-found" });
  }
  stats.other++;
  send(res, 404, { errorCode: "error.not-found" });
}).listen(port, () => console.log(`mock capital on :${port}`));
