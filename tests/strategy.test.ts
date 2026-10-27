import { describe, expect, it } from "vitest";
import { computeStats, costBps, recordForecast, resolveEntries, seriesKey, SIM_RR, simulateEntry, type SeriesRef } from "@/lib/journal/journal";
import { memoryStorage } from "@/lib/journal/storage";
import type { JournalEntry } from "@/lib/journal/types";
import { observedFrom, signalFrom } from "@/lib/signal";
import { efficiencyRatio, regimeOf } from "@/lib/regime";
import type { Candle } from "@/lib/types";

const STEP = 300;
const T0 = 1_700_000_000 - (1_700_000_000 % 1800);
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ time: T0 + i * STEP, open: o, high: h, low: l, close: c });

function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "e", epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30, steps: 6, t: T0, recordedAt: 1, price: 100,
    direction: "up", confidence: 0.6, target: 101, source: "ML v2, test", atr: 2, ...over,
  };
}
// ATR 2 -> stop distance 3 (1.5 ATR), target distance 6 (2 R)

describe("simulated trade", () => {
  it("stops out, hits the target, or leaves at the horizon", () => {
    const up = entry();
    const base = [bar(0, 100, 100, 100, 100)];
    const stopped = [...base, bar(1, 100, 101, 96.5, 98)];
    expect(simulateEntry(up, stopped, 0, 1)).toEqual({ r: -1, exit: "stop" });
    const winner = [...base, bar(1, 100, 106.5, 99.5, 105)];
    expect(simulateEntry(up, winner, 0, 1)).toEqual({ r: SIM_RR, exit: "target" });
    const drift = [...base, bar(1, 100, 101, 99, 101.5)];
    const out = simulateEntry(up, drift, 0, 1)!;
    expect(out.exit).toBe("time");
    expect(out.r).toBeCloseTo(0.5, 6);
  });

  it("counts a candle that touches both the stop and the target as a stop", () => {
    expect(simulateEntry(entry(), [bar(0, 100, 100, 100, 100), bar(1, 100, 107, 96, 100)], 0, 1)).toEqual({ r: -1, exit: "stop" });
  });

  it("mirrors for a down forecast, and does nothing for a neutral one or without an ATR", () => {
    const down = entry({ direction: "down" });
    expect(simulateEntry(down, [bar(0, 100, 100, 100, 100), bar(1, 100, 103.5, 99, 102)], 0, 1)).toEqual({ r: -1, exit: "stop" });
    expect(simulateEntry(down, [bar(0, 100, 100, 100, 100), bar(1, 100, 101, 93.5, 94)], 0, 1)).toEqual({ r: SIM_RR, exit: "target" });
    expect(simulateEntry(entry({ direction: "flat" }), [bar(0, 1, 1, 1, 1), bar(1, 1, 1, 1, 1)], 0, 1)).toBeUndefined();
    expect(simulateEntry(entry({ atr: undefined }), [bar(0, 1, 1, 1, 1), bar(1, 1, 1, 1, 1)], 0, 1)).toBeUndefined();
  });

  it("is computed when an entry is resolved", () => {
    const candles = [bar(0, 100, 100, 100, 100), bar(1, 100, 101, 96.5, 98), ...Array.from({ length: 8 }, (_, i) => bar(i + 2, 98, 98, 98, 98))];
    const { entries } = resolveEntries([entry({ steps: 2 })], candles);
    expect(entries[0].sim).toEqual({ r: -1, exit: "stop" });
    expect(entries[0].outcome).toBe(98);
  });
});

describe("costs", () => {
  const assumed = () => 4;
  const financing = () => 2;
  it("prefers the spread seen on the quote, and adds nights only for positions held a day or more", () => {
    expect(costBps(entry(), assumed, financing)).toBe(4);
    expect(costBps(entry({ spreadBps: 1.5 }), assumed, financing)).toBe(1.5);
    expect(costBps(entry({ resMinutes: 1440, horizon: 1440 }), assumed, financing)).toBe(4 + 2);
    expect(costBps(entry({ resMinutes: 10080, horizon: 10080 }), assumed, financing)).toBe(4 + 2 * 7);
  });
});

describe("strategy, calibration and regimes in the stats", () => {
  function resolved(i: number, over: Partial<JournalEntry>): JournalEntry {
    return entry({ id: String(i), t: T0 + i * 1800, ref: 100, prev: 100, outcome: 101, sim: { r: 2, exit: "target" }, ...over });
  }

  it("averages the simulated trades after cost, in R", () => {
    const entries = [
      ...Array.from({ length: 12 }, (_, i) => resolved(i, { sim: { r: 2, exit: "target" } })),
      ...Array.from({ length: 12 }, (_, i) => resolved(20 + i, { sim: { r: -1, exit: "stop" }, outcome: 99 })),
    ];
    // cost: 10 bps of 100 = 0.1, stop distance 3 -> 0.0333 R
    const st = computeStats(entries, () => 10);
    expect(st.strategy).toMatchObject({ trades: 24, target: 12, stop: 12, time: 0 });
    expect(st.strategy.meanNetR).toBeCloseTo((2 - 1) / 2 - 0.1 / 3, 6);
    expect(st.strategy.se).toBeGreaterThan(0);
    expect(computeStats(entries.slice(0, 5), () => 10).strategy.meanNetR).toBeNull(); // fewer than 20
  });

  it("reads the observed hit rate by confidence level and by market state", () => {
    const entries = [
      ...Array.from({ length: 25 }, (_, i) => resolved(i, { confidence: 0.52, outcome: i < 10 ? 101 : 99, regime: { vol: "wild", trend: "range" } })),
      ...Array.from({ length: 25 }, (_, i) => resolved(50 + i, { confidence: 0.62, outcome: 101, regime: { vol: "calm", trend: "trend" } })),
    ];
    const st = computeStats(entries, () => 0);
    expect(st.calibration[0].hit).toMatchObject({ hits: 10, samples: 25 });
    expect(st.calibration[2].hit).toMatchObject({ hits: 25, samples: 25 });
    expect(st.byVol.wild).toMatchObject({ hits: 10, samples: 25 });
    expect(st.byTrend.trend).toMatchObject({ hits: 25, samples: 25 });
    const obs = observedFrom(st, { confidence: 0.5501, vol: "wild", trend: "trend" });
    expect(obs.map((o) => o.label)).toEqual(["Marché agité", "Marché en tendance"]); // nobody sits in 55-60 %
    expect(observedFrom(st, { confidence: 0.52 })[0]).toMatchObject({ label: "Confiance affichée de 50 à 55 %", n: 25 });
    expect(signalFrom(st, { vol: "calm" }).observed?.[0].label).toBe("Marché calme");
  });
});

describe("market state", () => {
  const walk = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => bar(i, f(i), f(i) + 0.5, f(i) - 0.5, f(i)));
  it("efficiency ratio: 1 for a straight line, near 0 for back and forth", () => {
    expect(efficiencyRatio(walk(60, (i) => 100 + i))).toBeCloseTo(1, 6);
    expect(efficiencyRatio(walk(60, (i) => 100 + (i % 2)))!).toBeLessThan(0.1);
    expect(efficiencyRatio(walk(10, (i) => i))).toBeNull();
  });

  it("regime needs enough history, and calls a straight line a trend", () => {
    expect(regimeOf(walk(50, (i) => 100 + i))).toBeNull();
    const r = regimeOf(walk(400, (i) => 100 + i * 0.1 + Math.sin(i) * 0.01));
    expect(r?.trend).toBe("trend");
  });
});

describe("what the journal keeps at recording time", () => {
  const series: SeriesRef = { epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30 };
  const candles = Array.from({ length: 3 }, (_, i) => bar(i, 100, 100, 100, 100));
  const fc = { direction: "up" as const, confidence: 0.6, points: [{ time: 0, value: 101, low: 0, high: 0 }], source: "ML v2, test" };

  it("stores the ATR, the observed spread and the market state, and ignores nonsense", async () => {
    const s = memoryStorage();
    await recordForecast(s, series, candles, fc, 1000, null, undefined, { atr: 1.7, spreadBps: 2.345, regime: { vol: "calm", trend: "range" } });
    expect((await s.read(seriesKey(series))).entries[0]).toMatchObject({ atr: 1.7, spreadBps: 2.35, regime: { vol: "calm", trend: "range" } });
    const s2 = memoryStorage();
    await recordForecast(s2, { ...series, horizon: 60 }, candles, fc, 1000, null, undefined, { atr: -1, spreadBps: Number.NaN });
    const stored = (await s2.read(seriesKey({ ...series, horizon: 60 }))).entries[0];
    expect("atr" in stored).toBe(false);
    expect("spreadBps" in stored).toBe(false);
  });
});
