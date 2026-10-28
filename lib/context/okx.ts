import "server-only";
import type { BtcDerivs } from "./types";

// OKX public market data (no key): Bitcoin perpetual swap. Read-only, never required: every function fails soft.
// OKX_BASE_URL is only meant for local tests against a mock server.
const base = () => process.env.OKX_BASE_URL || "https://www.okx.com";
const INST = "BTC-USDT-SWAP";
const TIMEOUT_MS = 6_000;
const TTL_MS = 2 * 60_000;
const FAILURE_TTL_MS = 5 * 60_000;

const num = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** OKX answers { code: "0", data: [...] }; anything else gives null. */
function rows(json: unknown): unknown[] | null {
  const j = json as { code?: unknown; data?: unknown } | null;
  return j && j.code === "0" && Array.isArray(j.data) ? j.data : null;
}

/** { data: [{ fundingRate, fundingTime }] } */
export function parseFunding(json: unknown): number | null {
  const r = rows(json)?.[0] as { fundingRate?: unknown } | undefined;
  const f = num(r?.fundingRate);
  // a funding rate beyond a few % per 8 h is not a real reading
  return f !== null && Math.abs(f) < 0.05 ? f : null;
}

/** { data: [[ts, longShortRatio], ...] } newest first; ratio = long accounts / short accounts. Returns the % of accounts long. */
export function parseLongShort(json: unknown): number | null {
  const r = rows(json)?.[0];
  const ratio = Array.isArray(r) ? num(r[1]) : null;
  return ratio !== null && ratio > 0 && ratio < 1000 ? Math.round((ratio / (1 + ratio)) * 1000) / 10 : null;
}

/** { data: [[ts, oi, oiCcy, oiUsd], ...] } newest first, 5-minute points: change between the newest and the one an hour earlier. */
export function parseOiChange(json: unknown, back = 12): number | null {
  const r = rows(json);
  if (!r || r.length <= back) return null;
  const at = (row: unknown) => (Array.isArray(row) ? num(row[3] ?? row[2] ?? row[1]) : null);
  const now = at(r[0]);
  const before = at(r[back]);
  if (now === null || before === null || before <= 0 || now <= 0) return null;
  return Math.round(((now - before) / before) * 10_000) / 100;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(base() + path, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let cache: { at: number; failed: boolean; value: Promise<BtcDerivs | null> } | null = null;
export function __resetOkx() {
  cache = null;
}

async function load(): Promise<BtcDerivs | null> {
  const [fund, ls, oi] = await Promise.allSettled([
    getJson(`/api/v5/public/funding-rate?instId=${INST}`),
    getJson("/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=5m"),
    getJson(`/api/v5/rubik/stat/contracts/open-interest-history?instId=${INST}&period=5m&limit=13`),
  ]);
  const funding = fund.status === "fulfilled" ? parseFunding(fund.value) : null;
  // The funding rate is the one reading the rest hangs on
  if (funding === null) {
    console.warn("[context] OKX funding rate unavailable");
    return null;
  }
  return {
    funding,
    longPct: ls.status === "fulfilled" ? parseLongShort(ls.value) : null,
    oi1hPct: oi.status === "fulfilled" ? parseOiChange(oi.value) : null,
    at: Date.now(),
  };
}

/** Bitcoin perpetual positioning, cached for two minutes (five after a failure). Never throws. */
export function getBtcDerivs(): Promise<BtcDerivs | null> {
  if (cache && Date.now() - cache.at < (cache.failed ? FAILURE_TTL_MS : TTL_MS)) return cache.value;
  const entry = { at: Date.now(), failed: false, value: null as unknown as Promise<BtcDerivs | null> };
  entry.value = load().then(
    (v) => {
      entry.failed = v === null;
      return v;
    },
    () => {
      entry.failed = true;
      return null;
    },
  );
  cache = entry;
  return entry.value;
}
