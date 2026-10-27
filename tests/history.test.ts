import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCapitalState, __setRateLimitWait, getCandles, getHistory, toCandles } from "@/lib/capital";
import { enrichRequest } from "@/lib/forecast/enrich";
import { INSTRUMENTS } from "@/config/instruments";

const STEP = 300;
const END = 1_700_000_100 - (1_700_000_100 % STEP);
const TOTAL = 3200;

const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 19);
const price = (v: number) => ({ bid: v, ask: v + 0.2 });

/** A fake Capital.com: TOTAL five-minute candles ending at END, served like the real prices endpoint (max / from / to). */
function fakeCapital(opts: { ignoreRange?: boolean; failOlder?: boolean; maxRangeSteps?: number; throttle?: { login?: number; prices?: number } } = {}) {
  const calls: string[] = [];
  let loginThrottle = opts.throttle?.login ?? 0;
  let pricesThrottle = opts.throttle?.prices ?? 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      if (loginThrottle-- > 0) return new Response(JSON.stringify({ errorCode: "error.too-many.requests" }), { status: 429 });
      return new Response("{}", { status: 200, headers: { CST: "c", "X-SECURITY-TOKEN": "t" } });
    }
    if (pricesThrottle-- > 0) return new Response(JSON.stringify({ errorCode: "error.too-many.requests" }), { status: 429 });
    calls.push(url.search);
    const hasMax = url.searchParams.has("max");
    const max = Number(url.searchParams.get("max") ?? 10);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    // Like the real API: a date range cannot be combined with max, and wide ranges can be refused
    const bad = (code: string) => new Response(JSON.stringify({ errorCode: code }), { status: 400 });
    if (from && to && hasMax) return bad("error.invalid.max.daterange");
    if (to && opts.failOlder) return new Response("{}", { status: 500 });
    let times = Array.from({ length: TOTAL }, (_, i) => END - (TOTAL - 1 - i) * STEP);
    if (from && to && !opts.ignoreRange) {
      const lo = Date.parse(`${from}Z`) / 1000;
      const hi = Date.parse(`${to}Z`) / 1000;
      if (opts.maxRangeSteps && (hi - lo) / STEP > opts.maxRangeSteps) return bad("error.invalid.max.daterange");
      times = times.filter((t) => t >= lo && t <= hi).slice(0, 1000);
    } else if (from && to) {
      times = times.slice(-10); // an API that ignores the range answers with its default of 10 candles
    } else {
      times = times.slice(-max);
    }
    const prices = times.map((t) => ({
      snapshotTimeUTC: iso(t),
      openPrice: price(100),
      closePrice: price(101),
      highPrice: price(102),
      lowPrice: price(99),
      lastTradedVolume: 7,
    }));
    return new Response(JSON.stringify({ prices }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

beforeEach(() => {
  vi.stubEnv("CAPITAL_API_KEY", "k");
  vi.stubEnv("CAPITAL_IDENTIFIER", "i");
  vi.stubEnv("CAPITAL_API_PASSWORD", "p");
  vi.stubEnv("CAPITAL_BASE_URL", "http://capital.test");
  __resetCapitalState();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("toCandles volume", () => {
  it("keeps a usable volume and drops a bad one", () => {
    const base = { openPrice: price(1), closePrice: price(1), highPrice: price(1), lowPrice: price(1) };
    const [a, b, c] = toCandles([
      { ...base, snapshotTimeUTC: "2024-05-01T10:00:00", lastTradedVolume: 12 },
      { ...base, snapshotTimeUTC: "2024-05-01T10:05:00", lastTradedVolume: -3 },
      { ...base, snapshotTimeUTC: "2024-05-01T10:10:00" },
    ]);
    expect(a.volume).toBe(12);
    expect(b.volume).toBeUndefined();
    expect(c.volume).toBeUndefined();
  });
});

describe("getHistory", () => {
  it("pages back past the 1000-candle limit into one contiguous, ordered history", async () => {
    const { calls } = fakeCapital();
    const h = await getHistory("GOLD", "MINUTE_5", 2500);
    expect(h).toHaveLength(2500);
    expect(h.at(-1)?.time).toBe(END);
    expect(h.every((c, i) => i === 0 || c.time - h[i - 1].time === STEP)).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  it("stops when the history runs out", async () => {
    fakeCapital();
    const h = await getHistory("GOLD", "MINUTE_5", 5000);
    expect(h).toHaveLength(TOTAL);
  });

  it("does not loop when the API ignores from / to", async () => {
    const { calls } = fakeCapital({ ignoreRange: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await getHistory("GOLD", "MINUTE_5", 4000);
    expect(h).toHaveLength(1000);
    expect(calls.length).toBeLessThanOrEqual(3);
    warn.mockRestore();
  });

  it("asks for a date range without max, which the real API refuses to combine", async () => {
    const { calls } = fakeCapital();
    await getHistory("GOLD", "MINUTE_5", 2500);
    const ranged = calls.filter((c) => c.includes("from="));
    expect(ranged.length).toBeGreaterThan(0);
    expect(ranged.every((c) => !c.includes("max="))).toBe(true);
  });

  it("narrows the date range when the API says it is too wide, and still builds the history", async () => {
    const { calls } = fakeCapital({ maxRangeSteps: 300 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await getHistory("GOLD", "MINUTE_5", 2500);
    expect(h.length).toBeGreaterThanOrEqual(2500);
    expect(h.every((c, i) => i === 0 || c.time - h[i - 1].time === STEP)).toBe(true);
    expect(calls.length).toBeLessThan(40);
    warn.mockRestore();
  });

  it("waits and retries when Capital.com answers 429, for the session and for prices", async () => {
    __setRateLimitWait(1);
    const { calls } = fakeCapital({ throttle: { login: 2, prices: 2 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getCandles("GOLD", "MINUTE_5", 100)).toHaveLength(100);
    expect(calls).toHaveLength(1);
    warn.mockRestore();
  });

  it("gives up cleanly when Capital.com keeps refusing", async () => {
    __setRateLimitWait(1);
    fakeCapital({ throttle: { login: 10 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(getCandles("GOLD", "MINUTE_5", 100)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    warn.mockRestore();
  });

  it("falls back to the recent candles when older pages fail, and does not retry right away", async () => {
    const { calls } = fakeCapital({ failOlder: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getHistory("GOLD", "MINUTE_5", 3000)).toHaveLength(1000);
    const first = calls.length;
    expect(await getHistory("GOLD", "MINUTE_15", 3000)).toHaveLength(1000);
    expect(calls.length).toBe(first + 1); // only the recent candles, no new attempt at paging
    warn.mockRestore();
  });

  it("returns the plain recent candles for daily series", async () => {
    const { calls } = fakeCapital();
    expect(await getHistory("GOLD", "DAY", 1000)).toHaveLength(1000);
    expect(calls).toHaveLength(1);
  });
});

describe("enrichRequest", () => {
  const chart = Array.from({ length: 1000 }, (_, i) => ({ time: END - (999 - i) * STEP, open: 1, high: 1, low: 1, close: 1 }));

  it("adds the spread, a longer history and the other instruments", async () => {
    fakeCapital();
    const out = await enrichRequest({ epic: "GOLD", resolution: "MINUTE_5", resolutionMinutes: 5, horizon: 30, candles: chart });
    expect(out.spreadBps).toBe(INSTRUMENTS.find((i) => i.epic === "GOLD")!.spreadBps);
    expect(out.candles.length).toBeGreaterThan(1000);
    expect(out.candles.at(-1)?.time).toBe(END);
    expect(out.candles.find((c) => c.time === END)?.close).toBe(1); // the chart's candle wins over the cached history
    expect(out.context?.map((c) => c.epic).sort()).toEqual(INSTRUMENTS.filter((i) => i.epic !== "GOLD").map((i) => i.epic).sort());
    expect(out.context?.every((c) => c.time.length === c.close.length && c.time.length > 1000)).toBe(true);
  });

  it("still returns the request, with the spread, when Capital.com is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await enrichRequest({ epic: "GOLD", resolution: "MINUTE_5", resolutionMinutes: 5, horizon: 30, candles: chart });
    expect(out.candles).toBe(chart);
    expect(out.spreadBps).toBeGreaterThan(0);
    expect(out.context).toBeUndefined();
    warn.mockRestore();
  });
});
