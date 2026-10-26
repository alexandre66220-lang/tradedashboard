import { describe, expect, it, vi } from "vitest";
import { mergeSent, parseNewAlert, priceHit, runChecks, tradeHit, type CheckDeps, type PriceAlert } from "@/lib/alerts";
import { parseFeed } from "@/lib/calendar";
import type { Trade } from "@/lib/trades";
import type { Candle } from "@/lib/types";

const NOW = 1_800_000_000_000;
const sec = NOW / 1000;
const c = (offsetMin: number, low: number, high: number): Candle => ({ time: sec + offsetMin * 60, open: low, high, low, close: high });
const instruments = [
  { epic: "GOLD", name: "Or", newsCurrencies: ["USD"] },
  { epic: "BTCUSD", name: "Bitcoin", newsCurrencies: ["USD"] },
];
const ev = (title: string, min: number, impact = "High") => ({ title, country: "USD", date: new Date(NOW + min * 60000).toISOString().replace(/\.\d+Z$/, "+00:00"), impact, forecast: "0.3%", previous: "0.2%" });

function deps(over: Partial<CheckDeps> = {}): CheckDeps & { notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn(async () => true);
  return { now: NOW, instruments, alerts: [], trades: [], sent: [], events: [], candles: async () => [], ...over, notify } as never;
}

describe("parseNewAlert", () => {
  it("validates", () => {
    expect(parseNewAlert({ epic: "GOLD", op: "above", price: 2700, note: " x " }, ["GOLD"], NOW)).toMatchObject({ ok: true, value: { note: "x", createdAt: NOW } });
    for (const bad of [{ epic: "NOPE" }, { op: "up" }, { price: -1 }, { price: "5" }, { note: "x".repeat(201) }]) {
      expect(parseNewAlert({ epic: "GOLD", op: "above", price: 1, ...bad }, ["GOLD"], NOW).ok).toBe(false);
    }
  });
});

describe("hit detection", () => {
  it("catches a spike between two checks, but ignores candles from before the alert existed", () => {
    const candles = [c(-10, 2690, 2705), c(-3, 2690, 2699), c(-2, 2695, 2701), c(-1, 2695, 2698)];
    expect(priceHit(candles, "above", 2700, sec - 5 * 60)).toEqual({ hit: true, at: sec - 2 * 60 });
    expect(priceHit(candles, "above", 2700, sec - 60).hit).toBe(false); // the 2705 spike was before creation
    expect(priceHit(candles, "below", 2691, sec - 15 * 60)).toMatchObject({ hit: true });
    expect(priceHit([], "above", 1, 0).hit).toBe(false);
  });

  it("finds the first of stop / target, with the stop winning ties", () => {
    const t: Trade = { id: "t", epic: "GOLD", side: "long", openedAt: NOW - 600_000, entry: 2000, size: 1, stop: 1990, target: 2020 };
    expect(tradeHit([c(-5, 1995, 2005), c(-4, 2000, 2021)], t)).toMatchObject({ kind: "target" });
    expect(tradeHit([c(-5, 1995, 2005), c(-4, 1989, 2000)], t)).toMatchObject({ kind: "stop" });
    expect(tradeHit([c(-5, 1985, 2025)], t).kind).toBe("stop"); // both in one candle: stop first
    expect(tradeHit([c(-5, 1995, 2005)], t).kind).toBeNull();
    const short: Trade = { ...t, side: "short", stop: 2010, target: 1980 };
    expect(tradeHit([c(-5, 1979, 2000)], short).kind).toBe("target");
    expect(tradeHit([c(-30, 1900, 2100)], t).kind).toBeNull(); // before the trade was opened
  });
});

describe("runChecks", () => {
  const alert = (o: Partial<PriceAlert> = {}): PriceAlert => ({ id: "a1", epic: "GOLD", op: "above", price: 2700, createdAt: NOW - 600_000, ...o });

  it("announces a major release once, listing the instruments it concerns", async () => {
    const events = parseFeed([ev("Non-Farm Employment Change", 25), ev("ISM PMI", 20, "Medium"), ev("Core CPI", 300), ev("Old", -10)]);
    const d = deps({ events });
    const r = await runChecks(d);
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0][0]).toMatchObject({ title: "Annonce majeure dans 25 min", priority: 4 });
    expect(d.notify.mock.calls[0][0].message).toContain("Or, Bitcoin");
    expect(r.newSent).toHaveLength(1);
    // already sent: nothing more
    const d2 = deps({ events, sent: r.newSent });
    await runChecks(d2);
    expect(d2.notify).not.toHaveBeenCalled();
  });

  it("fires a price alert once and reports it", async () => {
    const d = deps({ alerts: [alert(), alert({ id: "a2", price: 3000 }), alert({ id: "a3", firedAt: 1 })], candles: async () => [c(-2, 2690, 2701)] });
    const r = await runChecks(d);
    expect(r.firedAlerts).toEqual(["a1"]);
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0][0].title).toContain("Or");
  });

  it("warns when the stop of an open trade is hit (urgent) and only once", async () => {
    const trade: Trade = { id: "t1", epic: "GOLD", side: "long", openedAt: NOW - 600_000, entry: 2000, size: 1, stop: 1990 };
    const d = deps({ trades: [trade, { ...trade, id: "closed", exit: 1995, closedAt: NOW }], candles: async () => [c(-3, 1985, 2000)] });
    const r = await runChecks(d);
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0][0]).toMatchObject({ priority: 5 });
    const again = deps({ trades: [trade], sent: r.newSent, candles: async () => [c(-3, 1985, 2000)] });
    await runChecks(again);
    expect(again.notify).not.toHaveBeenCalled();
  });

  it("retries later when delivery fails, and survives broken data sources", async () => {
    const d = deps({ events: parseFeed([ev("NFP", 20)]), alerts: [alert()], candles: async () => [c(-2, 2690, 2701)] });
    d.notify.mockResolvedValue(false);
    const r = await runChecks(d);
    expect(r).toMatchObject({ sent: 0, failed: 2, firedAlerts: [], newSent: [] });
    const broken = deps({ alerts: [alert()], events: null, candles: async () => { throw new Error("down"); } });
    expect(await runChecks(broken)).toMatchObject({ sent: 0, failed: 1 });
    const throwing = deps({ alerts: [alert()], candles: async () => [c(-2, 2690, 2701)] });
    throwing.notify.mockRejectedValue(new Error("network"));
    expect((await runChecks(throwing)).failed).toBe(1);
  });

  it("fetches each instrument's candles only once", async () => {
    const candles = vi.fn(async () => [c(-2, 2690, 2701)]);
    await runChecks(deps({ alerts: [alert(), alert({ id: "b" })], trades: [{ id: "t", epic: "GOLD", side: "long", openedAt: NOW, entry: 1, size: 1, stop: 0.5 }], candles }));
    expect(candles).toHaveBeenCalledTimes(1);
  });
});

describe("mergeSent", () => {
  it("de-duplicates and forgets records older than two weeks", () => {
    const out = mergeSent([{ key: "a", at: NOW - 20 * 24 * 3600_000 }, { key: "b", at: NOW }], [{ key: "b", at: NOW }, { key: "c", at: NOW }], NOW);
    expect(out.map((s) => s.key)).toEqual(["b", "c"]);
  });
});
