import { describe, expect, it } from "vitest";
import { adviseSlTp, pivotLevels, significance, simulateExits } from "@/lib/sltp";
import type { Candle } from "@/lib/types";

const candle = (i: number, close: number, half = 0.5): Candle => ({ time: 1_700_000_000 + i * 300, open: close, high: close + half, low: close - half, close });
const series = (closes: number[], half = 0.5) => closes.map((c, i) => candle(i, c, half));

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
}

describe("pivot levels", () => {
  it("finds confirmed swing highs and lows and merges close ones", () => {
    // two similar peaks (110, 110.1) and a trough (90)
    const closes = [100, 103, 106, 110, 106, 103, 100, 95, 90, 95, 100, 105, 110.1, 105, 100, 98, 97, 96];
    const { highs, lows } = pivotLevels(series(closes, 0), 0.5, 3, 300);
    expect(highs).toHaveLength(1);
    expect(highs[0].touches).toBe(2);
    expect(highs[0].price).toBeCloseTo(110.05, 1);
    expect(lows).toHaveLength(1);
    expect(lows[0].price).toBe(90);
  });

  it("ignores the last candles, which cannot be confirmed yet", () => {
    const closes = [100, 101, 102, 103, 104, 105, 106, 120];
    expect(pivotLevels(series(closes, 0), 0.5, 3).highs).toHaveLength(0);
  });
});

describe("simulateExits", () => {
  const rising = series(Array.from({ length: 80 }, (_, i) => 100 + i)); // +1 per candle, range +-0.5

  it("replays stop / target / timeout on the history", () => {
    const long = simulateExits(rising, "long", 2, 3, 10, 0)!;
    expect(long.pTp).toBe(1);
    expect(long.grossR).toBeCloseTo(1.5);
    const short = simulateExits(rising, "short", 2, 3, 10, 0)!;
    expect(short.pSl).toBe(1);
    expect(short.grossR).toBeCloseTo(-1);
    // spread: 0.2 on a 2.0 stop = 0.1 R
    expect(simulateExits(rising, "long", 2, 3, 10, 0.2)!.netR).toBeCloseTo(1.4);
  });

  it("assumes the stop is hit first when one candle touches both", () => {
    const wild = series(Array.from({ length: 60 }, () => 100), 5); // every candle spans +-5
    const r = simulateExits(wild, "long", 2, 2, 5, 0)!;
    expect(r.pSl).toBe(1);
    expect(r.grossR).toBe(-1);
  });

  it("closes at market after the holding time", () => {
    const flat = series(Array.from({ length: 60 }, () => 100), 0.1);
    const r = simulateExits(flat, "long", 5, 5, 8, 0.5)!;
    expect(r.pTimeout).toBe(1);
    expect(r.grossR).toBeCloseTo(0);
    expect(r.netR).toBeCloseTo(-0.1);
  });

  it("finds no free lunch on a random walk: expectancy is ~0 before costs, for any stop and target", () => {
    const r = rng(11);
    let p = 1000;
    const walk = series(Array.from({ length: 4000 }, () => (p += r() * 2)), 0.6);
    for (const [sl, tp] of [[1, 1], [2, 4], [4, 2], [1, 6]]) {
      for (const side of ["long", "short"] as const) {
        const s = simulateExits(walk, side, sl, tp, 20, 0)!;
        expect(Math.abs(s.grossR)).toBeLessThan(3 * s.se + 0.02);
      }
    }
  });

  it("refuses to run on too little history", () => {
    expect(simulateExits(series([1, 2, 3]), "long", 1, 1, 5, 0)).toBeNull();
  });
});

describe("significance", () => {
  const base = { samples: 500, pTp: 0.3, pSl: 0.5, pTimeout: 0.2, grossR: 0, netR: 0, se: 0.05 };
  it("compares the net result with its margin of error", () => {
    expect(significance({ ...base, netR: 0.3 })).toBe("edge");
    expect(significance({ ...base, netR: 0.05 })).toBe("none");
    expect(significance({ ...base, netR: -0.3 })).toBe("against");
  });
});

describe("adviseSlTp", () => {
  // quiet market around 100 with a clear trough near 98 and a peak near 104
  const closes = Array.from({ length: 200 }, (_, i) => {
    const wave = 2.2 * Math.sin(i / 6);
    return 100 + wave + (i % 2 ? 0.1 : -0.1);
  });
  const candles = series(closes, 0.4);
  const entry = candles.at(-1)!.close;

  it("places the stop beyond the last swing, with a margin, and offers consistent targets", () => {
    const a = adviseSlTp({ candles, side: "long", entry, spreadBps: 2, holdBars: 18, forecast: null });
    if ("error" in a) throw new Error(a.error);
    expect(a.stop.price).toBeLessThan(entry);
    expect(a.stop.distance).toBeCloseTo(entry - a.stop.price);
    expect(a.stop.atrMultiple).toBeGreaterThan(0.8);
    expect(a.targets.length).toBeGreaterThanOrEqual(4);
    for (const t of a.targets) {
      expect(t.price).toBeGreaterThan(entry);
      expect(t.rr).toBeCloseTo(t.distance / a.stop.distance);
    }
    expect(a.targets.some((t) => t.key === a.recommended)).toBe(true);
    const rec = a.targets.find((t) => t.key === a.recommended)!;
    expect(rec.stats).not.toBeNull();
    expect(rec.rr).toBeGreaterThanOrEqual(1.5 - 1e-9);
    expect(rec.rr).toBeLessThanOrEqual(3.5);
  });

  it("warns when the next obstacle leaves less room than the risk", () => {
    // entry just below a peak: the swing high is ~0.9 ATR away while the stop is ~2 ATR away
    const near = Array.from({ length: 200 }, (_, i) => 100 + 2.2 * Math.sin(i / 6) + (i % 2 ? 0.1 : -0.1));
    const cs = series(near, 0.4);
    const a = adviseSlTp({ candles: cs, side: "long", entry: Math.max(...near.slice(0, 190)) - 1, spreadBps: 2, holdBars: 18 });
    if ("error" in a) throw new Error(a.error);
    const obstacle = a.targets.find((t) => t.key === "structure");
    if (obstacle && obstacle.rr < 1) expect(a.warnings.some((w) => /espace/.test(w))).toBe(true);
    else expect(a.warnings.some((w) => /espace/.test(w))).toBe(false);
  });

  it("mirrors everything for a short and mentions the model only when it agrees", () => {
    const up = { direction: "up" as const, target: entry + 1.5 };
    const long = adviseSlTp({ candles, side: "long", entry, spreadBps: 2, holdBars: 18, forecast: up });
    const short = adviseSlTp({ candles, side: "short", entry, spreadBps: 2, holdBars: 18, forecast: up });
    if ("error" in long || "error" in short) throw new Error("advice failed");
    expect(long.targets.some((t) => t.key === "model")).toBe(true);
    expect(short.targets.some((t) => t.key === "model")).toBe(false);
    expect(short.stop.price).toBeGreaterThan(entry);
    for (const t of short.targets) expect(t.price).toBeLessThan(entry);
  });

  it("falls back to 1.5 ATR without any usable level, and errors without history", () => {
    const flat = series(Array.from({ length: 120 }, (_, i) => 100 + (i % 2) * 0.01), 0.5);
    const a = adviseSlTp({ candles: flat, side: "long", entry: 100, spreadBps: 1, holdBars: 12 });
    if ("error" in a) throw new Error(a.error);
    expect(a.stop.structure).toBe(false);
    expect(a.stop.atrMultiple).toBeCloseTo(1.5);
    expect(a.recommended).toBe("r1.5");
    expect("error" in adviseSlTp({ candles: series([1, 2, 3]), side: "long", entry: 2, spreadBps: 1, holdBars: 5 })).toBe(true);
  });
});
