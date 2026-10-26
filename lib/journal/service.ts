import "server-only";
import { INSTRUMENTS, spreadBpsFor } from "@/config/instruments";
import { getCandles, getSentimentFor } from "@/lib/capital";
import type { Candle, ForecastResponse } from "@/lib/types";
import { computeStats, modelFamily, parseSeriesKey, recordForecast, resolveSeries, type SeriesRef } from "./journal";
import { getStorage } from "./storage";
import type { JournalEntry, JournalStats, ModelFamily } from "./types";

export const RESOLUTION_LABELS: Record<string, string> = {
  MINUTE: "1 min",
  MINUTE_5: "5 min",
  MINUTE_15: "15 min",
  DAY: "Jour",
  WEEK: "Semaine",
};

/** Never throws: the journal must not break a forecast. */
export async function recordSafe(series: SeriesRef, candles: Candle[], forecast: ForecastResponse): Promise<void> {
  const storage = getStorage();
  if (!storage) return;
  try {
    const sentiment = await getSentimentFor(series.epic, INSTRUMENTS.map((i) => i.epic));
    await recordForecast(storage, series, candles, forecast, Date.now(), sentiment?.long);
  } catch (err) {
    console.warn("[journal] record failed:", err instanceof Error ? err.message : "unknown");
  }
}

export interface JournalOverview {
  configured: boolean;
  generatedAt: number;
  models: Partial<Record<ModelFamily, JournalStats>>;
  series: Array<{ epic: string; name: string; resolution: string; label: string; horizon: number; model: ModelFamily; stats: JournalStats }>;
}

export async function journalOverview(): Promise<JournalOverview> {
  const storage = getStorage();
  if (!storage) return { configured: false, generatedAt: Date.now(), models: {}, series: [] };

  const keys = await storage.list();
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
      for (const family of ["ml", "builtin"] as const) {
        const part = entries.filter((e) => modelFamily(e.source) === family);
        if (part.length) {
          series.push({
            epic: ref.epic,
            name: inst.name,
            resolution: ref.resolution,
            label: RESOLUTION_LABELS[ref.resolution] ?? ref.resolution,
            horizon: ref.horizon,
            model: family,
            stats: computeStats(part, spreadBpsFor),
          });
        }
      }
    }),
  );

  const models: JournalOverview["models"] = {};
  for (const family of ["ml", "builtin"] as const) {
    const part = all.filter((e) => modelFamily(e.source) === family);
    if (part.length) models[family] = computeStats(part, spreadBpsFor);
  }
  series.sort((a, b) => a.epic.localeCompare(b.epic) || a.horizon - b.horizon || a.model.localeCompare(b.model));
  return { configured: true, generatedAt: Date.now(), models, series };
}
