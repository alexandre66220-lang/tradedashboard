import type { Candle, ForecastResponse } from "../types";
import type { JournalStorage } from "./storage";
import type { JournalEntry, JournalHit, JournalStats, ModelFamily } from "./types";

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

export const modelFamily = (source: string | undefined): ModelFamily => (source?.startsWith("ML") ? "ml" : "builtin");

export const stepsFor = (s: Pick<SeriesRef, "resMinutes" | "horizon">) => Math.max(1, Math.round(s.horizon / s.resMinutes));

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
    return { ...e, ref: candles[i].close, prev: i > 0 ? candles[i - 1].close : candles[i].close, outcome: candles[j].close };
  });
  return { entries: out, changed };
}

// --------------------------------------------------------------------------- recording

const seen = new Map<string, number>();
const SEEN_TTL_MS = 6 * 3600_000;

export function __resetJournalCache() {
  seen.clear();
}

async function updateSeries(storage: JournalStorage, key: string, fn: (entries: JournalEntry[]) => JournalEntry[] | null): Promise<boolean> {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const { entries, etag } = await storage.read(key);
    const next = fn(entries);
    if (next === null) return false;
    if (await storage.write(key, next.slice(-MAX_ENTRIES_PER_SERIES), etag)) return true;
  }
  throw new Error("journal write kept conflicting");
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
): Promise<boolean> {
  const last = candles.at(-1);
  const target = forecast.points.at(-1)?.value;
  if (!last || target === undefined) return false;

  const steps = stepsFor(series);
  const windowSec = steps * series.resMinutes * 60;
  const id = `${series.epic}|${series.resolution}|${series.horizon}|${Math.floor(last.time / windowSec)}`;

  for (const [k, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(k);
  if (seen.has(id)) return false;

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
  };
  const wrote = await updateSeries(storage, seriesKey(series), (entries) => {
    const { entries: resolved, changed } = resolveEntries(entries, candles);
    if (resolved.some((e) => e.id === id)) return changed ? resolved : null;
    return [...resolved, entry];
  });
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

export function computeStats(entries: JournalEntry[], spreadBps: (epic: string) => number): JournalStats {
  let pending = 0, expired = 0, flat = 0, hits = 0, upHits = 0, lastHits = 0, evaluated = 0;
  let gross = 0, net = 0;
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
    upHits += up ? 1 : 0;
    lastHits += e.ref - e.prev >= 0 === up ? 1 : 0;
    const r = sign * (e.outcome / e.ref - 1);
    gross += r;
    net += r - spreadBps(e.epic) / 1e4;
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
    netReturnPct: net * 100,
    grossReturnPct: gross * 100,
    curve,
    firstRecordedAt: first,
  };
}
