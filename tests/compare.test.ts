import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCompareCache, CompareUnavailable, compareModels } from "@/lib/forecast/compare";
import { __resetForecastCache, runForecast } from "@/lib/forecast";

const req = (lastTime = 1000) => ({
  epic: "GOLD",
  resolution: "MINUTE_5",
  resolutionMinutes: 5,
  horizon: 30,
  candles: Array.from({ length: 120 }, (_, i) => ({ time: lastTime - (119 - i) * 300, open: 1, high: 1, low: 1, close: 1 })),
});
const variant = { name: "Prix seul (version 1)", features: ["prix"], hitRate: 0.52, samples: 400, margin: 0.05, avgNetBps: -1.2, coverage: 0.7, live: false };
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  process.env.FORECAST_SERVICE_URL = "http://ml.test/api/forecast";
  __resetCompareCache();
  __resetForecastCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.FORECAST_SERVICE_URL;
});

describe("model comparison", () => {
  it("asks the service in compare mode with the spread, and caches the answer", async () => {
    const fetchMock = vi.fn(async () => json({ variants: [variant] }));
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([compareModels(req()), compareModels(req())]);
    expect(a).toEqual([variant]);
    expect(b).toEqual([variant]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ mode: "compare", epic: "GOLD", horizon: 30 });
    expect(body.spreadBps).toBeGreaterThan(0);
    await compareModels(req(1300)); // new candle
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid answer and retries soon, not at every click", async () => {
    const fetchMock = vi.fn(async () => json({ variants: [{ name: 1 }] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(compareModels(req())).rejects.toThrow(/invalid comparison/);
    await expect(compareModels(req())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-01-01T00:00:40Z")); // failures are kept 30 s
    await expect(compareModels(req())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is unavailable without an external model", async () => {
    delete process.env.FORECAST_SERVICE_URL;
    await expect(compareModels(req())).rejects.toBeInstanceOf(CompareUnavailable);
  });
});

describe("external forecast request", () => {
  it("carries the spread so that the model can price its calls", async () => {
    const fetchMock = vi.fn(async () =>
      json({ points: [{ time: 1, value: 2, low: 1, high: 3 }], direction: "up", confidence: 0.6, backtestHitRate: 0.55, source: "ML v2, test", features: ["prix"] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await runForecast(req());
    expect(r.features).toEqual(["prix"]);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.spreadBps).toBeGreaterThan(0);
    expect(body.mode).toBeUndefined();
  });
});
