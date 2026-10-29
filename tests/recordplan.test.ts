import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCandles = vi.fn();
const runForecast = vi.fn();
const recordSafe = vi.fn();
const computeCell = vi.fn();
vi.mock("@/lib/capital", async (orig) => ({ ...(await orig<typeof import("@/lib/capital")>()), getCandles: (...a: unknown[]) => getCandles(...a) }));
vi.mock("@/lib/forecast", () => ({ runForecast: (...a: unknown[]) => runForecast(...a) }));
vi.mock("@/lib/journal/service", () => ({ recordSafe: (...a: unknown[]) => recordSafe(...a) }));
vi.mock("@/lib/outlook", async (orig) => ({ ...(await orig<typeof import("@/lib/outlook")>()), computeCell: (...a: unknown[]) => computeCell(...a) }));

import { GET } from "@/app/api/journal/record/route";
import { INSTRUMENTS } from "@/config/instruments";

const call = (qs: string, auth = "Bearer s3cret") => GET(new Request(`https://dash.example.app/api/journal/record?${qs}`, { headers: auth ? { Authorization: auth } : {} }));

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("JOURNAL_STORAGE", "memory");
  vi.stubEnv("STORAGE_BACKEND", "");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "");
  getCandles.mockReset().mockResolvedValue([{ time: 1, open: 1, high: 1, low: 1, close: 1 }]);
  runForecast.mockReset().mockResolvedValue({ direction: "up" });
  recordSafe.mockReset().mockResolvedValue(undefined);
  computeCell.mockReset().mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe("journal record route", () => {
  it("lists the single calls of a run, for the background function", async () => {
    const intraday = await (await call("plan=intraday")).json();
    expect(intraday.calls).toEqual(INSTRUMENTS.map((i) => `scope=intraday&epic=${i.epic}`));
    const daily = await (await call("plan=daily")).json();
    expect(daily.calls).toHaveLength(INSTRUMENTS.length * 2);
    expect(daily.calls[0]).toBe(`scope=daily&epic=${INSTRUMENTS[0].epic}&key=day`);
  });

  it("records one intraday forecast, and nothing else", async () => {
    const res = await call("scope=intraday&epic=GOLD");
    expect(res.status).toBe(200);
    expect(runForecast).toHaveBeenCalledTimes(1);
    expect(runForecast.mock.calls[0][0]).toMatchObject({ epic: "GOLD", resolution: "MINUTE_5" });
    expect(recordSafe).toHaveBeenCalledTimes(1);
    expect(computeCell).not.toHaveBeenCalled();
  });

  it("records one daily or weekly outlook through its own model run", async () => {
    expect((await call("scope=daily&epic=BTCUSD&key=week")).status).toBe(200);
    expect(computeCell).toHaveBeenCalledTimes(1);
    expect(runForecast).not.toHaveBeenCalled();
  });

  it("refuses unknown instruments and horizons, and callers without the secret", async () => {
    expect((await call("scope=intraday&epic=NOPE")).status).toBe(400);
    expect((await call("scope=daily&epic=GOLD&key=year")).status).toBe(400);
    expect((await call("plan=intraday", "Bearer wrong")).status).toBe(401);
    expect((await call("plan=intraday", "")).status).toBe(401);
    expect(runForecast).not.toHaveBeenCalled();
  });
});
