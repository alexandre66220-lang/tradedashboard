import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetForecastCache, runForecast } from "@/lib/forecast";
import { backtest, builtinForecast, directionOf, fitModel, hitStat } from "@/lib/forecast/builtin";
import { verdict } from "@/lib/verdict";
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

describe("backtest statistics", () => {
  it("reports a wider margin when horizons overlap", () => {
    expect(hitStat(55, 100, 1).margin!).toBeCloseTo(0.098, 2);
    expect(hitStat(55, 100, 6).margin!).toBeGreaterThan(hitStat(55, 100, 1).margin!);
    expect(hitStat(5, 10).hitRate).toBeNull();
  });

  it("scores baselines and confidence buckets on the same cases", () => {
    const r = rng(3);
    const closes = Array.from({ length: 400 }, (_, i) => 1000 + i * 0.5 + r() * 3);
    const bt = backtest(makeCandles(closes), 3);
    expect(bt.baselines.alwaysUp.samples).toBe(bt.samples);
    expect(bt.baselines.alwaysUp.hitRate!).toBeGreaterThan(0.8);
    const counts = bt.byConfidence.map((c) => c.samples);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(counts[0]).toBeLessThanOrEqual(bt.samples);
  });

  it("gives an honest verdict", () => {
    const base = { baselines: { alwaysUp: { hitRate: 0.5, samples: 500, margin: 0.04 }, lastMove: { hitRate: 0.5, samples: 500, margin: 0.04 } } };
    expect(verdict({ hitRate: 0.52, samples: 500, margin: 0.09, ...base }).level).toBe("none");
    expect(verdict({ hitRate: 0.62, samples: 500, margin: 0.04, ...base }).level).toBe("edge");
    expect(verdict({ hitRate: 0.4, samples: 500, margin: 0.04, ...base }).level).toBe("worse");
    expect(verdict({ hitRate: 0.62, samples: 500, margin: 0.04, baselines: { ...base.baselines, alwaysUp: { hitRate: 0.7, samples: 500, margin: 0.04 } } }).level).toBe("naive");
    expect(verdict({ hitRate: null, samples: 3, margin: null }).level).toBe("unknown");
  });
});

describe("external provider cache", () => {
  const req = (lastTime: number) => ({
    epic: "GOLD",
    resolution: "MINUTE_5",
    resolutionMinutes: 5,
    horizon: 30,
    candles: makeCandles(Array.from({ length: 120 }, (_, i) => 2000 + Math.sin(i / 7) * 5 + i * 0.1)).map((c, i, a) =>
      i === a.length - 1 ? { ...c, time: lastTime } : c,
    ),
  });
  const ok = {
    points: [{ time: 1, value: 2, low: 1, high: 3 }],
    direction: "up",
    confidence: 0.6,
    backtestHitRate: 0.55,
    source: "ml-test",
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    process.env.FORECAST_SERVICE_URL = "http://ml.test/api/forecast";
    __resetForecastCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.FORECAST_SERVICE_URL;
  });

  it("calls the service once per latest candle, not on every poll", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ok }));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([runForecast(req(1000)), runForecast(req(1000))]);
    await runForecast(req(1000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await runForecast(req(1300)); // a new candle
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z")); // past the 60 s TTL
    await runForecast(req(1300));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("falls back to the built-in model, and does not hammer a failing service", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runForecast(req(1000));
    expect(r.source).toContain("service externe indisponible");
    expect(r.points.length).toBeGreaterThan(0);
    await runForecast(req(1000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-01-01T00:00:40Z")); // failure cache is 30 s
    await runForecast(req(1000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the bearer token and rejects an invalid payload", async () => {
    process.env.FORECAST_SERVICE_TOKEN = "tok";
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runForecast(req(1000));
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: "Bearer tok" });
    expect(r.source).toContain("indisponible");
    delete process.env.FORECAST_SERVICE_TOKEN;
  });
});
