import "server-only";
import type { Candle, MarketStatus } from "./types";

/**
 * Minimal, READ-ONLY Capital.com client.
 * Only four calls are allowed: session creation, market details, price history and client sentiment.
 * No trading endpoint (positions, workingorders, confirms...) is implemented or reachable.
 */

const BASE_URLS = {
  demo: "https://demo-api-capital.backend-capital.com",
  live: "https://api-capital.backend-capital.com",
} as const;

const ALLOWED = [
  { method: "POST", path: /^\/api\/v1\/session$/ },
  { method: "GET", path: /^\/api\/v1\/prices\/[A-Za-z0-9._-]+$/ },
  { method: "GET", path: /^\/api\/v1\/markets\/[A-Za-z0-9._-]+$/ },
  // Share of Capital.com clients long / short: public market data, not an account or trading endpoint
  { method: "GET", path: /^\/api\/v1\/clientsentiment$/ },
];

// Sessions expire after 10 min of inactivity: renew proactively a bit before.
const SESSION_IDLE_MS = 9 * 60 * 1000;
const PRICES_TTL_MS = 4_000;
const STATUS_TTL_MS = 30_000;
const TIMEOUT_MS = 8_000;

export type CapitalErrorCode =
  | "CONFIG_MISSING"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "UPSTREAM_UNREACHABLE"
  | "UNKNOWN_EPIC"
  | "NO_DATA"
  | "UPSTREAM_ERROR";

export class CapitalError extends Error {
  constructor(
    public code: CapitalErrorCode,
    message: string,
    public httpStatus = 502,
  ) {
    super(message);
  }
}

export function capitalEnv(): "demo" | "live" {
  return process.env.CAPITAL_ENV === "live" ? "live" : "demo";
}

function config() {
  const apiKey = process.env.CAPITAL_API_KEY;
  const identifier = process.env.CAPITAL_IDENTIFIER;
  const password = process.env.CAPITAL_API_PASSWORD;
  const missing = [
    !apiKey && "CAPITAL_API_KEY",
    !identifier && "CAPITAL_IDENTIFIER",
    !password && "CAPITAL_API_PASSWORD",
  ].filter(Boolean);
  if (missing.length) {
    throw new CapitalError(
      "CONFIG_MISSING",
      `Identifiants Capital.com absents : ${missing.join(", ")} non défini(s) côté serveur.`,
      503,
    );
  }
  // CAPITAL_BASE_URL is only meant for local tests against a mock server.
  const baseUrl = process.env.CAPITAL_BASE_URL || BASE_URLS[capitalEnv()];
  return { apiKey: apiKey!, identifier: identifier!, password: password!, baseUrl };
}

interface Session {
  cst: string;
  securityToken: string;
  lastUsed: number;
}

let session: Session | null = null;
let loginInFlight: Promise<Session> | null = null;

async function rawFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new CapitalError("UPSTREAM_UNREACHABLE", "Capital.com est injoignable (réseau ou délai dépassé).", 504);
  }
}

async function readErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { errorCode?: string };
    return typeof body.errorCode === "string" ? body.errorCode : `http.${res.status}`;
  } catch {
    return `http.${res.status}`;
  }
}

function assertAllowed(method: string, path: string) {
  if (!ALLOWED.some((a) => a.method === method && a.path.test(path))) {
    throw new Error(`Blocked non read-only Capital.com call: ${method} ${path.split("?")[0]}`);
  }
}

async function login(): Promise<Session> {
  const cfg = config();
  const path = "/api/v1/session";
  assertAllowed("POST", path);
  const res = await rawFetch(cfg.baseUrl + path, {
    method: "POST",
    headers: { "X-CAP-API-KEY": cfg.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: cfg.identifier, password: cfg.password, encryptedPassword: false }),
  });
  if (!res.ok) {
    const code = await readErrorCode(res);
    console.warn(`[capital] session creation failed: status=${res.status} code=${code}`);
    if (res.status === 429) {
      throw new CapitalError("RATE_LIMITED", "Trop de connexions à Capital.com, réessai dans quelques secondes.", 429);
    }
    if (res.status >= 500) {
      throw new CapitalError("UPSTREAM_UNREACHABLE", `Capital.com indisponible (${res.status}).`, 502);
    }
    throw new CapitalError(
      "AUTH_FAILED",
      `Identifiants Capital.com refusés (${code}). Vérifiez la clé API, l'identifiant, le mot de passe API et CAPITAL_ENV (${capitalEnv()}).`,
      502,
    );
  }
  const cst = res.headers.get("CST");
  const securityToken = res.headers.get("X-SECURITY-TOKEN");
  if (!cst || !securityToken) {
    throw new CapitalError("UPSTREAM_ERROR", "Réponse de session Capital.com inattendue (jetons absents).");
  }
  return { cst, securityToken, lastUsed: Date.now() };
}

async function getSession(forceNew = false): Promise<Session> {
  if (!forceNew && session && Date.now() - session.lastUsed < SESSION_IDLE_MS) return session;
  if (!loginInFlight) {
    session = null;
    loginInFlight = login()
      .then((s) => (session = s))
      .finally(() => (loginInFlight = null));
  }
  return loginInFlight;
}

async function apiGet<T>(path: string): Promise<T> {
  assertAllowed("GET", path.split("?")[0]);
  const { apiKey, baseUrl } = config();
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    const res = await rawFetch(baseUrl + path, {
      method: "GET",
      headers: { "X-CAP-API-KEY": apiKey, CST: s.cst, "X-SECURITY-TOKEN": s.securityToken },
    });
    if (res.status === 401 && attempt === 0) {
      // Session expired: log in again once.
      session = null;
      continue;
    }
    if (res.ok) {
      s.lastUsed = Date.now();
      return (await res.json()) as T;
    }
    const code = await readErrorCode(res);
    console.warn(`[capital] GET ${path.split("?")[0]} failed: status=${res.status} code=${code}`);
    if (res.status === 429) throw new CapitalError("RATE_LIMITED", "Limite de requêtes Capital.com atteinte.", 429);
    if (code.includes("not-found.epic") || code.includes("invalid.epic")) {
      throw new CapitalError("UNKNOWN_EPIC", `Instrument inconnu chez Capital.com (${code}).`, 404);
    }
    if (code.includes("prices.not-found") || code.includes("not-found")) {
      throw new CapitalError("NO_DATA", "Aucun prix disponible pour cette période (marché fermé ?).", 404);
    }
    if (res.status >= 500) throw new CapitalError("UPSTREAM_UNREACHABLE", `Capital.com indisponible (${res.status}).`, 502);
    if (res.status === 401) throw new CapitalError("AUTH_FAILED", `Session Capital.com refusée (${code}).`, 502);
    throw new CapitalError("UPSTREAM_ERROR", `Erreur Capital.com (${code}).`);
  }
  throw new CapitalError("AUTH_FAILED", "Session Capital.com refusée après reconnexion.", 502);
}

// ---------------------------------------------------------------------------
// Short server-side caches so that many browser refreshes do not multiply calls.

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}
const cache = new Map<string, CacheEntry<unknown>>();

function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = fn();
  cache.set(key, { at: Date.now(), value });
  // Do not keep failures cached.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

interface RawPrice {
  snapshotTime?: string;
  snapshotTimeUTC?: string;
  openPrice: { bid: number; ask?: number };
  closePrice: { bid: number; ask?: number };
  highPrice: { bid: number; ask?: number };
  lowPrice: { bid: number; ask?: number };
}

function mid(p: { bid: number; ask?: number }): number {
  const v = typeof p.ask === "number" ? (p.bid + p.ask) / 2 : p.bid;
  return Math.round(v * 1e6) / 1e6;
}

function parseUtc(s: string): number {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`;
  return Math.floor(Date.parse(iso) / 1000);
}

export function toCandles(prices: RawPrice[]): Candle[] {
  const out: Candle[] = [];
  for (const p of prices) {
    const ts = p.snapshotTimeUTC ?? p.snapshotTime;
    if (!ts || !p.openPrice || !p.closePrice || !p.highPrice || !p.lowPrice) continue;
    const time = parseUtc(ts);
    if (!Number.isFinite(time)) continue;
    out.push({ time, open: mid(p.openPrice), high: mid(p.highPrice), low: mid(p.lowPrice), close: mid(p.closePrice) });
  }
  out.sort((a, b) => a.time - b.time);
  // Drop duplicate timestamps (keeps the latest)
  return out.filter((c, i) => i === out.length - 1 || out[i + 1].time !== c.time);
}

export function getCandles(epic: string, resolution: string, max = 1000, ttlMs = PRICES_TTL_MS): Promise<Candle[]> {
  return cached(`prices|${epic}|${resolution}|${max}`, ttlMs, async () => {
    const q = new URLSearchParams({ resolution, max: String(max) });
    const data = await apiGet<{ prices?: RawPrice[] }>(`/api/v1/prices/${encodeURIComponent(epic)}?${q}`);
    return toCandles(data.prices ?? []);
  });
}

export interface MarketQuote {
  status: MarketStatus;
  bid: number | null;
  offer: number | null;
}

export function getMarketQuote(epic: string): Promise<MarketQuote> {
  return cached(`quote|${epic}`, STATUS_TTL_MS, async () => {
    const data = await apiGet<{ snapshot?: { marketStatus?: string; bid?: number; offer?: number } }>(`/api/v1/markets/${encodeURIComponent(epic)}`);
    const snap = data.snapshot;
    const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
    return { status: snap?.marketStatus ?? "UNKNOWN", bid: ok(snap?.bid) ? snap.bid : null, offer: ok(snap?.offer) ? snap.offer : null };
  });
}

export async function getMarketStatus(epic: string): Promise<MarketStatus> {
  return (await getMarketQuote(epic)).status;
}

export interface Sentiment {
  /** % of clients holding long positions (0..100) */
  long: number;
  short: number;
}

/** Reads { clientSentiments: [{ marketId, longPositionPercentage, shortPositionPercentage }] }; skips anything else. */
export function parseSentiment(data: unknown): Record<string, Sentiment> {
  const list = (data as { clientSentiments?: unknown } | null)?.clientSentiments;
  const out: Record<string, Sentiment> = {};
  if (!Array.isArray(list)) return out;
  for (const r of list as Array<Record<string, unknown>>) {
    const long = Number(r?.longPositionPercentage), short = Number(r?.shortPositionPercentage);
    if (typeof r?.marketId !== "string" || !Number.isFinite(long) || !Number.isFinite(short) || long < 0 || short < 0) continue;
    const total = long + short;
    if (total < 98 || total > 102) continue; // not percentages of one whole: do not guess
    out[r.marketId.toUpperCase()] = { long: Math.round((long / total) * 1e4) / 100, short: Math.round((short / total) * 1e4) / 100 };
  }
  return out;
}

const SENTIMENT_TTL_MS = 60_000;
const SENTIMENT_FAILURE_TTL_MS = 5 * 60_000;
let sentimentFailedAt = 0;

/** Client sentiment for the given epics; never throws (an unsupported market or endpoint just has no entry). */
export async function getSentiment(epics: string[]): Promise<Record<string, Sentiment>> {
  if (sentimentFailedAt && Date.now() - sentimentFailedAt < SENTIMENT_FAILURE_TTL_MS) return {};
  const ids = [...epics].sort().join(",");
  try {
    return await cached(`sentiment|${ids}`, SENTIMENT_TTL_MS, async () => {
      const q = new URLSearchParams({ marketIds: ids });
      return parseSentiment(await apiGet<unknown>(`/api/v1/clientsentiment?${q}`));
    });
  } catch (err) {
    sentimentFailedAt = Date.now();
    console.warn("[capital] client sentiment unavailable:", err instanceof CapitalError ? err.code : "unknown");
    return {};
  }
}

export async function getSentimentFor(epic: string, all: string[]): Promise<Sentiment | null> {
  return (await getSentiment(all))[epic.toUpperCase()] ?? null;
}

/** Test helper */
export function __resetCapitalState() {
  sentimentFailedAt = 0;
  session = null;
  loginInFlight = null;
  cache.clear();
}
