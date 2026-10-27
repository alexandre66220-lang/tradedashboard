import type { Candle, ForecastResponse } from "../types";
import type { JournalStorage } from "./storage";
import { SESSIONS, type CurvePoint, type CrowdFadeGroup, type SessionKey, CrowdFadeStats, JournalEntry, JournalHit, JournalStats, ModelFamily } from "./types";

const MAX_ENTRIES_PER_SERIES = 1500;
const MIN_SAMPLES = 20;
const RETRIES = 4;

export interface SeriesRef {
  epic: string;
  /** Capital.com resolution, e.g. "MINUTE_5" */
  resolution: string;
  resMinutes: number;
  /** Horizon in minutes */
  horizon: number;
}

export const seriesKey = (s: Pick<SeriesRef, "epic" | "resolution" | "horizon">) => `journal/${s.epic}__${s.resolution}__${s.horizon}.json`;

export function parseSeriesKey(key: string): Pick<SeriesRef, "epic" | "resolution" | "horizon"> | null {
  const m = /^journal\/(.+)__(.+)__(\d+)\.json$/.exec(key);
  return m ? { epic: m[1], resolution: m[2], horizon: Number(m[3]) } : null;
}

export const modelFamily = (source: string | undefined): ModelFamily =>
  source?.startsWith("ML v2") ? "ml2" : source?.startsWith("ML") ? "ml" : "builtin";

export const stepsFor = (s: Pick<SeriesRef, "resMinutes" | "horizon">) => Math.max(1, Math.round(s.horizon / s.resMinutes));

// --------------------------------------------------------------------------- simulated trade

/** The simulated trade of the journal: stop at 1.5 ATR, target at twice the stop (the risk calculator's defaults). */
export const SIM_STOP_ATR = 1.5;
export const SIM_RR = 2;

/**
 * Replays "enter at the close of candle i in the forecast's direction, leave at the stop, the target, or at candle j" on
 * the candles that followed. A candle touching both is counted as a stop (conservative). Result in R (1 R = the stop).
 */
export function simulateEntry(e: JournalEntry, candles: Candle[], i: number, j: number): JournalEntry["sim"] | undefined {
  if (e.direction === "flat" || !(e.atr && e.atr > 0)) return undefined;
  const dir = e.direction === "up" ? 1 : -1;
  const entry = candles[i].close;
  const slDist = SIM_STOP_ATR * e.atr;
  const stop = entry - dir * slDist;
  const target = entry + dir * SIM_RR * slDist;
  for (let k = i + 1; k <= j; k++) {
    const c = candles[k];
    if (dir === 1 ? c.low <= stop : c.high >= stop) return { r: -1, exit: "stop" };
    if (dir === 1 ? c.high >= target : c.low <= target) return { r: SIM_RR, exit: "target" };
  }
  return { r: (dir * (candles[j].close - entry)) / slDist, exit: "time" };
}

// --------------------------------------------------------------------------- resolution

/** Reads outcomes for pending entries from the candle history. Same index-based definition as the backtest. */
export function resolveEntries(entries: JournalEntry[], candles: Candle[]): { entries: JournalEntry[]; changed: boolean } {
  if (!candles.length) return { entries, changed: false };
  const index = new Map(candles.map((c, i) => [c.time, i]));
  const oldest = candles[0].time;
  let changed = false;
  const out = entries.map((e) => {
    if (e.outcome !== undefined || e.expired) return e;
    const i = index.get(e.t);
    if (i === undefined) {
      if (e.t < oldest) {
        changed = true;
        return { ...e, expired: true };
      }
      return e;
    }
    const j = i + e.steps;
    // the outcome candle must be complete: another candle must exist after it
    if (j >= candles.length - 1) return e;
    changed = true;
    const sim = simulateEntry(e, candles, i, j);
    return { ...e, ref: candles[i].close, prev: i > 0 ? candles[i - 1].close : candles[i].close, outcome: candles[j].close, ...(sim ? { sim } : {}) };
  });
  return { entries: out, changed };
}

// --------------------------------------------------------------------------- recording

const seen = new Map<string, number>();
const SEEN_TTL_MS = 6 * 3600_000;
// A window whose recording failed is not retried on every poll (every few seconds), only once in a while
const failed = new Map<string, number>();
const FAILED_COOLDOWN_MS = 60_000;

export function __resetJournalCache() {
  seen.clear();
  failed.clear();
}

async function updateSeries(storage: JournalStorage, key: string, fn: (entries: JournalEntry[]) => JournalEntry[] | null): Promise<boolean> {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const { entries, etag } = await storage.read(key);
    const next = fn(entries);
    if (next === null) return false;
    if (await storage.write(key, next.slice(-MAX_ENTRIES_PER_SERIES), etag)) return true;
  }
  // Still conflicting. Entries are recorded and resolved idempotently (one per window, outcomes from candles), so a
  // lost update repairs itself on the next poll: better than a journal that never fills.
  const { entries } = await storage.read(key);
  const next = fn(entries);
  if (next === null) return false;
  console.warn("[journal] conflicting writes: overwriting");
  await storage.write(key, next.slice(-MAX_ENTRIES_PER_SERIES), null, true);
  return true;
}

/**
 * Records at most one forecast per (series, horizon-long window) and resolves older pending entries with
 * the candles at hand. Returns true when something was written.
 */
export async function recordForecast(
  storage: JournalStorage,
  series: SeriesRef,
  candles: Candle[],
  forecast: Pick<ForecastResponse, "direction" | "confidence" | "points" | "source">,
  now = Date.now(),
  sentimentLong?: number | null,
  news?: boolean,
  readings?: { confluence?: JournalEntry["confluence"]; nearFib?: boolean; atr?: number; spreadBps?: number; regime?: JournalEntry["regime"] },
): Promise<boolean> {
  const last = candles.at(-1);
  const target = forecast.points.at(-1)?.value;
  if (!last || target === undefined) return false;

  const steps = stepsFor(series);
  const windowSec = steps * series.resMinutes * 60;
  const id = `${series.epic}|${series.resolution}|${series.horizon}|${Math.floor(last.time / windowSec)}`;

  for (const [k, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(k);
  if (seen.has(id)) return false;
  if (now - (failed.get(id) ?? -Infinity) < FAILED_COOLDOWN_MS) return false;

  const entry: JournalEntry = {
    id,
    epic: series.epic,
    resolution: series.resolution,
    resMinutes: series.resMinutes,
    horizon: series.horizon,
    steps,
    t: last.time,
    recordedAt: now,
    price: last.close,
    direction: forecast.direction,
    confidence: forecast.confidence,
    target,
    source: forecast.source ?? "intégré",
    ...(typeof sentimentLong === "number" && Number.isFinite(sentimentLong) ? { sentiment: Math.round(sentimentLong * 10) / 10 } : {}),
    ...(typeof news === "boolean" ? { news } : {}),
    ...(readings?.confluence ? { confluence: readings.confluence } : {}),
    ...(typeof readings?.nearFib === "boolean" ? { nearFib: readings.nearFib } : {}),
    ...(readings?.atr && readings.atr > 0 ? { atr: readings.atr } : {}),
    ...(typeof readings?.spreadBps === "number" && Number.isFinite(readings.spreadBps) && readings.spreadBps >= 0 ? { spreadBps: Math.round(readings.spreadBps * 100) / 100 } : {}),
    ...(readings?.regime ? { regime: readings.regime } : {}),
  };
  let wrote: boolean;
  try {
    wrote = await updateSeries(storage, seriesKey(series), (entries) => {
      const { entries: resolved, changed } = resolveEntries(entries, candles);
      if (resolved.some((e) => e.id === id)) return changed ? resolved : null;
      return [...resolved, entry];
    });
  } catch (err) {
    failed.set(id, now);
    throw err;
  }
  seen.set(id, now);
  return wrote;
}

/** Resolves pending entries of one series from fresh candles and persists the result. */
export async function resolveSeries(storage: JournalStorage, key: string, candles: Candle[]): Promise<JournalEntry[]> {
  const { entries } = await storage.read(key);
  const res = resolveEntries(entries, candles);
  if (!res.changed) return entries;
  let latest = res.entries;
  await updateSeries(storage, key, (current) => {
    const r = resolveEntries(current, candles);
    latest = r.entries;
    return r.changed ? r.entries : null;
  });
  return latest;
}

// --------------------------------------------------------------------------- statistics

function hit(hits: number, samples: number): JournalHit {
  if (samples < MIN_SAMPLES) return { hits, samples, hitRate: null, margin: null };
  // entries never overlap, so every sample counts as independent
  return { hits, samples, hitRate: hits / samples, margin: Math.min(0.5, (1.96 * 0.5) / Math.sqrt(samples)) };
}

export type CrowdRelation = "with" | "against" | "neutral";

/** Was the forecast with or against the crowd? The crowd has a side only from 60 % on one side. */
export function crowdRelation(direction: "up" | "down" | "flat", longPct: number): CrowdRelation {
  const crowd = longPct >= 60 ? "up" : longPct <= 40 ? "down" : null;
  if (!crowd || direction === "flat") return "neutral";
  return direction === crowd ? "with" : "against";
}

/**
 * Round-trip cost of one entry, in basis points of the price: the spread seen on the quote when the forecast was made
 * (else the assumed one), plus the assumed overnight financing for forecasts that hold a position for a day or more.
 */
export function costBps(e: JournalEntry, spreadBps: (epic: string) => number, financingBps: (epic: string) => number): number {
  const nights = e.resMinutes >= 1440 ? Math.max(1, Math.ceil(e.horizon / 1440)) : 0;
  return (e.spreadBps ?? spreadBps(e.epic)) + financingBps(e.epic) * nights;
}

const CURVE_MAX_POINTS = 150;

/**
 * Cumulative net result of the judged forecasts (one unit per forecast, after costs), with the zone that chance alone
 * would keep it in: if the forecasts had no edge, the sum of n results of spread s drifts as s * sqrt(n), so a curve
 * that leaves ±1.96 s sqrt(n) is unlikely to be luck. (The mean of the results is assumed to be zero under chance.)
 */
export function buildCurve(entries: JournalEntry[], spreadBps: (epic: string) => number, financingBps: (epic: string) => number): { n: number; points: CurvePoint[] } {
  const rs: Array<{ t: number; r: number }> = [];
  for (const e of [...entries].sort((a, b) => a.t - b.t)) {
    if (e.expired || e.outcome === undefined || e.ref === undefined || e.direction === "flat" || e.outcome === e.ref) continue;
    const sign = e.direction === "up" ? 1 : -1;
    rs.push({ t: e.t, r: (sign * (e.outcome / e.ref - 1) - costBps(e, spreadBps, financingBps) / 1e4) * 100 });
  }
  const n = rs.length;
  if (n === 0) return { n, points: [] };
  const mean = rs.reduce((a, x) => a + x.r, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, x) => a + (x.r - mean) ** 2, 0) / Math.max(1, n - 1));
  let cum = 0;
  let lastT = 0;
  const all = rs.map((x, k) => {
    cum += x.r;
    lastT = Math.max(x.t, lastT + 1); // strictly increasing times, as the chart needs
    return { t: lastT, v: cum, b: 1.96 * sd * Math.sqrt(k + 1) };
  });
  if (all.length <= CURVE_MAX_POINTS) return { n, points: all };
  const step = (all.length - 1) / (CURVE_MAX_POINTS - 1);
  return { n, points: Array.from({ length: CURVE_MAX_POINTS }, (_, k) => all[Math.round(k * step)]) };
}

const CALIBRATION_EDGES = [0.5, 0.55, 0.6, 0.65, 1.0001] as const;

export function computeStats(entries: JournalEntry[], spreadBps: (epic: string) => number, financingBps: (epic: string) => number = () => 0): JournalStats {
  let pending = 0, expired = 0, flat = 0, hits = 0, upHits = 0, lastHits = 0, evaluated = 0;
  let gross = 0, net = 0;
  const crowd: Record<CrowdRelation, { hits: number; n: number }> = { with: { hits: 0, n: 0 }, against: { hits: 0, n: 0 }, neutral: { hits: 0, n: 0 } };
  const byNews = { near: { hits: 0, n: 0 }, calm: { hits: 0, n: 0 } };
  const byConfluence = { low: { hits: 0, n: 0 }, mid: { hits: 0, n: 0 }, high: { hits: 0, n: 0 } };
  const byFib = { near: { hits: 0, n: 0 }, away: { hits: 0, n: 0 } };
  const bySession = Object.fromEntries(SESSIONS.map((x) => [x.key, { hits: 0, n: 0, net: 0 }])) as Record<SessionKey, { hits: number; n: number; net: number }>;
  const byVol = { calm: { hits: 0, n: 0 }, normal: { hits: 0, n: 0 }, wild: { hits: 0, n: 0 } };
  const byTrend = { trend: { hits: 0, n: 0 }, range: { hits: 0, n: 0 } };
  const calib = CALIBRATION_EDGES.slice(0, -1).map(() => ({ hits: 0, n: 0, conf: 0 }));
  const strat = { n: 0, sum: 0, sum2: 0, target: 0, stop: 0, time: 0 };
  const curve: JournalStats["curve"] = [];
  let first: number | null = null;

  for (const e of [...entries].sort((a, b) => a.t - b.t)) {
    first = first === null ? e.recordedAt : Math.min(first, e.recordedAt);
    if (e.expired) {
      expired++;
      continue;
    }
    if (e.outcome === undefined || e.ref === undefined || e.prev === undefined) {
      pending++;
      continue;
    }
    if (e.direction === "flat") {
      flat++;
      continue;
    }
    const move = e.outcome - e.ref;
    if (move === 0) continue;
    const up = move > 0;
    const sign = e.direction === "up" ? 1 : -1;
    evaluated++;
    hits += (e.direction === "up") === up ? 1 : 0;
    if (e.sentiment !== undefined) {
      const g = crowd[crowdRelation(e.direction, e.sentiment)];
      g.n++;
      g.hits += (e.direction === "up") === up ? 1 : 0;
    }
    if (e.confluence) {
      const g = byConfluence[e.confluence.agree >= 4 ? "high" : e.confluence.agree >= 2 ? "mid" : "low"];
      g.n++;
      g.hits += (e.direction === "up") === up ? 1 : 0;
    }
    if (e.nearFib !== undefined) {
      const g = byFib[e.nearFib ? "near" : "away"];
      g.n++;
      g.hits += (e.direction === "up") === up ? 1 : 0;
    }
    if (e.news !== undefined) {
      const g = byNews[e.news ? "near" : "calm"];
      g.n++;
      g.hits += (e.direction === "up") === up ? 1 : 0;
    }
    if (e.regime) {
      const a = byVol[e.regime.vol];
      const b = byTrend[e.regime.trend];
      for (const g of [a, b]) {
        g.n++;
        g.hits += (e.direction === "up") === up ? 1 : 0;
      }
    }
    const bin = CALIBRATION_EDGES.findIndex((edge, k) => e.confidence >= edge && e.confidence < CALIBRATION_EDGES[k + 1]);
    if (bin >= 0) {
      calib[bin].n++;
      calib[bin].conf += e.confidence;
      calib[bin].hits += (e.direction === "up") === up ? 1 : 0;
    }
    const cost = costBps(e, spreadBps, financingBps) / 1e4;
    if (e.sim && e.atr && e.atr > 0) {
      const slDist = SIM_STOP_ATR * e.atr;
      const netR = e.sim.r - (e.ref * cost) / slDist;
      strat.n++;
      strat.sum += netR;
      strat.sum2 += netR * netR;
      strat[e.sim.exit]++;
    }
    if (e.resMinutes < 1440) {
      const hour = new Date(e.t * 1000).getUTCHours();
      const part = SESSIONS.find((x) => hour >= x.from && hour < x.to);
      if (part) {
        const g = bySession[part.key];
        g.n++;
        g.hits += (e.direction === "up") === up ? 1 : 0;
        g.net += sign * (e.outcome / e.ref - 1) - cost;
      }
    }
    upHits += up ? 1 : 0;
    lastHits += e.ref - e.prev >= 0 === up ? 1 : 0;
    const r = sign * (e.outcome / e.ref - 1);
    gross += r;
    net += r - cost;
    curve.push({ t: e.t, v: net * 100 });
  }
  return {
    recorded: entries.length,
    pending,
    expired,
    flat,
    evaluated,
    model: hit(hits, evaluated),
    baselines: { alwaysUp: hit(upHits, evaluated), lastMove: hit(lastHits, evaluated) },
    bySentiment: { with: hit(crowd.with.hits, crowd.with.n), against: hit(crowd.against.hits, crowd.against.n), neutral: hit(crowd.neutral.hits, crowd.neutral.n) },
    bySession: Object.fromEntries(SESSIONS.map((x) => [x.key, { hit: hit(bySession[x.key].hits, bySession[x.key].n), netReturnPct: bySession[x.key].net * 100 }])) as JournalStats["bySession"],
    byConfluence: { low: hit(byConfluence.low.hits, byConfluence.low.n), mid: hit(byConfluence.mid.hits, byConfluence.mid.n), high: hit(byConfluence.high.hits, byConfluence.high.n) },
    byFib: { near: hit(byFib.near.hits, byFib.near.n), away: hit(byFib.away.hits, byFib.away.n) },
    byNews: { near: hit(byNews.near.hits, byNews.near.n), calm: hit(byNews.calm.hits, byNews.calm.n) },
    byVol: { calm: hit(byVol.calm.hits, byVol.calm.n), normal: hit(byVol.normal.hits, byVol.normal.n), wild: hit(byVol.wild.hits, byVol.wild.n) },
    byTrend: { trend: hit(byTrend.trend.hits, byTrend.trend.n), range: hit(byTrend.range.hits, byTrend.range.n) },
    calibration: calib.map((c, k) => ({ from: CALIBRATION_EDGES[k], to: Math.min(1, CALIBRATION_EDGES[k + 1]), meanConfidence: c.n ? c.conf / c.n : null, hit: hit(c.hits, c.n) })),
    strategy: {
      trades: strat.n,
      meanNetR: strat.n >= MIN_SAMPLES ? strat.sum / strat.n : null,
      se: strat.n >= MIN_SAMPLES ? Math.sqrt(Math.max(0, strat.sum2 / strat.n - (strat.sum / strat.n) ** 2) / strat.n) : null,
      target: strat.target,
      stop: strat.stop,
      time: strat.time,
    },
    netReturnPct: net * 100,
    grossReturnPct: gross * 100,
    curve,
    firstRecordedAt: first,
  };
}

/** Share of clients long from which the crowd counts as "extreme" (on either side). */
export const CROWD_EXTREME = 70;

/**
 * Hit rate and net return of systematically trading against the majority of clients, by how lopsided
 * the crowd was. Independent of the forecast model: abstentions ("flat") count too.
 */
export function computeCrowdFade(entries: JournalEntry[], spreadBps: (epic: string) => number): CrowdFadeStats {
  const acc = { extreme: { hits: 0, n: 0, gross: 0, net: 0 }, moderate: { hits: 0, n: 0, gross: 0, net: 0 } };
  let judged = 0;
  for (const e of entries) {
    if (e.expired || e.sentiment === undefined || e.outcome === undefined || e.ref === undefined) continue;
    judged++;
    const move = e.outcome - e.ref;
    if (move === 0) continue;
    const long = e.sentiment;
    const side = long >= 60 ? 1 : long <= 40 ? -1 : 0; // the crowd's side; 0 = split
    if (side === 0) continue;
    const g = long >= CROWD_EXTREME || long <= 100 - CROWD_EXTREME ? acc.extreme : acc.moderate;
    const r = -side * (e.outcome / e.ref - 1);
    g.n++;
    g.hits += (move > 0) === (side < 0) ? 1 : 0;
    g.gross += r;
    g.net += r - spreadBps(e.epic) / 1e4;
  }
  const group = (g: typeof acc.extreme): CrowdFadeGroup => ({ fade: hit(g.hits, g.n), grossReturnPct: g.gross * 100, netReturnPct: g.net * 100 });
  return { judged, extreme: group(acc.extreme), moderate: group(acc.moderate) };
}
