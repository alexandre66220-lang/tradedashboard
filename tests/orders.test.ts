import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const quote = vi.fn();
const positions = vi.fn();
const open = vi.fn();
const confirmation = vi.fn();
const close = vi.fn();
const amend = vi.fn();
const closeInfo = vi.fn();
const calendar = vi.fn();
vi.mock("@/lib/calendar-source", () => ({ getCalendar: () => calendar() }));

vi.mock("@/lib/capital", async (orig) => {
  const real = await orig<typeof import("@/lib/capital")>();
  return {
    ...real,
    getFreshQuote: (...a: unknown[]) => quote(...a),
    listPositions: (...a: unknown[]) => positions(...a),
    openPosition: (...a: unknown[]) => open(...a),
    getConfirmation: (...a: unknown[]) => confirmation(...a),
    closePositionDeal: (...a: unknown[]) => close(...a),
    amendPositionStop: (...a: unknown[]) => amend(...a),
    getCloseInfo: (...a: unknown[]) => closeInfo(...a),
  };
});

import { assertDemoOnly, parseCloseActivity, parsePositions, type OpenPosition } from "@/lib/capital";
import { relatedEpics, INSTRUMENTS } from "@/config/instruments";
import { readTrades, updateTrades } from "@/lib/trades-store";
import { __resetMemoryStorage } from "@/lib/journal/storage";
import { assessOrder, assessStopMove, LIMITS, moveStop, ordersState, parseModel, parseOrder, placeOrder, previewOrder, readRecap, syncDemoTrades, __resetOrders, __setConfirmWait, closeOrder, type Order } from "@/lib/orders";
import { crossOriginRefused, sameOrigin } from "@/lib/http";

const NOW = 1_800_000_000_000;
const Q = { status: "TRADEABLE", bid: 2650, offer: 2650.5 };
const buy: Order = { epic: "GOLD", side: "long", size: 1, stop: 2640, target: 2670 };
const sell: Order = { epic: "GOLD", side: "short", size: 1, stop: 2660, target: 2630 };

const pos = (o: Partial<OpenPosition> = {}): OpenPosition => ({
  dealId: "d1", epic: "GOLD", name: "Gold", direction: "BUY", size: 1, level: 2600, stopLevel: null, profitLevel: null, upl: 0, currency: "USD", createdAt: NOW - 3_600_000, bid: 2650, offer: 2650.5, ...o,
});

describe("parseOrder", () => {
  it("accepts a complete order and rounds the size", () => {
    const r = parseOrder({ epic: "GOLD", side: "long", size: 1.239, stop: 2640, target: 2670 });
    expect(r).toEqual({ ok: true, value: { epic: "GOLD", side: "long", size: 1.24, stop: 2640, target: 2670 } });
  });
  it("requires a stop, a known instrument, a side and a sane size", () => {
    expect(parseOrder({ epic: "GOLD", side: "long", size: 1 }).ok).toBe(false);
    expect(parseOrder({ epic: "NOPE", side: "long", size: 1, stop: 1 }).ok).toBe(false);
    expect(parseOrder({ epic: "GOLD", side: "buy", size: 1, stop: 1 }).ok).toBe(false);
    expect(parseOrder({ epic: "GOLD", side: "long", size: 0, stop: 1 }).ok).toBe(false);
    expect(parseOrder({ epic: "GOLD", side: "long", size: "1", stop: 1 }).ok).toBe(false);
    expect(parseOrder({ epic: "GOLD", side: "long", size: 1, stop: 5, target: "abc" }).ok).toBe(false);
  });
  it("lets the target be empty", () => {
    expect(parseOrder({ epic: "GOLD", side: "short", size: 1, stop: 5, target: "" })).toMatchObject({ ok: true, value: { target: null } });
  });
});

describe("assessOrder", () => {
  it("prices a buy on the offer and a sell on the bid", () => {
    expect(assessOrder(buy, Q, [], NOW)).toMatchObject({ ok: true, value: { entry: 2650.5 } });
    expect(assessOrder(sell, Q, [], NOW)).toMatchObject({ ok: true, value: { entry: 2650 } });
  });
  it("computes the risk and the reward", () => {
    const r = assessOrder(buy, Q, [], NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.risk).toBeCloseTo(10.5);
    expect(r.value.reward).toBeCloseTo(19.5);
    expect(r.value.ratio).toBeCloseTo(19.5 / 10.5);
  });
  it("refuses a stop or a target on the wrong side", () => {
    expect(assessOrder({ ...buy, stop: 2660 }, Q, [], NOW).ok).toBe(false);
    expect(assessOrder({ ...buy, target: 2640 }, Q, [], NOW).ok).toBe(false);
    expect(assessOrder({ ...sell, stop: 2640 }, Q, [], NOW).ok).toBe(false);
    expect(assessOrder({ ...sell, target: 2660 }, Q, [], NOW).ok).toBe(false);
  });
  it("refuses a stop that the spread alone would hit, or that is absurdly far", () => {
    expect(assessOrder({ ...buy, stop: 2650.4 }, Q, [], NOW).ok).toBe(false);
    expect(assessOrder({ ...buy, stop: 2000 }, Q, [], NOW).ok).toBe(false);
  });
  it("refuses a closed market and a missing quote", () => {
    expect(assessOrder(buy, { ...Q, status: "CLOSED" }, [], NOW).ok).toBe(false);
    expect(assessOrder(buy, { status: "TRADEABLE", bid: null, offer: null }, [], NOW).ok).toBe(false);
  });
  it("caps the size of a position", () => {
    expect(assessOrder({ ...buy, size: Math.ceil(LIMITS.maxNotionalUsd / 2650) + 1 }, Q, [], NOW).ok).toBe(false);
  });
  it("caps the number of open positions", () => {
    const three = [pos({ dealId: "a" }), pos({ dealId: "b" }), pos({ dealId: "c" })];
    expect(assessOrder(buy, Q, three, NOW).ok).toBe(false);
    expect(assessOrder(buy, Q, three.slice(0, 2), NOW).ok).toBe(true);
  });
  it("refuses the same order again within two minutes, not later and not the other way", () => {
    expect(assessOrder(buy, Q, [pos({ createdAt: NOW - 30_000 })], NOW).ok).toBe(false);
    expect(assessOrder(buy, Q, [pos({ createdAt: NOW - 10 * 60_000 })], NOW).ok).toBe(true);
    expect(assessOrder(sell, Q, [pos({ createdAt: NOW - 30_000 })], NOW).ok).toBe(true);
  });
  it("warns about a missing target and a target closer than the stop", () => {
    const none = assessOrder({ ...buy, target: null }, Q, [], NOW);
    expect(none.ok && none.value.warnings.join(" ")).toMatch(/objectif/i);
    const near = assessOrder({ ...buy, target: 2655 }, Q, [], NOW);
    expect(near.ok && near.value.warnings.join(" ")).toMatch(/plus proche/);
  });
});

describe("demo only", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("passes on the demo account", () => {
    vi.stubEnv("CAPITAL_ENV", "demo");
    expect(() => assertDemoOnly()).not.toThrow();
    vi.stubEnv("CAPITAL_ENV", "");
    expect(() => assertDemoOnly()).not.toThrow();
  });
  it("refuses the live account, however the live host is reached", () => {
    vi.stubEnv("CAPITAL_ENV", "live");
    expect(() => assertDemoOnly()).toThrow(/démo/);
    vi.stubEnv("CAPITAL_ENV", "demo");
    vi.stubEnv("CAPITAL_BASE_URL", "https://api-capital.backend-capital.com");
    expect(() => assertDemoOnly()).toThrow(/démo/);
    vi.stubEnv("CAPITAL_BASE_URL", "not a url");
    expect(() => assertDemoOnly()).toThrow(/démo/);
  });
});

describe("order service", () => {
  beforeEach(() => {
    vi.stubEnv("TRADING_ENABLED", "true");
    vi.stubEnv("CAPITAL_ENV", "demo");
    vi.stubEnv("CAPITAL_BASE_URL", "");
    vi.stubEnv("DASHBOARD_PASSWORD", "site-password");
    vi.stubEnv("JOURNAL_STORAGE", "memory");
    vi.stubEnv("STORAGE_BACKEND", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "");
    __resetMemoryStorage();
    amend.mockReset().mockResolvedValue("ref3");
    closeInfo.mockReset().mockResolvedValue(null);
    calendar.mockReset().mockResolvedValue({ events: [], updatedAt: Date.now(), stale: false });
    quote.mockReset().mockResolvedValue(Q);
    positions.mockReset().mockResolvedValue([]);
    open.mockReset().mockResolvedValue("ref1");
    confirmation.mockReset().mockResolvedValue({ dealReference: "ref1", accepted: true, reason: null, dealId: "deal9", level: 2650.5 });
    close.mockReset().mockResolvedValue("ref2");
    __resetOrders();
    __setConfirmWait(1);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does nothing while trading is switched off, and never touches the broker", async () => {
    vi.stubEnv("TRADING_ENABLED", "");
    await expect(previewOrder(buy, NOW)).rejects.toThrow(/désactivés/);
    await expect(placeOrder("x", null, NOW)).rejects.toThrow(/désactivés/);
    expect(await ordersState()).toMatchObject({ enabled: false, reason: "off" });
    expect(quote).not.toHaveBeenCalled();
    expect(positions).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("reports the live account as off without calling the broker", async () => {
    vi.stubEnv("CAPITAL_ENV", "live");
    expect(await ordersState()).toMatchObject({ enabled: false, reason: "live" });
    await expect(previewOrder(buy, NOW)).rejects.toThrow(/démo/);
    expect(open).not.toHaveBeenCalled();
  });

  it("shows the open positions when trading is on", async () => {
    positions.mockResolvedValue([pos()]);
    expect(await ordersState()).toMatchObject({ enabled: true, positions: [{ dealId: "d1" }] });
  });

  it("previews without sending anything", async () => {
    const r = await previewOrder(buy, NOW);
    expect(r.plan.entry).toBe(2650.5);
    expect(r.expiresAt).toBe(NOW + LIMITS.tokenTtlMs);
    expect(open).not.toHaveBeenCalled();
  });

  it("sends the order once the recap is confirmed, with the stop and the target", async () => {
    const r = await previewOrder(buy, NOW);
    const res = await placeOrder(r.token, null, NOW + 5_000);
    expect(res).toMatchObject({ status: "accepted", dealId: "deal9", level: 2650.5 });
    expect(open).toHaveBeenCalledWith({ epic: "GOLD", direction: "BUY", size: 1, stopLevel: 2640, profitLevel: 2670 });
  });

  it("sends a sell as SELL, without target when there is none", async () => {
    const r = await previewOrder({ ...sell, target: null }, NOW);
    await placeOrder(r.token, null, NOW + 1_000);
    expect(open).toHaveBeenCalledWith({ epic: "GOLD", direction: "SELL", size: 1, stopLevel: 2660 });
  });

  it("refuses a recap that was altered, expired or never made", async () => {
    const r = await previewOrder(buy, NOW);
    const [body, sig] = r.token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), o: { ...buy, size: 50 } })).toString("base64url");
    await expect(placeOrder(`${forged}.${sig}`, null, NOW + 1_000)).rejects.toThrow(/invalide/);
    await expect(placeOrder(r.token, null, NOW + LIMITS.tokenTtlMs + 1)).rejects.toThrow(/expirée/);
    await expect(placeOrder(undefined, null, NOW)).rejects.toThrow(/invalide/);
    expect(await readRecap(r.token, NOW + 1)).not.toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a recap signed with another password", async () => {
    const r = await previewOrder(buy, NOW);
    vi.stubEnv("DASHBOARD_PASSWORD", "another");
    await expect(placeOrder(r.token, null, NOW + 1_000)).rejects.toThrow(/invalide/);
  });

  it("sends a recap only once", async () => {
    const r = await previewOrder(buy, NOW);
    await placeOrder(r.token, null, NOW + 1_000);
    await expect(placeOrder(r.token, null, NOW + 2_000)).rejects.toThrow(/déjà/);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("refuses when the price moved too far since the recap", async () => {
    const r = await previewOrder(buy, NOW);
    quote.mockResolvedValue({ status: "TRADEABLE", bid: 2660, offer: 2660.5 });
    await expect(placeOrder(r.token, null, NOW + 1_000)).rejects.toThrow(/prix a bougé/);
    expect(open).not.toHaveBeenCalled();
  });

  it("re-checks the limits just before sending", async () => {
    const r = await previewOrder(buy, NOW);
    positions.mockResolvedValue([pos({ dealId: "a" }), pos({ dealId: "b" }), pos({ dealId: "c" })]);
    await expect(placeOrder(r.token, null, NOW + 1_000)).rejects.toThrow(/positions ouvertes/);
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a refusal from the broker", async () => {
    confirmation.mockResolvedValue({ dealReference: "ref1", accepted: false, reason: "INSUFFICIENT_FUNDS", dealId: null, level: null });
    const r = await previewOrder(buy, NOW);
    expect(await placeOrder(r.token, null, NOW + 1_000)).toMatchObject({ status: "rejected", reason: "INSUFFICIENT_FUNDS" });
  });

  it("says the outcome is unknown when the confirmation cannot be read, instead of guessing", async () => {
    confirmation.mockRejectedValue(new Error("down"));
    const r = await previewOrder(buy, NOW);
    expect(await placeOrder(r.token, null, NOW + 1_000)).toMatchObject({ status: "unknown" });
    expect(confirmation).toHaveBeenCalledTimes(4);
  });

  it("closes a position, even when new orders are switched off, but never on the live account", async () => {
    vi.stubEnv("TRADING_ENABLED", "");
    expect(await closeOrder("deal9")).toMatchObject({ status: "accepted" });
    expect(close).toHaveBeenCalledWith("deal9");
    vi.stubEnv("CAPITAL_ENV", "live");
    await expect(closeOrder("deal9")).rejects.toThrow(/démo/);
    await expect(closeOrder("../x")).rejects.toThrow(/invalide/);
  });
});

describe("parsePositions", () => {
  it("reads positions and skips rows that do not look right", () => {
    const rows = parsePositions({
      positions: [
        { position: { dealId: "a", size: 2, level: 100, direction: "BUY", stopLevel: 90, createdDateUTC: "2026-10-27T10:00:00.000", upl: -3, currency: "USD" }, market: { epic: "GOLD", instrumentName: "Gold", bid: 99, offer: 100 } },
        { position: { dealId: "b", size: "x", level: 100, direction: "BUY" }, market: { epic: "GOLD" } },
        { position: { dealId: "c", size: 1, level: 1, direction: "LONG" }, market: { epic: "GOLD" } },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dealId: "a", direction: "BUY", stopLevel: 90, profitLevel: null, upl: -3, createdAt: Date.UTC(2026, 9, 27, 10, 0, 0) });
    expect(parsePositions(null)).toEqual([]);
  });
});

describe("same origin", () => {
  const req = (origin: string | null, host = "dash.example.app") => new Request("https://dash.example.app/api/orders", { method: "POST", headers: { ...(origin ? { origin } : {}), host } });
  it("accepts this site's own pages only", () => {
    expect(sameOrigin(req("https://dash.example.app"))).toBe(true);
    expect(sameOrigin(req("https://evil.example"))).toBe(false);
    expect(sameOrigin(req(null))).toBe(false);
    expect(sameOrigin(req("nonsense"))).toBe(false);
    expect(crossOriginRefused().status).toBe(403);
  });
});

const MODEL = { direction: "up", confidence: 0.62, source: "ML v2" };

describe("noting orders in Mes trades", () => {
  beforeEach(() => {
    vi.stubEnv("TRADING_ENABLED", "true");
    vi.stubEnv("CAPITAL_ENV", "demo");
    vi.stubEnv("CAPITAL_BASE_URL", "");
    vi.stubEnv("DASHBOARD_PASSWORD", "site-password");
    vi.stubEnv("JOURNAL_STORAGE", "memory");
    vi.stubEnv("STORAGE_BACKEND", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "");
    __resetMemoryStorage();
    __resetOrders();
    __setConfirmWait(1);
    quote.mockReset().mockResolvedValue(Q);
    positions.mockReset().mockResolvedValue([]);
    open.mockReset().mockResolvedValue("ref1");
    confirmation.mockReset().mockResolvedValue({ dealReference: "ref1", accepted: true, reason: null, dealId: "deal9", level: 2650.5 });
    close.mockReset().mockResolvedValue("ref2");
    amend.mockReset().mockResolvedValue("ref3");
    closeInfo.mockReset().mockResolvedValue(null);
    calendar.mockReset().mockResolvedValue({ events: [], updatedAt: Date.now(), stale: false });
  });
  afterEach(() => vi.unstubAllEnvs());

  const placed = async () => {
    const r = await previewOrder(buy, NOW);
    return placeOrder(r.token, MODEL, NOW + 1_000);
  };

  it("writes the executed order as a demo trade with the forecast of the moment", async () => {
    const res = await placed();
    expect(res.logged).toBe(true);
    const trades = (await readTrades())!;
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ epic: "GOLD", side: "long", entry: 2650.5, size: 1, stop: 2640, target: 2670, dealId: "deal9", demo: true, model: MODEL });
  });

  it("keeps an unusable forecast out of the trade, and still logs it", async () => {
    const r = await previewOrder(buy, NOW);
    await placeOrder(r.token, { direction: "sideways", confidence: "x" }, NOW + 1_000);
    expect((await readTrades())![0].model).toBeNull();
    expect(parseModel({ direction: "down", confidence: 0.5, source: "x".repeat(200) })?.source).toHaveLength(80);
    expect(parseModel(null)).toBeNull();
  });

  it("does not log a refused order", async () => {
    confirmation.mockResolvedValue({ dealReference: "ref1", accepted: false, reason: "NO", dealId: null, level: null });
    const r = await previewOrder(buy, NOW);
    expect((await placeOrder(r.token, MODEL, NOW + 1_000)).logged).toBe(false);
    expect(await readTrades()).toEqual([]);
  });

  it("closes the trade at the confirmed price when the position is closed from the dashboard", async () => {
    await placed();
    confirmation.mockResolvedValue({ dealReference: "ref2", accepted: true, reason: null, dealId: "deal9", level: 2655 });
    await closeOrder("deal9");
    expect((await readTrades())![0]).toMatchObject({ exit: 2655 });
    expect((await readTrades())![0].closedAt).toBeGreaterThan(0);
  });

  it("moves the stop, keeps the target, and records the new stop without touching the original one", async () => {
    await placed();
    positions.mockResolvedValue([pos({ dealId: "deal9", level: 2650.5, stopLevel: 2640, profitLevel: 2670, createdAt: NOW - 10 * 60_000 })]);
    quote.mockResolvedValue({ status: "TRADEABLE", bid: 2660, offer: 2660.5 });
    const res = await moveStop("deal9", 2650.5);
    expect(res).toMatchObject({ status: "accepted", stop: 2650.5 });
    expect(amend).toHaveBeenCalledWith("deal9", 2650.5, 2670);
    expect((await readTrades())![0]).toMatchObject({ stop: 2640, stopMoved: 2650.5 });
  });

  it("refuses to move a stop away from the price, or onto it", async () => {
    positions.mockResolvedValue([pos({ dealId: "deal9", stopLevel: 2640 })]);
    quote.mockResolvedValue({ status: "TRADEABLE", bid: 2660, offer: 2660.5 });
    await expect(moveStop("deal9", 2630)).rejects.toThrow(/resserrer/);
    await expect(moveStop("deal9", 2660)).rejects.toThrow(/sous le prix/);
    await expect(moveStop("deal9", Number.NaN)).rejects.toThrow(/invalide/);
    await expect(moveStop("nope", 2650)).rejects.toThrow(/introuvable/);
    expect(amend).not.toHaveBeenCalled();
  });

  it("never moves a stop on the live account", async () => {
    vi.stubEnv("CAPITAL_ENV", "live");
    await expect(moveStop("deal9", 2650)).rejects.toThrow(/démo/);
    expect(amend).not.toHaveBeenCalled();
  });
});

describe("assessStopMove", () => {
  const q = { status: "TRADEABLE", bid: 100, offer: 100.2 };
  it("only lets a stop get closer to the price, on the right side, clear of the spread", () => {
    expect(assessStopMove({ side: "long", currentStop: 95, newStop: 99 }, q).ok).toBe(true);
    expect(assessStopMove({ side: "long", currentStop: 95, newStop: 94 }, q).ok).toBe(false);
    expect(assessStopMove({ side: "long", currentStop: 95, newStop: 99.9 }, q).ok).toBe(false);
    expect(assessStopMove({ side: "long", currentStop: null, newStop: 90 }, q).ok).toBe(true);
    expect(assessStopMove({ side: "short", currentStop: 105, newStop: 101 }, q).ok).toBe(true);
    expect(assessStopMove({ side: "short", currentStop: 105, newStop: 106 }, q).ok).toBe(false);
    expect(assessStopMove({ side: "short", currentStop: 105, newStop: 100.3 }, q).ok).toBe(false);
    expect(assessStopMove({ side: "long", currentStop: 95, newStop: 99 }, { ...q, status: "CLOSED" }).ok).toBe(false);
  });
});

describe("parseCloseActivity", () => {
  const act = (id: string, level: number, dateUTC = "2026-10-28T10:00:00") => ({ dateUTC, dealId: id, details: { level, actions: [{ actionType: "POSITION_CLOSED", affectedDealId: id }] } });
  it("finds the closing level of one deal, the latest if there are several", () => {
    expect(parseCloseActivity({ activities: [act("a", 10), act("b", 20), act("b", 21, "2026-10-28T11:00:00")] }, "b")).toEqual({ level: 21, at: Date.UTC(2026, 9, 28, 11, 0, 0) });
  });
  it("ignores openings, other deals and anything that does not look right", () => {
    expect(parseCloseActivity({ activities: [{ dealId: "a", details: { level: 10, actions: [{ actionType: "POSITION_OPENED", affectedDealId: "a" }] } }] }, "a")).toBeNull();
    expect(parseCloseActivity({ activities: [act("a", 10)] }, "z")).toBeNull();
    expect(parseCloseActivity({ activities: [act("a", -1)] }, "a")).toBeNull();
    expect(parseCloseActivity({ nope: 1 }, "a")).toBeNull();
    expect(parseCloseActivity(null, "a")).toBeNull();
  });
});

describe("syncDemoTrades", () => {
  beforeEach(() => {
    vi.stubEnv("CAPITAL_ENV", "demo");
    vi.stubEnv("CAPITAL_BASE_URL", "");
    vi.stubEnv("JOURNAL_STORAGE", "memory");
    vi.stubEnv("STORAGE_BACKEND", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "");
    __resetMemoryStorage();
    closeInfo.mockReset().mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllEnvs());

  const seed = (t: object) =>
    updateTrades<null>((trades) => ({ trades: [...trades, { id: "t1", epic: "GOLD", side: "long", openedAt: NOW - 3_600_000, entry: 2650, size: 1, stop: 2640, target: 2670, model: null, dealId: "d1", demo: true, ...t }] as never, result: null }));

  it("does nothing when everything matches", async () => {
    await seed({});
    expect(await syncDemoTrades(NOW, [pos({ dealId: "d1", stopLevel: 2640 })])).toBe(0);
  });

  it("closes a trade whose position is gone, at the price of the account activity", async () => {
    await seed({});
    closeInfo.mockResolvedValue({ level: 2640, at: NOW - 60_000 });
    expect(await syncDemoTrades(NOW, [])).toBe(1);
    expect((await readTrades())![0]).toMatchObject({ exit: 2640, closedAt: NOW - 60_000 });
  });

  it("does not guess the price when the activity does not give it: it flags the trade instead, once", async () => {
    await seed({});
    expect(await syncDemoTrades(NOW, [])).toBe(1);
    const t = (await readTrades())![0];
    expect(t.exit).toBeUndefined();
    expect(t.brokerClosed).toBe(NOW);
    expect(await syncDemoTrades(NOW + 1000, [])).toBe(0);
    closeInfo.mockResolvedValue({ level: 2671, at: null });
    expect(await syncDemoTrades(NOW + 2000, [])).toBe(1); // the price shows up later
    expect((await readTrades())![0]).toMatchObject({ exit: 2671 });
  });

  it("adopts a demo position nobody noted, without inventing a stop on the wrong side", async () => {
    expect(await syncDemoTrades(NOW, [pos({ dealId: "x1", level: 100, stopLevel: 101, profitLevel: 120 })])).toBe(1);
    const t = (await readTrades())![0];
    expect(t).toMatchObject({ dealId: "x1", demo: true, side: "long", entry: 100, target: 120, stopMoved: 101, model: null });
    expect(t.stop).toBeUndefined();
    expect(await syncDemoTrades(NOW, [pos({ dealId: "x1", level: 100, stopLevel: 101 })])).toBe(0); // not adopted twice
  });

  it("ignores positions on instruments the dashboard does not follow", async () => {
    expect(await syncDemoTrades(NOW, [pos({ dealId: "x2", epic: "OTHER" })])).toBe(0);
  });

  it("picks up a stop moved on Capital.com", async () => {
    await seed({});
    expect(await syncDemoTrades(NOW, [pos({ dealId: "d1", stopLevel: 2648 })])).toBe(1);
    expect((await readTrades())![0]).toMatchObject({ stop: 2640, stopMoved: 2648 });
  });

  it("refuses to run on the live account", async () => {
    vi.stubEnv("CAPITAL_ENV", "live");
    await expect(syncDemoTrades(NOW, [])).rejects.toThrow(/démo/);
  });
});

describe("related instruments", () => {
  it("gives the model at most four others, never the instrument itself", () => {
    for (const i of INSTRUMENTS) {
      const r = relatedEpics(i.epic);
      expect(r.length).toBeLessThanOrEqual(4);
      expect(r).not.toContain(i.epic);
      expect(new Set(r).size).toBe(r.length);
    }
    expect(relatedEpics("GOLD")).toEqual(["EURUSD", "US500", "OIL_CRUDE", "BTCUSD"]);
  });
  it("fills with the other instruments when nothing is configured", () => {
    expect(relatedEpics("UNKNOWN")).toHaveLength(4);
  });
  it("follows the three new instruments", () => {
    const epics = INSTRUMENTS.map((i) => i.epic);
    expect(epics).toEqual(expect.arrayContaining(["US100", "US500", "EURUSD"]));
  });
});

describe("announcements around an order", () => {
  const ev = (min: number, impact: "high" | "medium" = "high", title = "CPI m/m") => ({ title, currency: "USD", impact, time: 0, minutesFromNow: min }) as never;
  const Q2 = { status: "TRADEABLE", bid: 2650, offer: 2650.5 };

  it("refuses an order just before or after a major announcement, saying why", () => {
    const r = assessOrder(buy, Q2, [], NOW, [ev(10)]);
    expect(r).toMatchObject({ ok: false, news: true });
    expect(!r.ok && r.error).toMatch(/CPI m\/m.*dans 10 min/);
    expect(assessOrder(buy, Q2, [], NOW, [ev(-10)])).toMatchObject({ ok: false, news: true });
  });

  it("lets it through once the owner acknowledged it, with a reminder in the recap", () => {
    const r = assessOrder({ ...buy, ackNews: true }, Q2, [], NOW, [ev(10)]);
    expect(r.ok && r.value.warnings.join(" ")).toMatch(/passé outre/);
  });

  it("does not block outside the window, a medium announcement, or an unknown calendar, but says so", () => {
    expect(assessOrder(buy, Q2, [], NOW, [ev(45)]).ok).toBe(true);
    expect(assessOrder(buy, Q2, [], NOW, [ev(-20)]).ok).toBe(true);
    expect(assessOrder(buy, Q2, [], NOW, [ev(10, "medium")]).ok).toBe(true);
    const soon = assessOrder(buy, Q2, [], NOW, [ev(60)]);
    expect(soon.ok && soon.value.warnings.join(" ")).toMatch(/Annonce à venir/);
    const unknown = assessOrder(buy, Q2, [], NOW, null);
    expect(unknown.ok && unknown.value.warnings.join(" ")).toMatch(/Calendrier/);
    expect(assessOrder(buy, Q2, [], NOW).ok).toBe(true); // not checked
  });

  it("parseOrder keeps the acknowledgement only when it is exactly true", () => {
    expect(parseOrder({ epic: "GOLD", side: "long", size: 1, stop: 5, ackNews: true })).toMatchObject({ ok: true, value: { ackNews: true } });
    const no = parseOrder({ epic: "GOLD", side: "long", size: 1, stop: 5, ackNews: "yes" });
    expect(no.ok && no.value.ackNews).toBeUndefined();
  });

  describe("in the service", () => {
    beforeEach(() => {
      vi.stubEnv("TRADING_ENABLED", "true");
      vi.stubEnv("CAPITAL_ENV", "demo");
      vi.stubEnv("CAPITAL_BASE_URL", "");
      vi.stubEnv("DASHBOARD_PASSWORD", "site-password");
      vi.stubEnv("JOURNAL_STORAGE", "memory");
      __resetMemoryStorage();
      __resetOrders();
      quote.mockReset().mockResolvedValue(Q);
      positions.mockReset().mockResolvedValue([]);
      open.mockReset().mockResolvedValue("ref1");
      confirmation.mockReset().mockResolvedValue({ dealReference: "ref1", accepted: true, reason: null, dealId: "deal9", level: 2650.5 });
    });
    afterEach(() => vi.unstubAllEnvs());
    const soonEvent = (min: number) => ({ title: "Federal Funds Rate", country: "USD", currency: "USD", impact: "high", time: Math.floor(NOW / 1000) + min * 60 });

    it("refuses with its own error code, and sends nothing", async () => {
      calendar.mockResolvedValue({ events: [soonEvent(12)], updatedAt: NOW, stale: false });
      await expect(previewOrder(buy, NOW)).rejects.toMatchObject({ code: "NEWS_WINDOW", httpStatus: 422 });
      expect(open).not.toHaveBeenCalled();
    });

    it("goes through with the acknowledgement, and the check is made again before sending", async () => {
      calendar.mockResolvedValue({ events: [soonEvent(12)], updatedAt: NOW, stale: false });
      const r = await previewOrder({ ...buy, ackNews: true }, NOW);
      expect(r.plan.warnings.join(" ")).toMatch(/passé outre/);
      expect((await placeOrder(r.token, null, NOW + 1_000)).status).toBe("accepted");
    });

    it("an announcement that appears between the recap and the sending stops an order that was not acknowledged", async () => {
      calendar.mockResolvedValue({ events: [], updatedAt: NOW, stale: false });
      const r = await previewOrder(buy, NOW);
      calendar.mockResolvedValue({ events: [soonEvent(8)], updatedAt: NOW, stale: false });
      await expect(placeOrder(r.token, null, NOW + 1_000)).rejects.toMatchObject({ code: "NEWS_WINDOW" });
      expect(open).not.toHaveBeenCalled();
    });

    it("only counts announcements that matter for the instrument", async () => {
      calendar.mockResolvedValue({ events: [{ ...soonEvent(12), currency: "JPY", title: "BoJ" }], updatedAt: NOW, stale: false });
      expect((await previewOrder(buy, NOW)).order.epic).toBe("GOLD");
    });

    it("still allows an order, with a warning, when the calendar cannot be read", async () => {
      calendar.mockRejectedValue(new Error("down"));
      expect((await previewOrder(buy, NOW)).plan.warnings.join(" ")).toMatch(/Calendrier/);
    });
  });
});
