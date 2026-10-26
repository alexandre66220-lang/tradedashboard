// Local mock of the few Capital.com endpoints used by the dashboard (tests only).
// Usage: node scripts/mock-capital.mjs [port]  then CAPITAL_BASE_URL=http://localhost:4010
import http from "node:http";

const port = Number(process.argv[2] || 4010);
const SESSION_TTL_MS = Number(process.env.MOCK_SESSION_TTL_MS || 600000);
const sessions = new Map();
const stats = { session: 0, prices: 0, markets: 0, other: 0 };

function series(stepMin, n) {
  const step = stepMin * 60;
  const end = Math.floor(Date.now() / 1000 / step) * step;
  let price = 2650, seed = 42 + stepMin;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = end - i * step;
    const open = price;
    const close = open + rnd() * 2 * Math.sqrt(stepMin) + 0.05 * Math.sin(i / 40);
    const high = Math.max(open, close) + Math.abs(rnd());
    const low = Math.min(open, close) - Math.abs(rnd());
    price = close;
    const iso = new Date(t * 1000).toISOString().slice(0, 19);
    const p = (v) => ({ bid: +(v - 0.15).toFixed(2), ask: +(v + 0.15).toFixed(2) });
    out.push({ snapshotTime: iso, snapshotTimeUTC: iso, openPrice: p(open), closePrice: p(close), highPrice: p(high), lowPrice: p(low), lastTradedVolume: 100 });
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
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/v1\/prices\/(.+)$/))) {
    stats.prices++;
    if (m[1] !== "GOLD") return send(res, 404, { errorCode: "error.not-found.epic" });
    const stepMin = { MINUTE: 1, MINUTE_5: 5, MINUTE_15: 15 }[url.searchParams.get("resolution")];
    if (!stepMin) return send(res, 400, { errorCode: "error.invalid.resolution" });
    return send(res, 200, { prices: series(stepMin, Math.min(Number(url.searchParams.get("max") || 10), 1000)), instrumentType: "COMMODITIES" });
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/v1\/markets\/(.+)$/))) {
    stats.markets++;
    return send(res, 200, { instrument: { epic: m[1], name: "Gold" }, snapshot: { marketStatus: process.env.MOCK_STATUS || "TRADEABLE", bid: 2650, offer: 2650.3 } });
  }
  stats.other++;
  send(res, 404, { errorCode: "error.not-found" });
}).listen(port, () => console.log(`mock capital on :${port}`));
