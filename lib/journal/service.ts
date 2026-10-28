import "server-only";
import { financingBpsFor, INSTRUMENTS, spreadBpsFor } from "@/config/instruments";
import { getCandles, getMarketQuote, getSentimentFor } from "@/lib/capital";
import { regimeOf } from "@/lib/regime";
import { readingsForJournal } from "@/lib/context";
import { relevantEvents } from "@/lib/calendar";
import { getCalendar } from "@/lib/calendar-source";
import type { Candle, ForecastResponse } from "@/lib/types";
import { averageTrueRange } from "@/lib/risk";
import { fibRetracement, nearFibLevel, stampFor, technicalVotes } from "@/lib/indicators";
import { signalFrom, type SignalContext, type SignalStatus } from "@/lib/signal";
import { buildCurve, computeCrowdFade, computeStats, modelFamily, parseSeriesKey, recordForecast, resolveSeries, type SeriesRef } from "./journal";
import { getStorage } from "./storage";
import { MODEL_FAMILIES, type CrowdFadeStats, type JournalEntry, type JournalStats, type ModelFamily, type ResultCurve } from "./types";

export const RESOLUTION_LABELS: Record<string, string> = {
  MINUTE: "1 min",
  MINUTE_5: "5 min",
  MINUTE_15: "15 min",
  DAY: "Jour",
  WEEK: "Semaine",
};

const NEWS_BEFORE_MIN = 15; // an announcement that just happened still moves the price

/** Did a high-impact announcement fall inside the forecast window? Undefined for daily / weekly series or when the calendar is down. */
async function newsInWindow(series: SeriesRef, now: number): Promise<boolean | undefined> {
  if (series.resMinutes >= 1440) return undefined;
  const inst = INSTRUMENTS.find((i) => i.epic === series.epic);
  if (!inst) return undefined;
  try {
    const { events } = await getCalendar();
    return relevantEvents(events, inst, now / 1000, -NEWS_BEFORE_MIN, series.horizon).some((e) => e.impact === "high");
  } catch {
    return undefined;
  }
}

/** Spread on the broker's quote, in basis points of the price; undefined when the market gives none (closed, no quote). */
async function observedSpreadBps(epic: string): Promise<number | undefined> {
  try {
    const q = await getMarketQuote(epic);
    if (q.bid === null || q.offer === null || !(q.offer >= q.bid)) return undefined;
    return ((q.offer - q.bid) / ((q.offer + q.bid) / 2)) * 1e4;
  } catch {
    return undefined;
  }
}

/**
 * What the journal keeps about the moment of a forecast: classic readings (does their agreement mean anything?), the ATR the
 * simulated stop and target are based on, the market state, and the real spread (instead of an assumed one).
 */
async function readingsAt(series: SeriesRef, candles: Candle[], forecast: ForecastResponse) {
  const last = candles.at(-1);
  if (!last || candles.length < 60) return undefined;
  const atr = averageTrueRange(candles) ?? undefined;
  const external = await readingsForJournal(series.epic, series.resMinutes < 1440).catch(() => ({}));
  return {
    ...external,
    confluence: stampFor(technicalVotes(candles, series.resMinutes), forecast.direction) ?? undefined,
    nearFib: nearFibLevel(last.close, fibRetracement(candles), atr ?? null),
    atr,
    regime: regimeOf(candles) ?? undefined,
    spreadBps: series.resMinutes < 1440 ? await observedSpreadBps(series.epic) : undefined,
  };
}

/** Never throws: the journal must not break a forecast. */
export async function recordSafe(series: SeriesRef, candles: Candle[], forecast: ForecastResponse): Promise<void> {
  const storage = getStorage();
  if (!storage) return;
  try {
    const sentiment = await getSentimentFor(series.epic, INSTRUMENTS.map((i) => i.epic));
    const now = Date.now();
    await recordForecast(storage, series, candles, forecast, now, sentiment?.long, await newsInWindow(series, now), await readingsAt(series, candles, forecast));
  } catch (err) {
    console.warn("[journal] record failed:", err instanceof Error ? err.message : "unknown");
  }
}

export interface JournalOverview {
  configured: boolean;
  generatedAt: number;
  /** Recording activity, to tell whether the journal is filling up */
  activity?: { lastRecordedAt: number | null; last24h: number; total: number };
  models: Partial<Record<ModelFamily, JournalStats>>;
  /** Result curves per model and per instrument (and for all instruments) */
  curves?: ResultCurve[];
  /** "Go against the crowd" test, over every recorded window */
  crowd: CrowdFadeStats | null;
  series: Array<{ epic: string; name: string; resolution: string; label: string; horizon: number; model: ModelFamily; stats: JournalStats }>;
}

// The overview reads every series file: it is kept for a short while, as is the list of files (which almost never
// changes). Storage operations are metered on the free plans.
const OVERVIEW_TTL_MS = 2 * 60_000;
const KEYS_TTL_MS = 15 * 60_000;
let overviewCache: { at: number; value: Promise<JournalOverview> } | null = null;
let keysCache: { at: number; value: Promise<string[]> } | null = null;

export function __resetOverviewCache() {
  overviewCache = null;
  keysCache = null;
}

export function journalOverview(): Promise<JournalOverview> {
  const now = Date.now();
  if (overviewCache && now - overviewCache.at < OVERVIEW_TTL_MS) return overviewCache.value;
  const value = buildOverview();
  overviewCache = { at: now, value };
  value.catch(() => {
    if (overviewCache?.value === value) overviewCache = null;
  });
  return value;
}

async function seriesKeys(storage: NonNullable<ReturnType<typeof getStorage>>): Promise<string[]> {
  const now = Date.now();
  if (keysCache && now - keysCache.at < KEYS_TTL_MS) return keysCache.value;
  const value = storage.list();
  keysCache = { at: now, value };
  value.catch(() => {
    if (keysCache?.value === value) keysCache = null;
  });
  return value;
}

async function buildOverview(): Promise<JournalOverview> {
  const storage = getStorage();
  if (!storage) return { configured: false, generatedAt: Date.now(), models: {}, crowd: null, series: [] };

  const keys = await seriesKeys(storage);
  const all: JournalEntry[] = [];
  const series: JournalOverview["series"] = [];

  await Promise.all(
    keys.map(async (key) => {
      const ref = parseSeriesKey(key);
      const inst = ref && INSTRUMENTS.find((i) => i.epic === ref.epic);
      if (!ref || !inst) return;
      let entries = (await storage.read(key)).entries;
      if (entries.some((e) => e.outcome === undefined && !e.expired)) {
        try {
          const candles = await getCandles(ref.epic, ref.resolution, 1000, 60_000);
          entries = await resolveSeries(storage, key, candles);
        } catch {
          /* keep unresolved entries as pending */
        }
      }
      all.push(...entries);
      for (const family of MODEL_FAMILIES) {
        const part = entries.filter((e) => modelFamily(e.source) === family);
        if (part.length) {
          series.push({
            epic: ref.epic,
            name: inst.name,
            resolution: ref.resolution,
            label: RESOLUTION_LABELS[ref.resolution] ?? ref.resolution,
            horizon: ref.horizon,
            model: family,
            stats: computeStats(part, spreadBpsFor, financingBpsFor),
          });
        }
      }
    }),
  );

  const models: JournalOverview["models"] = {};
  for (const family of MODEL_FAMILIES) {
    const part = all.filter((e) => modelFamily(e.source) === family);
    if (part.length) models[family] = computeStats(part, spreadBpsFor, financingBpsFor);
  }
  series.sort((a, b) => a.epic.localeCompare(b.epic) || a.horizon - b.horizon || a.model.localeCompare(b.model));
  const dayAgo = Date.now() - 24 * 3600_000;
  const activity = {
    lastRecordedAt: all.reduce<number | null>((m, e) => (m === null || e.recordedAt > m ? e.recordedAt : m), null),
    last24h: all.filter((e) => e.recordedAt >= dayAgo).length,
    total: all.length,
  };
  const curves: ResultCurve[] = [];
  for (const family of MODEL_FAMILIES) {
    const part = all.filter((e) => modelFamily(e.source) === family);
    for (const epic of [null, ...INSTRUMENTS.map((i) => i.epic)]) {
      const c = buildCurve(epic === null ? part : part.filter((e) => e.epic === epic), spreadBpsFor, financingBpsFor);
      if (c.n > 0) curves.push({ model: family, epic, n: c.n, points: c.points });
    }
  }
  return { configured: true, generatedAt: Date.now(), activity, models, curves, crowd: computeCrowdFade(all, spreadBpsFor), series };
}

/** Live status of one forecast series, for the model that produced the forecast being shown. */
export async function signalFor(epic: string, resolution: string, horizon: number, source: string | undefined, ctx: SignalContext = {}): Promise<SignalStatus> {
  const overview = await journalOverview();
  const family = modelFamily(source);
  const row = overview.series.find((s) => s.epic === epic && s.resolution === resolution && s.horizon === horizon && s.model === family);
  return signalFrom(row?.stats, ctx);
}
