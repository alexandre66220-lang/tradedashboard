import { describe, expect, it } from "vitest";
import { backtest, builtinForecast, directionOf, fitModel } from "@/lib/forecast/builtin";
import type { Candle } from "@/lib/types";

function makeCandles(closes: number[], step = 300): Candle[] {
  return closes.map((c, i) => ({ time: 1_700_000_000 + i * step, open: c, high: c + 0.5, low: c - 0.5, close: c }));
}

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
}

describe("built-in forecast", () => {
  it("detects an upward trend and extends into the future", () => {
    const r = rng(1);
    const closes = Array.from({ length: 200 }, (_, i) => 2000 + i * 0.8 + r());
    const f = builtinForecast({ epic: "GOLD", resolution: "MINUTE_5", resolutionMinutes: 5, horizon: 30, candles: makeCandles(closes) });
    expect(f.direction).toBe("up");
    expect(f.points).toHaveLength(6);
    expect(f.points[0].time).toBe(1_700_000_000 + 200 * 300);
    expect(f.points.every((p) => p.low < p.value && p.value < p.high)).toBe(true);
    expect(f.confidence).toBeGreaterThan(0.5);
    expect(f.backtestHitRate).toBeGreaterThan(0.9);
  });

  it("detects a downward trend", () => {
    const closes = Array.from({ length: 100 }, (_, i) => 2000 - i * 0.5 + Math.sin(i));
    const m = fitModel(closes.slice(-48))!;
    expect(directionOf(m, 6).direction).toBe("down");
  });

  it("does not invent skill on a random walk", () => {
    const r = rng(7);
    let p = 2000;
    const closes = Array.from({ length: 3000 }, () => (p += r() * 2));
    const bt = backtest(makeCandles(closes), 6);
    expect(bt.samples).toBeGreaterThan(500);
    expect(bt.hitRate!).toBeGreaterThan(0.4);
    expect(bt.hitRate!).toBeLessThan(0.6);
  });

  it("returns an empty, neutral forecast with too little data", () => {
    const f = builtinForecast({ epic: "GOLD", resolution: "MINUTE", resolutionMinutes: 1, horizon: 30, candles: makeCandles([1, 2, 3]) });
    expect(f.points).toEqual([]);
    expect(f.backtestHitRate).toBeNull();
  });

  it("uses at least one step when horizon < resolution", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const f = builtinForecast({ epic: "GOLD", resolution: "MINUTE_15", resolutionMinutes: 15, horizon: 5, candles: makeCandles(closes, 900) });
    expect(f.points).toHaveLength(1);
  });
});

describe("robustness", () => {
  it("refuses to fit on non-positive prices instead of returning NaN", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 20 - i * 0.5);
    expect(fitModel(closes)).toBeNull();
    const f = builtinForecast({ epic: "OIL_CRUDE", resolution: "DAY", resolutionMinutes: 1440, horizon: 1440, candles: makeCandles(closes, 86400) });
    expect(f.points).toEqual([]);
    expect(backtest(makeCandles(closes, 86400), 1).samples).toBeLessThan(20);
  });
});
