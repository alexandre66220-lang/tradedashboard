import { beforeEach, describe, expect, it } from "vitest";
import { __resetJournalCache, computeCrowdFade, computeStats, modelFamily, parseSeriesKey, recordForecast, resolveEntries, resolveSeries, seriesKey, type SeriesRef } from "@/lib/journal/journal";
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

  it("tests going against the crowd by how lopsided it was, spread included", () => {
    const mk = (i: number, sentiment: number | undefined, dir: "up" | "down" | "flat", outcome: number) => ({
      id: String(i), epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30, steps: 6, t: T0 + i * 1800, recordedAt: 1000 + i,
      price: 100, direction: dir, confidence: 0.6, target: 100, source: "ML", ref: 100, prev: 100, outcome, ...(sentiment === undefined ? {} : { sentiment }),
    });
    const entries = [
      ...Array.from({ length: 15 }, (_, i) => mk(i, 80, "up", 99)), // crowd 80 % long, price falls: fading wins +1 %
      ...Array.from({ length: 5 }, (_, i) => mk(20 + i, 80, "down", 101)), // crowd long, price rises: fading loses
      ...Array.from({ length: 20 }, (_, i) => mk(30 + i, 25, "flat", 101)), // crowd 75 % short, price rises: fading wins (abstentions count)
      ...Array.from({ length: 3 }, (_, i) => mk(60 + i, 65, "up", 101)), // moderate crowd long, price rises: fading loses
      mk(70, 50, "up", 101), // split crowd: not tested
      mk(71, undefined, "up", 101), // no sentiment recorded: ignored
      { ...mk(72, 80, "up", 99), outcome: undefined }, // pending: ignored
    ];
    const c = computeCrowdFade(entries, () => 10);
    expect(c.judged).toBe(44);
    expect(c.extreme.fade).toMatchObject({ hits: 35, samples: 40 });
    expect(c.extreme.fade.hitRate).toBeCloseTo(0.875);
    expect(c.extreme.grossReturnPct).toBeCloseTo(35 - 5, 5);
    expect(c.extreme.netReturnPct).toBeCloseTo(30 - 40 * 0.1, 5);
    expect(c.moderate.fade).toMatchObject({ hits: 0, samples: 3, hitRate: null });
  });

  it("keeps the model versions apart", () => {
    expect(modelFamily("ML v2, gradient boosting + logistique")).toBe("ml2");
    expect(modelFamily("ML, gradient boosting + logistique")).toBe("ml");
    expect(modelFamily("intégré")).toBe("builtin");
    expect(modelFamily("intégré — service externe indisponible")).toBe("builtin");
    expect(modelFamily(undefined)).toBe("builtin");
  });

  it("splits hit rates by whether an announcement fell inside the window", () => {
    const mk = (i: number, news: boolean | undefined, outcome: number) => ({
      id: String(i), epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30, steps: 6, t: T0 + i * 1800, recordedAt: 1000 + i,
      price: 100, direction: "up" as const, confidence: 0.6, target: 100, source: "ML", ref: 100, prev: 100, outcome, ...(news === undefined ? {} : { news }),
    });
    const entries = [
      ...Array.from({ length: 20 }, (_, i) => mk(i, true, 99)), // announcement: wrong
      ...Array.from({ length: 20 }, (_, i) => mk(30 + i, false, 101)), // calm: right
      mk(60, undefined, 101), // recorded before the flag existed
    ];
    const st = computeStats(entries, () => 0);
    expect(st.byNews.near).toMatchObject({ hits: 0, samples: 20 });
    expect(st.byNews.calm).toMatchObject({ hits: 20, samples: 20 });
    expect(st.byNews.calm.hitRate).toBe(1);
  });

  it("stores the announcement flag only when it is known", async () => {
    const s = memoryStorage();
    await recordForecast(s, series, candles([100, 100, 100]), fc("up"), 1000, 55, true);
    const stored = (await s.read(seriesKey(series))).entries[0];
    expect(stored).toMatchObject({ news: true, sentiment: 55 });
    __resetJournalCache();
    const s2 = memoryStorage();
    await recordForecast(s2, series, candles([100, 100, 100]), fc("up"), 1000, 55);
    expect("news" in (await s2.read(seriesKey(series))).entries[0]).toBe(false);
  });

  it("splits hit rates by agreement of the technical readings and by Fibonacci proximity", () => {
    const mk = (i: number, agree: number, nearFib: boolean | undefined, outcome: number) => ({
      id: String(i), epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30, steps: 6, t: T0 + i * 1800, recordedAt: 1000 + i,
      price: 100, direction: "up" as const, confidence: 0.6, target: 100, source: "ML v2", ref: 100, prev: 100, outcome,
      confluence: { agree, against: 5 - agree, voting: 5 }, ...(nearFib === undefined ? {} : { nearFib }),
    });
    const entries = [
      ...Array.from({ length: 20 }, (_, i) => mk(i, 5, true, 101)), // many agree, near a level: right
      ...Array.from({ length: 20 }, (_, i) => mk(30 + i, 2, false, 99)), // some agree: wrong
      ...Array.from({ length: 20 }, (_, i) => mk(60 + i, 0, false, 99)), // none agree: wrong
      { ...mk(90, 3, undefined, 101), confluence: undefined }, // recorded before the readings existed
    ];
    const st = computeStats(entries, () => 0);
    expect(st.byConfluence.high).toMatchObject({ hits: 20, samples: 20 });
    expect(st.byConfluence.mid).toMatchObject({ hits: 0, samples: 20 });
    expect(st.byConfluence.low).toMatchObject({ hits: 0, samples: 20 });
    expect(st.byFib.near).toMatchObject({ hits: 20, samples: 20 });
    expect(st.byFib.away).toMatchObject({ hits: 0, samples: 40 });
  });

  it("stores the readings with a forecast", async () => {
    const s = memoryStorage();
    await recordForecast(s, series, candles([100, 100, 100]), fc("up"), 1000, 55, true, { confluence: { agree: 4, against: 1, voting: 5 }, nearFib: true });
    expect((await s.read(seriesKey(series))).entries[0]).toMatchObject({ confluence: { agree: 4, against: 1, voting: 5 }, nearFib: true });
  });
});
