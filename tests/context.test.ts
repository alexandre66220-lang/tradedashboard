import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFunding, parseLongShort, parseOiChange, getBtcDerivs, __resetOkx } from "@/lib/context/okx";
import { parseCot, getCot, __resetCftc, COT_CONTRACTS, RELEASE_DELAY_MS } from "@/lib/context/cftc";
import { cotRelation, fundingRelation } from "@/lib/context/types";
import { getContext, readingsForJournal } from "@/lib/context";
import { computeStats, recordForecast, seriesKey } from "@/lib/journal/journal";
import { memoryStorage } from "@/lib/journal/storage";
import { INSTRUMENTS } from "@/config/instruments";
import type { JournalEntry } from "@/lib/journal/types";

const ok = (data: unknown[]) => ({ code: "0", msg: "", data });

describe("OKX parsers", () => {
  it("reads the funding rate and refuses an absurd one", () => {
    expect(parseFunding(ok([{ fundingRate: "0.0001", fundingTime: "1" }]))).toBe(0.0001);
    expect(parseFunding(ok([{ fundingRate: "-0.00031" }]))).toBe(-0.00031);
    expect(parseFunding(ok([{ fundingRate: "0.5" }]))).toBeNull();
    expect(parseFunding(ok([{ fundingRate: "abc" }]))).toBeNull();
    expect(parseFunding({ code: "50011", data: [] })).toBeNull();
    expect(parseFunding(null)).toBeNull();
  });
  it("turns the long/short account ratio into a % of accounts long", () => {
    expect(parseLongShort(ok([["1", "1.5"], ["0", "9"]]))).toBe(60);
    expect(parseLongShort(ok([["1", "0"]]))).toBeNull();
    expect(parseLongShort(ok([]))).toBeNull();
  });
  it("computes the open interest change over an hour from 5-minute points", () => {
    const pts = Array.from({ length: 13 }, (_, i) => [String(1000 - i), "0", "0", String(i === 0 ? 1010 : i === 12 ? 1000 : 1005)]);
    expect(parseOiChange(ok(pts))).toBe(1);
    expect(parseOiChange(ok(pts.slice(0, 5)))).toBeNull(); // not an hour of data
    expect(parseOiChange(ok([...pts.slice(0, 12), ["1", "0", "0", "0"]]))).toBeNull();
  });
});

describe("OKX source", () => {
  beforeEach(() => __resetOkx());
  afterEach(() => vi.unstubAllGlobals());

  it("returns the funding even when the other readings fail, and caches", async () => {
    const f = vi.fn(async (url: string) => {
      if (String(url).includes("funding-rate")) return new Response(JSON.stringify(ok([{ fundingRate: "0.0003" }])));
      return new Response("nope", { status: 500 });
    });
    vi.stubGlobal("fetch", f);
    const r = await getBtcDerivs();
    expect(r).toMatchObject({ funding: 0.0003, longPct: null, oi1hPct: null });
    await getBtcDerivs();
    expect(f).toHaveBeenCalledTimes(3); // one round, not two
  });

  it("gives null, without throwing, when the funding is unavailable, and does not hammer the source", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async (..._a: unknown[]) => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", f);
    expect(await getBtcDerivs()).toBeNull();
    expect(await getBtcDerivs()).toBeNull();
    expect(f).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("CFTC", () => {
  const T = Date.UTC(2026, 9, 28);
  const week = (i: number, long: number, short: number, oi = 1000) => {
    const d = new Date(T - (i + 1) * 7 * 86400_000);
    return { report_date_as_yyyy_mm_dd: d.toISOString().slice(0, 10) + "T00:00:00.000", open_interest_all: String(oi), noncomm_positions_long_all: String(long), noncomm_positions_short_all: String(short) };
  };
  const rowsOf = (n: number, net: (i: number) => number) => Array.from({ length: n }, (_, i) => week(i, 500 + net(i), 500));

  it("computes the net position and where it ranks among the last weeks", () => {
    // latest (i = 0) is the highest of 100 weeks
    const r = parseCot(rowsOf(100, (i) => 200 - i), "Or", T)!;
    expect(r).toMatchObject({ label: "Or", netPct: 20, percentile: 100, weeks: 100 });
    expect(r.weekChange).toBe(0.1);
    const low = parseCot(rowsOf(100, (i) => i), "Or", T)!;
    expect(low.percentile).toBe(0);
  });

  it("needs a year of weeks, skips rows that do not look right and reports not yet released", () => {
    expect(parseCot(rowsOf(30, () => 10), "x", T)).toBeNull();
    const bad = [...rowsOf(60, () => 10), { report_date_as_yyyy_mm_dd: "x" }, { open_interest_all: "0" }, null];
    expect(parseCot(bad, "x", T)?.weeks).toBe(60);
    // a report dated after the last release was out is ignored, never used early
    const justDated = { ...week(0, 900, 100), report_date_as_yyyy_mm_dd: new Date(T - 86400_000).toISOString().slice(0, 10) + "T00:00:00.000" };
    expect(parseCot([justDated, ...rowsOf(60, () => 10).slice(1)], "x", T)?.weeks).toBe(59);
    expect(RELEASE_DELAY_MS).toBeGreaterThan(3 * 86400_000);
    expect(parseCot({ not: "a list" }, "x", T)).toBeNull();
  });

  it("covers the six instruments with distinct contract codes", () => {
    expect(Object.keys(COT_CONTRACTS).sort()).toEqual(INSTRUMENTS.map((i) => i.epic).sort());
    expect(new Set(Object.values(COT_CONTRACTS).map((c) => c.code)).size).toBe(6);
  });

  describe("source", () => {
    beforeEach(() => __resetCftc());
    afterEach(() => vi.unstubAllGlobals());
    it("asks for the right contract, caches, and falls back to null on a bad answer", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = vi.fn(async (..._a: unknown[]) => new Response("[]", { status: 200 }));
      vi.stubGlobal("fetch", f);
      // dates in the fixture are relative to a fixed day in the past of "now": use real time instead
      const now = Date.now();
      const fresh = Array.from({ length: 80 }, (_, i) => {
        const d = new Date(now - (i + 2) * 7 * 86400_000);
        return { report_date_as_yyyy_mm_dd: d.toISOString().slice(0, 10) + "T00:00:00.000", open_interest_all: "1000", noncomm_positions_long_all: String(600 - i), noncomm_positions_short_all: "500" };
      });
      f.mockImplementation(async () => new Response(JSON.stringify(fresh), { status: 200 }));
      const r = await getCot("GOLD");
      expect(r).toMatchObject({ label: "Or (COMEX)", percentile: 100 });
      expect(String(f.mock.calls[0][0])).toContain("cftc_contract_market_code=088691");
      await getCot("GOLD");
      expect(f).toHaveBeenCalledTimes(1);
      f.mockImplementation(async () => new Response("[]", { status: 200 }));
      expect(await getCot("OIL_CRUDE")).toBeNull();
      expect(await getCot("NOPE")).toBeNull();
      warn.mockRestore();
    });
  });
});

describe("relations", () => {
  it("tells with / against the funding crowd", () => {
    expect(fundingRelation("up", 0.0003)).toBe("with");
    expect(fundingRelation("down", 0.0003)).toBe("against");
    expect(fundingRelation("down", -0.0002)).toBe("with");
    expect(fundingRelation("up", 0.0001)).toBe("neutral");
    expect(fundingRelation("flat", 0.0005)).toBe("neutral");
  });
  it("tells with / against the big speculators only at an extreme", () => {
    expect(cotRelation("up", 90)).toBe("with");
    expect(cotRelation("down", 90)).toBe("against");
    expect(cotRelation("down", 10)).toBe("with");
    expect(cotRelation("up", 50)).toBe("neutral");
  });
});

describe("context for the API and the journal", () => {
  beforeEach(() => {
    __resetOkx();
    __resetCftc();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("only asks the sources that concern the instrument, and says which did not answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async (..._a: unknown[]) => new Response("down", { status: 500 }));
    vi.stubGlobal("fetch", f);
    expect(await getContext("BTCUSD")).toMatchObject({ derivs: null, cot: null, sources: { derivs: "down", cot: "down" } });
    __resetOkx();
    __resetCftc();
    f.mockClear();
    expect(await getContext("EURUSD")).toMatchObject({ sources: { derivs: "none", cot: "down" } });
    expect(f.mock.calls.every((c) => String(c[0]).includes("cftc"))).toBe(true);
  });

  it("gives the journal nothing, quickly, when the sources are down", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    expect(await readingsForJournal("BTCUSD", true)).toEqual({});
  });
});

describe("journal measures the positioning data", () => {
  const T = 1_700_000_000;
  const entry = (i: number, direction: "up" | "down", up: boolean, extra: Partial<JournalEntry>): JournalEntry => ({
    id: `e${i}`, epic: "BTCUSD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30, steps: 6, t: T + i * 3600, recordedAt: (T + i * 3600) * 1000,
    price: 100, direction, confidence: 0.6, target: 101, source: "ML v2", ref: 100, prev: 99.5, outcome: up ? 101 : 99, ...extra,
  });

  it("splits hit rates by relation to the funding crowd and to the big speculators", () => {
    const entries: JournalEntry[] = [];
    // 20 forecasts with the funding crowd (funding high, forecast up): all right; 20 against it: all wrong
    for (let i = 0; i < 20; i++) entries.push(entry(i, "up", true, { deriv: { funding: 0.0004 }, cot: 90 }));
    for (let i = 20; i < 40; i++) entries.push(entry(i, "down", true, { deriv: { funding: 0.0004 }, cot: 90 }));
    entries.push(entry(40, "up", true, { deriv: { funding: 0.0001 }, cot: 50 }));
    entries.push(entry(41, "up", true, {}));
    const st = computeStats(entries, () => 1, () => 1);
    expect(st.byFunding.with).toMatchObject({ hits: 20, samples: 20, hitRate: 1 });
    expect(st.byFunding.against).toMatchObject({ hits: 0, samples: 20, hitRate: 0 });
    expect(st.byFunding.neutral.samples).toBe(1);
    expect(st.byCot.with.samples).toBe(20);
    expect(st.byCot.against.samples).toBe(20);
    expect(st.byCot.neutral.samples).toBe(1);
  });

  it("records the readings with the forecast, and leaves them out when absent", async () => {
    const storage = memoryStorage();
    const candles = Array.from({ length: 5 }, (_, i) => ({ time: T + i * 300, open: 1, high: 1, low: 1, close: 1 }));
    const fc = { direction: "up" as const, confidence: 0.6, points: [{ time: T + 3000, value: 1.1, low: 1, high: 1.2 }], source: "ML v2" };
    const series = { epic: "BTCUSD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30 };
    await recordForecast(storage, series, candles, fc, 1_000_000, null, undefined, { deriv: { funding: 0.0002, longPct: 61 }, cot: 77 });
    const [e] = (await storage.read<JournalEntry>(seriesKey(series))).entries;
    expect(e).toMatchObject({ deriv: { funding: 0.0002, longPct: 61 }, cot: 77 });
    const s2 = memoryStorage();
    const series2 = { ...series, horizon: 60 }; // another window: the first one was already seen
    await recordForecast(s2, series2, candles, fc, 1_000_000, null, undefined, { deriv: { funding: Number.NaN }, cot: Number.NaN });
    const [e2] = (await s2.read<JournalEntry>(seriesKey(series2))).entries;
    expect(e2.deriv).toBeUndefined();
    expect(e2.cot).toBeUndefined();
  });
});
