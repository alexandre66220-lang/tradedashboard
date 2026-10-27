import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runForecast = vi.fn();
const recordSafe = vi.fn(async () => {});
vi.mock("@/lib/forecast", () => ({ runForecast: (...a: unknown[]) => runForecast(...a) }));
vi.mock("@/lib/journal/service", () => ({ recordSafe: (...a: unknown[]) => recordSafe(...(a as [])) }));
vi.mock("@/lib/capital", async () => {
  const actual = await vi.importActual<typeof import("@/lib/capital")>("@/lib/capital");
  return {
    ...actual,
    getCandles: vi.fn(async () => [
      { time: 1, open: 100, high: 101, low: 99, close: 100 },
      { time: 2, open: 100, high: 101, low: 99, close: 101 },
    ]),
  };
});

import { INSTRUMENTS, OUTLOOKS } from "@/config/instruments";
import { __resetMemoryStorage } from "@/lib/journal/storage";
import { __resetOutlook, buildOutlook } from "@/lib/outlook";
import { OUTLOOK_PENDING } from "@/lib/types";

const forecast = () => ({
  points: [{ time: 3, value: 102, low: 100, high: 104 }],
  direction: "up",
  confidence: 0.6,
  backtestHitRate: 0.52,
  backtestSamples: 300,
  source: "ML v2, test",
});

beforeEach(() => {
  vi.stubEnv("JOURNAL_STORAGE", "memory");
  vi.stubEnv("STORAGE_BACKEND", "");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "");
  runForecast.mockReset();
  recordSafe.mockClear();
  __resetOutlook();
  __resetMemoryStorage();
});
afterEach(() => vi.unstubAllEnvs());

const cells = INSTRUMENTS.length * OUTLOOKS.length;

describe("outlook", () => {
  it("computes every forecast once, then serves them from the store for half an hour", async () => {
    runForecast.mockImplementation(async () => forecast());
    const first = await buildOutlook(5_000);
    expect(first.pending).toBeUndefined();
    expect(first.source).toBe("ML v2, test");
    expect(first.items.every((i) => i.last === 101)).toBe(true);
    expect(runForecast).toHaveBeenCalledTimes(cells);
    expect(recordSafe).toHaveBeenCalledTimes(cells);

    const second = await buildOutlook(5_000);
    expect(runForecast).toHaveBeenCalledTimes(cells); // nothing recomputed
    expect(second.items[0].horizons.day).toMatchObject({ direction: "up", target: 102 });
  });

  it("does not wait for a slow model: it answers 'pending', and finds the result on the next request", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    runForecast.mockImplementation(async () => {
      await gate;
      return forecast();
    });
    const t0 = Date.now();
    const early = await buildOutlook(30);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(early.pending).toBe(true);
    expect(Object.values(early.items[0].horizons)).toEqual(expect.arrayContaining([{ error: OUTLOOK_PENDING }]));

    release();
    await new Promise((r) => setTimeout(r, 50)); // the computations finish in the background and are stored
    const later = await buildOutlook(1_000);
    expect(later.pending).toBeUndefined();
    expect(runForecast).toHaveBeenCalledTimes(cells);
  });

  it("reports a failing forecast for its cell only", async () => {
    let n = 0;
    runForecast.mockImplementation(async () => {
      if (n++ === 0) throw new Error("boom");
      return forecast();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await buildOutlook(5_000);
    const errors = r.items.flatMap((i) => Object.values(i.horizons)).filter((h) => "error" in h);
    expect(errors).toHaveLength(1);
    warn.mockRestore();
  });
});
