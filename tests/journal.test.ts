import { beforeEach, describe, expect, it } from "vitest";
import { __resetJournalCache, computeStats, parseSeriesKey, recordForecast, resolveEntries, resolveSeries, seriesKey, type SeriesRef } from "@/lib/journal/journal";
import { memoryStorage } from "@/lib/journal/storage";
import type { Candle } from "@/lib/types";

const series: SeriesRef = { epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30 };
const STEP = 300;
const T0 = 1_700_000_000 - (1_700_000_000 % 1800); // aligned on a 30-min window

function candles(closes: number[], start = T0): Candle[] {
  return closes.map((c, i) => ({ time: start + i * STEP, open: c, high: c, low: c, close: c }));
}
const fc = (direction: "up" | "down" | "flat", target = 101, source = "ML, test") => ({
  direction,
  confidence: 0.6,
  points: [{ time: 0, value: target, low: 0, high: 0 }],
  source,
});

describe("journal", () => {
  beforeEach(() => __resetJournalCache());

  it("records one forecast per horizon window and ignores repeated polls", async () => {
    const s = memoryStorage();
    const c = candles([100, 100, 100]);
    expect(await recordForecast(s, series, c, fc("up"), 1000)).toBe(true);
    expect(await recordForecast(s, series, c, fc("up"), 2000)).toBe(false);
    // 2 candles later, still the same 30-min window (6 candles per window)
    expect(await recordForecast(s, series, candles([100, 100, 100, 101, 101]), fc("down"), 3000)).toBe(false);
    __resetJournalCache(); // another server instance: must still not duplicate
    expect(await recordForecast(s, series, candles([100, 100, 100, 101, 101]), fc("down"), 4000)).toBe(false);
    const { entries } = await s.read(seriesKey(series));
    expect(entries).toHaveLength(1);
    // next window
    expect(await recordForecast(s, series, candles(Array(8).fill(100)), fc("down"), 5000)).toBe(true);
    expect((await s.read(seriesKey(series))).entries).toHaveLength(2);
  });

  it("resolves with final closes and only once the outcome candle is complete", () => {
    const entry = {
      id: "x", epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30, steps: 6, t: T0 + STEP, recordedAt: 0,
      price: 100.5, direction: "up" as const, confidence: 0.6, target: 101, source: "ML",
    };
    // outcome candle (index 7) is the last one => still forming => not resolved
    const closes = [99, 100, 100, 100, 100, 100, 100, 103];
    expect(resolveEntries([entry], candles(closes)).changed).toBe(false);
    const r = resolveEntries([entry], candles([...closes, 104]));
    expect(r.entries[0]).toMatchObject({ ref: 100, prev: 99, outcome: 103 });
  });

  it("expires entries that left the loaded history", () => {
    const entry = { id: "x", epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30, steps: 6, t: T0 - 10_000, recordedAt: 0, price: 1, direction: "up" as const, confidence: 1, target: 1, source: "ML" };
    expect(resolveEntries([entry], candles([1, 1, 1])).entries[0].expired).toBe(true);
  });

  it("computes hit rate, baselines and a net curve after spread", async () => {
    const mk = (i: number, dir: "up" | "down" | "flat", ref: number, outcome: number, prev: number) => ({
      id: String(i), epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30, steps: 6, t: T0 + i * 1800, recordedAt: 1000 + i,
      price: ref, direction: dir, confidence: 0.6, target: ref, source: "ML", ref, prev, outcome,
    });
    const entries = [
      ...Array.from({ length: 24 }, (_, i) => mk(i, "up", 100, 101, 99.9)), // 24 right calls, +1 % each
      ...Array.from({ length: 6 }, (_, i) => mk(30 + i, "down", 100, 101, 99.9)), // 6 wrong calls
      mk(40, "flat", 100, 101, 99), // abstention
      { ...mk(41, "up", 100, 100, 100), outcome: undefined, ref: undefined, prev: undefined }, // pending
    ];
    const st = computeStats(entries, () => 10); // 10 bps spread
    expect(st).toMatchObject({ evaluated: 30, flat: 1, pending: 1 });
    expect(st.model.hitRate).toBeCloseTo(0.8);
    expect(st.baselines.alwaysUp.hitRate).toBeCloseTo(1);
    expect(st.grossReturnPct).toBeCloseTo(24 - 6, 5);
    expect(st.netReturnPct).toBeCloseTo(18 - 30 * 0.1, 5);
    expect(st.curve).toHaveLength(30);
    expect(st.curve[0].v).toBeCloseTo(1 - 0.1, 5);
  });

  it("shows no hit rate before 20 resolved calls", () => {
    const e = { id: "1", epic: "GOLD", resolution: "DAY", resMinutes: 1440, horizon: 1440, steps: 1, t: 1, recordedAt: 1, price: 1, direction: "up" as const, confidence: 1, target: 1, source: "ML", ref: 1, prev: 1, outcome: 2 };
    const st = computeStats([e], () => 0);
    expect(st.model).toMatchObject({ hits: 1, samples: 1, hitRate: null, margin: null });
  });

  it("resolves a stored series from fresh candles", async () => {
    const s = memoryStorage();
    await recordForecast(s, series, candles([100, 100, 100]), fc("up"), 1000);
    const later = candles([100, 100, 100, 100, 100, 100, 100, 100, 102, 103]); // entry at index 2, outcome index 8
    const out = await resolveSeries(s, seriesKey(series), later);
    expect(out[0]).toMatchObject({ ref: 100, outcome: 102 });
    expect((await s.read(seriesKey(series))).entries[0].outcome).toBe(102);
  });

  it("round-trips series keys", () => {
    expect(parseSeriesKey(seriesKey(series))).toEqual({ epic: "GOLD", resolution: "MINUTE_5", horizon: 30 });
  });
});
