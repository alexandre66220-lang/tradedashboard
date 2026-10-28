import "server-only";
import type { Candle, MarketStatus } from "./types";

/**
 * Minimal Capital.com client.
 * Reading: session creation, market details, price history and client sentiment.
 * Trading (DEMO ACCOUNT ONLY, see `assertDemoOnly`): open / list / close a position and read a deal confirmation.
 * Nothing else is reachable (no working orders, no account changes, no withdrawals).
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
  | "TRADING_REFUSED"
  | "UNKNOWN_EPIC"
  | "NO_DATA"
  | "UPSTREAM_ERROR";

export class CapitalError extends Error {
  constructor(
    public code: CapitalErrorCode,
    message: string,
    public httpStatus = 502,
    /** Error code given by Capital.com itself, e.g. "error.invalid.max.daterange" */
    public upstream?: string,
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Capital.com allows few calls per second (about 10, and session creation once per second). A page load makes several
// calls at once, and on Vercel each one may run in a separate instance: keep the bursts small and retry politely on 429.
const MAX_CONCURRENT = 4;
let rateLimitWaitMs = 1_100;
/** Tests only: do not wait seconds between retries. */
export function __setRateLimitWait(ms: number) {
  rateLimitWaitMs = ms;
}
const RATE_LIMIT_RETRIES = 2;
let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

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
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await rawFetch(cfg.baseUrl + path, {
      method: "POST",
      headers: { "X-CAP-API-KEY": cfg.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: cfg.identifier, password: cfg.password, encryptedPassword: false }),
    });
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break;
    await sleep(rateLimitWaitMs * (attempt + 1));
  }
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
  let throttled = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    const res = await withSlot(() =>
      rawFetch(baseUrl + path, {
        method: "GET",
        headers: { "X-CAP-API-KEY": apiKey, CST: s.cst, "X-SECURITY-TOKEN": s.securityToken },
      }),
    );
    if (res.status === 401 && attempt === 0) {
      // Session expired: log in again once.
      session = null;
      continue;
    }
    if (res.status === 429 && throttled < RATE_LIMIT_RETRIES) {
      throttled++;
      attempt--; // a throttled call does not use up the re-login attempt
      await sleep(rateLimitWaitMs * throttled);
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
    throw new CapitalError("UPSTREAM_ERROR", `Erreur Capital.com (${code}).`, 502, code);
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
  lastTradedVolume?: number;
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
    const volume = typeof p.lastTradedVolume === "number" && Number.isFinite(p.lastTradedVolume) && p.lastTradedVolume >= 0 ? p.lastTradedVolume : undefined;
    out.push({ time, open: mid(p.openPrice), high: mid(p.highPrice), low: mid(p.lowPrice), close: mid(p.closePrice), ...(volume === undefined ? {} : { volume }) });
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

// --------------------------------------------------------------------------- long history (for the ML model)

const HISTORY_PAGE = 1000; // the API returns at most 1000 candles per call
const HISTORY_WINDOW = 950; // steps per date range: both ends are inclusive and the range has to stay under `max`
const HISTORY_MAX_PAGES = 40;
const HISTORY_BUDGET_MS = 15_000; // paging stops after this long; what was read is kept for the next request
const HISTORY_MAX_EMPTY_SEC = 10 * 86_400; // this much empty time in a row (weekends, holidays are shorter) means the history starts later
const HISTORY_MIN_WINDOW = 60; // steps: below this a date range is not worth the calls
const HISTORY_SMALL_PAGE = 10; // a page this small for a wide window: the API is ignoring the range (it defaults to 10 candles)
const HISTORY_RETRY_MS = 10 * 60_000; // after a failure, do not hit the paging again for a while
const histories = new Map<string, { candles: Candle[]; complete: boolean }>();
let pagingFailedAt = 0;
/** Widest date range (in candles) the API accepted, per resolution; shrinks when it answers "invalid.max.daterange" */
const windowSteps = new Map<string, number>();

/** "2024-03-01T09:30:00": the date format of the prices endpoint (UTC). */
const apiDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 19);

/**
 * Candles from `endSec - windowSteps` to `endSec`. Both ends of the range are inclusive and `max` defaults to 10: the
 * range must hold fewer points than `max` (else "error.invalid.max.daterange"), so `max` is set to the limit and the
 * range kept a little under it.
 */
async function getPageBefore(epic: string, resolution: string, endSec: number, stepSec: number, windowSteps: number): Promise<Candle[]> {
  const q = new URLSearchParams({ resolution, max: String(HISTORY_PAGE), from: apiDate(endSec - windowSteps * stepSec), to: apiDate(endSec) });
  const data = await apiGet<{ prices?: RawPrice[] }>(`/api/v1/prices/${encodeURIComponent(epic)}?${q}`);
  return toCandles(data.prices ?? []);
}

const STEP_SEC: Record<string, number> = { MINUTE: 60, MINUTE_5: 300, MINUTE_15: 900 };

/**
 * Up to `target` of the latest candles, paging backwards past the 1000-candle limit. The older part is kept in
 * memory and only the recent candles are refreshed. If an older page fails, what is already there is returned:
 * a shorter history makes the model less sure, it must not break the forecast.
 */
export function getHistory(epic: string, resolution: string, target: number, ttlMs = 60_000): Promise<Candle[]> {
  const step = STEP_SEC[resolution];
  if (!step || target <= HISTORY_PAGE) return getCandles(epic, resolution, Math.min(target, HISTORY_PAGE), ttlMs);
  return cached(`history|${epic}|${resolution}|${target}`, ttlMs, async () => {
    const key = `${epic}|${resolution}`;
    const store = histories.get(key) ?? { candles: [], complete: false };
    histories.set(key, store);
    const recent = await getCandles(epic, resolution, HISTORY_PAGE, ttlMs);
    const merged = new Map(store.candles.map((c) => [c.time, c] as const));
    for (const c of recent) merged.set(c.time, c);
    store.candles = [...merged.values()].sort((a, b) => a.time - b.time);

    let emptySec = 0;
    const startedAt = Date.now();
    const paging = !pagingFailedAt || Date.now() - pagingFailedAt > HISTORY_RETRY_MS;
    let end = (store.candles[0]?.time ?? Math.floor(Date.now() / 1000)) - 1;
    try {
      for (let page = 0; paging && page < HISTORY_MAX_PAGES && Date.now() - startedAt < HISTORY_BUDGET_MS && !store.complete && store.candles.length < target; page++) {
        const width = windowSteps.get(resolution) ?? HISTORY_WINDOW;
        let raw: Candle[];
        try {
          raw = await getPageBefore(epic, resolution, end, step, width);
        } catch (err) {
          // Range too wide for this API: halve it and try again, down to a minimum
          if (err instanceof CapitalError && err.upstream?.includes("daterange") && width / 2 >= HISTORY_MIN_WINDOW) {
            console.warn(`[capital] date range of ${width} candles (${resolution}) refused: trying ${Math.floor(width / 2)}`);
            windowSteps.set(resolution, Math.floor(width / 2));
            page--;
            continue;
          }
          throw err;
        }
        if (raw.length > 0 && raw.length <= HISTORY_SMALL_PAGE && width > 10 * HISTORY_SMALL_PAGE) {
          pagingFailedAt = Date.now();
          console.warn(`[capital] date range of ${width} candles (${resolution}) returned only ${raw.length} candles: keeping the latest 1000`);
          break;
        }
        const older = raw.filter((c) => c.time <= end);
        if (older.length === 0) {
          emptySec += width * step;
          if (emptySec >= HISTORY_MAX_EMPTY_SEC) store.complete = true;
          end -= width * step;
          continue;
        }
        emptySec = 0;
        store.candles = [...older, ...store.candles];
        end = older[0].time - 1;
      }
    } catch (err) {
      pagingFailedAt = Date.now();
      console.warn("[capital] older history unavailable:", err instanceof CapitalError ? err.code : "unknown");
    }
    store.candles = store.candles.slice(-Math.max(target, HISTORY_PAGE * 2));
    return store.candles.slice(-target);
  });
}

export interface MarketQuote {
  status: MarketStatus;
  bid: number | null;
  offer: number | null;
}

async function fetchQuote(epic: string): Promise<MarketQuote> {
  const data = await apiGet<{ snapshot?: { marketStatus?: string; bid?: number; offer?: number } }>(`/api/v1/markets/${encodeURIComponent(epic)}`);
  const snap = data.snapshot;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  return { status: snap?.marketStatus ?? "UNKNOWN", bid: ok(snap?.bid) ? snap.bid : null, offer: ok(snap?.offer) ? snap.offer : null };
}

export function getMarketQuote(epic: string): Promise<MarketQuote> {
  return cached(`quote|${epic}`, STATUS_TTL_MS, () => fetchQuote(epic));
}

/** Never cached: the price an order is checked against must be the current one. */
export const getFreshQuote = fetchQuote;

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
  rateLimitWaitMs = 1_100;
  histories.clear();
  windowSteps.clear();
  pagingFailedAt = 0;
  active = 0;
  waiting.length = 0;
  sentimentFailedAt = 0;
  session = null;
  loginInFlight = null;
  cache.clear();
}

// ---------------------------------------------------------------------------
// Trading: DEMO ACCOUNT ONLY. Every function below refuses to run unless CAPITAL_ENV is "demo" (the default) and the
// target is not the live host; the server-side rules (switch, limits, confirmation) live in lib/orders.ts.

const TRADING_ALLOWED = [
  { method: "POST", path: /^\/api\/v1\/positions$/ },
  { method: "GET", path: /^\/api\/v1\/positions$/ },
  { method: "DELETE", path: /^\/api\/v1\/positions\/[A-Za-z0-9._-]+$/ },
  { method: "GET", path: /^\/api\/v1\/confirms\/[A-Za-z0-9._-]+$/ },
  // Moves the stop of an open position (never used to open or close one)
  { method: "PUT", path: /^\/api\/v1\/positions\/[A-Za-z0-9._-]+$/ },
  // Read-only history of what happened on the account: tells at what price a position was closed by its stop or target
  { method: "GET", path: /^\/api\/v1\/history\/activity$/ },
];

export function assertDemoOnly() {
  const refuse = () => {
    throw new CapitalError("TRADING_REFUSED", "Ordres refusés : seul le compte démo est autorisé (CAPITAL_ENV doit rester « demo »).", 403);
  };
  if (capitalEnv() !== "demo") refuse();
  const base = process.env.CAPITAL_BASE_URL || BASE_URLS.demo;
  try {
    if (new URL(base).host === new URL(BASE_URLS.live).host) refuse();
  } catch (err) {
    if (err instanceof CapitalError) throw err;
    refuse();
  }
}

async function apiTrade<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  assertDemoOnly();
  if (!TRADING_ALLOWED.some((a) => a.method === method && a.path.test(path.split("?")[0]))) {
    throw new Error(`Blocked Capital.com call: ${method} ${path.split("?")[0]}`);
  }
  const { apiKey, baseUrl } = config();
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    const res = await withSlot(() =>
      rawFetch(baseUrl + path, {
        method,
        headers: { "X-CAP-API-KEY": apiKey, CST: s.cst, "X-SECURITY-TOKEN": s.securityToken, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    // An expired session means the request was not processed: logging in again and sending it once more is safe
    if (res.status === 401 && attempt === 0) {
      session = null;
      continue;
    }
    if (res.ok) {
      s.lastUsed = Date.now();
      return (await res.json()) as T;
    }
    const code = await readErrorCode(res);
    console.warn(`[capital] ${method} ${path} failed: status=${res.status} code=${code}`);
    if (res.status === 429) throw new CapitalError("RATE_LIMITED", "Trop de requêtes vers Capital.com : réessayez dans quelques secondes.", 429);
    if (res.status === 401) throw new CapitalError("AUTH_FAILED", `Session Capital.com refusée (${code}).`, 502);
    if (res.status >= 500) throw new CapitalError("UPSTREAM_ERROR", `Capital.com a répondu une erreur (${res.status}) : vérifiez vos positions avant de réessayer.`, 502);
    throw new CapitalError("UPSTREAM_ERROR", `Refusé par Capital.com (${code}).`, 502, code);
  }
  throw new CapitalError("AUTH_FAILED", "Session Capital.com refusée après reconnexion.", 502);
}

export interface OpenPosition {
  dealId: string;
  epic: string;
  name: string;
  direction: "BUY" | "SELL";
  size: number;
  level: number;
  stopLevel: number | null;
  profitLevel: number | null;
  /** Unrealised profit / loss in the account currency */
  upl: number | null;
  currency: string | null;
  /** Opening time (ms) */
  createdAt: number | null;
  bid: number | null;
  offer: number | null;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Reads { positions: [{ position: {...}, market: {...} }] }; rows that do not look right are skipped, never guessed. */
export function parsePositions(data: unknown): OpenPosition[] {
  const list = (data as { positions?: unknown } | null)?.positions;
  if (!Array.isArray(list)) return [];
  const out: OpenPosition[] = [];
  for (const row of list as Array<{ position?: Record<string, unknown>; market?: Record<string, unknown> }>) {
    const p = row?.position;
    const m = row?.market;
    const size = finite(p?.size);
    const level = finite(p?.level);
    const direction = p?.direction === "BUY" || p?.direction === "SELL" ? p.direction : null;
    if (typeof p?.dealId !== "string" || typeof m?.epic !== "string" || size === null || level === null || !direction) continue;
    const created = typeof p.createdDateUTC === "string" ? parseUtc(p.createdDateUTC) * 1000 : NaN; // parseUtc gives seconds
    out.push({
      dealId: p.dealId,
      epic: m.epic,
      name: typeof m.instrumentName === "string" ? m.instrumentName : m.epic,
      direction,
      size,
      level,
      stopLevel: finite(p.stopLevel),
      profitLevel: finite(p.profitLevel),
      upl: finite(p.upl),
      currency: typeof p.currency === "string" ? p.currency : null,
      createdAt: Number.isFinite(created) ? created : null,
      bid: finite(m.bid),
      offer: finite(m.offer),
    });
  }
  return out;
}

export async function listPositions(): Promise<OpenPosition[]> {
  return parsePositions(await apiTrade<unknown>("GET", "/api/v1/positions"));
}

export interface PositionRequest {
  epic: string;
  direction: "BUY" | "SELL";
  size: number;
  stopLevel: number;
  profitLevel?: number;
}

export interface DealConfirmation {
  dealReference: string;
  accepted: boolean;
  /** Why Capital.com refused, when it did */
  reason: string | null;
  dealId: string | null;
  level: number | null;
}

/** An answer that never came may still have opened the position: the caller must say so rather than retry. */
const UNKNOWN_OUTCOME = "Pas de réponse de Capital.com : l'ordre a peut-être été envoyé. Vérifiez la liste des positions avant de réessayer.";

async function sendDeal(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<string> {
  try {
    const res = await apiTrade<{ dealReference?: unknown }>(method, path, body);
    if (typeof res?.dealReference !== "string" || !/^[A-Za-z0-9._-]+$/.test(res.dealReference)) {
      throw new CapitalError("UPSTREAM_ERROR", "Réponse de Capital.com inattendue : vérifiez la liste des positions.", 502);
    }
    return res.dealReference;
  } catch (err) {
    if (err instanceof CapitalError && err.code === "UPSTREAM_UNREACHABLE") throw new CapitalError("UPSTREAM_UNREACHABLE", UNKNOWN_OUTCOME, 504);
    throw err;
  }
}

export async function openPosition(req: PositionRequest): Promise<string> {
  return sendDeal("POST", "/api/v1/positions", {
    epic: req.epic,
    direction: req.direction,
    size: req.size,
    guaranteedStop: false,
    stopLevel: req.stopLevel,
    ...(req.profitLevel !== undefined ? { profitLevel: req.profitLevel } : {}),
  });
}

/**
 * Moves the stop of an open position. The current target is sent again with it: an amendment that left it out might
 * be read as "no target any more".
 */
export async function amendPositionStop(dealId: string, stopLevel: number, profitLevel: number | null): Promise<string> {
  return sendDeal("PUT", `/api/v1/positions/${encodeURIComponent(dealId)}`, {
    guaranteedStop: false,
    stopLevel,
    ...(profitLevel !== null ? { profitLevel } : {}),
  });
}

export async function closePositionDeal(dealId: string): Promise<string> {
  return sendDeal("DELETE", `/api/v1/positions/${encodeURIComponent(dealId)}`);
}

/** The broker's verdict on a deal reference (accepted or rejected, and at what level). */
export async function getConfirmation(dealReference: string): Promise<DealConfirmation> {
  const d = await apiTrade<Record<string, unknown>>("GET", `/api/v1/confirms/${encodeURIComponent(dealReference)}`);
  const accepted = d.dealStatus === "ACCEPTED";
  return {
    dealReference,
    accepted,
    reason: accepted ? null : typeof d.reason === "string" ? d.reason : "REFUSED",
    dealId: typeof d.dealId === "string" ? d.dealId : null,
    level: finite(d.level),
  };
}

export interface CloseInfo {
  level: number;
  /** ms */
  at: number | null;
}

/**
 * Looks in the account activity for the closing of `dealId`: { activities: [{ dateUTC, dealId, details: { level, actions:
 * [{ actionType, affectedDealId }] } }] }. Anything that does not look right gives null (the caller then asks the owner
 * for the exit price instead of guessing it).
 */
export function parseCloseActivity(data: unknown, dealId: string): CloseInfo | null {
  const list = (data as { activities?: unknown } | null)?.activities;
  if (!Array.isArray(list)) return null;
  let best: CloseInfo | null = null;
  for (const a of list as Array<Record<string, unknown>>) {
    const d = a?.details as { level?: unknown; actions?: unknown } | undefined;
    const actions = Array.isArray(d?.actions) ? (d.actions as Array<Record<string, unknown>>) : [];
    const closes = actions.some((x) => x?.actionType === "POSITION_CLOSED" && (x.affectedDealId === dealId || a.dealId === dealId));
    const level = finite(d?.level);
    if (!closes || level === null || level <= 0) continue;
    const when = typeof a.dateUTC === "string" ? parseUtc(a.dateUTC) * 1000 : typeof a.date === "string" ? parseUtc(a.date) * 1000 : NaN;
    const at = Number.isFinite(when) ? when : null;
    if (!best || (at ?? 0) >= (best.at ?? 0)) best = { level, at };
  }
  return best;
}

/** Closing price of a position that is gone from the list (stop or target hit, or closed on Capital.com itself). */
export async function getCloseInfo(dealId: string, sinceMs: number): Promise<CloseInfo | null> {
  const from = new Date(Math.max(0, sinceMs - 60_000)).toISOString().slice(0, 19);
  const data = await apiTrade<unknown>("GET", `/api/v1/history/activity?from=${from}&detailed=true`);
  return parseCloseActivity(data, dealId);
}
