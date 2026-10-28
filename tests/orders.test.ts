import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const quote = vi.fn();
const positions = vi.fn();
const open = vi.fn();
const confirmation = vi.fn();
const close = vi.fn();

vi.mock("@/lib/capital", async (orig) => {
  const real = await orig<typeof import("@/lib/capital")>();
  return {
    ...real,
    getFreshQuote: (...a: unknown[]) => quote(...a),
    listPositions: (...a: unknown[]) => positions(...a),
    openPosition: (...a: unknown[]) => open(...a),
    getConfirmation: (...a: unknown[]) => confirmation(...a),
    closePositionDeal: (...a: unknown[]) => close(...a),
  };
});

import { assertDemoOnly, parsePositions, type OpenPosition } from "@/lib/capital";
import { assessOrder, LIMITS, ordersState, parseOrder, placeOrder, previewOrder, readRecap, __resetOrders, __setConfirmWait, closeOrder, type Order } from "@/lib/orders";
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
    await expect(placeOrder("x", NOW)).rejects.toThrow(/désactivés/);
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
    const res = await placeOrder(r.token, NOW + 5_000);
    expect(res).toMatchObject({ status: "accepted", dealId: "deal9", level: 2650.5 });
    expect(open).toHaveBeenCalledWith({ epic: "GOLD", direction: "BUY", size: 1, stopLevel: 2640, profitLevel: 2670 });
  });

  it("sends a sell as SELL, without target when there is none", async () => {
    const r = await previewOrder({ ...sell, target: null }, NOW);
    await placeOrder(r.token, NOW + 1_000);
    expect(open).toHaveBeenCalledWith({ epic: "GOLD", direction: "SELL", size: 1, stopLevel: 2660 });
  });

  it("refuses a recap that was altered, expired or never made", async () => {
    const r = await previewOrder(buy, NOW);
    const [body, sig] = r.token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), o: { ...buy, size: 50 } })).toString("base64url");
    await expect(placeOrder(`${forged}.${sig}`, NOW + 1_000)).rejects.toThrow(/invalide/);
    await expect(placeOrder(r.token, NOW + LIMITS.tokenTtlMs + 1)).rejects.toThrow(/expirée/);
    await expect(placeOrder(undefined, NOW)).rejects.toThrow(/invalide/);
    expect(await readRecap(r.token, NOW + 1)).not.toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a recap signed with another password", async () => {
    const r = await previewOrder(buy, NOW);
    vi.stubEnv("DASHBOARD_PASSWORD", "another");
    await expect(placeOrder(r.token, NOW + 1_000)).rejects.toThrow(/invalide/);
  });

  it("sends a recap only once", async () => {
    const r = await previewOrder(buy, NOW);
    await placeOrder(r.token, NOW + 1_000);
    await expect(placeOrder(r.token, NOW + 2_000)).rejects.toThrow(/déjà/);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("refuses when the price moved too far since the recap", async () => {
    const r = await previewOrder(buy, NOW);
    quote.mockResolvedValue({ status: "TRADEABLE", bid: 2660, offer: 2660.5 });
    await expect(placeOrder(r.token, NOW + 1_000)).rejects.toThrow(/prix a bougé/);
    expect(open).not.toHaveBeenCalled();
  });

  it("re-checks the limits just before sending", async () => {
    const r = await previewOrder(buy, NOW);
    positions.mockResolvedValue([pos({ dealId: "a" }), pos({ dealId: "b" }), pos({ dealId: "c" })]);
    await expect(placeOrder(r.token, NOW + 1_000)).rejects.toThrow(/positions ouvertes/);
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a refusal from the broker", async () => {
    confirmation.mockResolvedValue({ dealReference: "ref1", accepted: false, reason: "INSUFFICIENT_FUNDS", dealId: null, level: null });
    const r = await previewOrder(buy, NOW);
    expect(await placeOrder(r.token, NOW + 1_000)).toMatchObject({ status: "rejected", reason: "INSUFFICIENT_FUNDS" });
  });

  it("says the outcome is unknown when the confirmation cannot be read, instead of guessing", async () => {
    confirmation.mockRejectedValue(new Error("down"));
    const r = await previewOrder(buy, NOW);
    expect(await placeOrder(r.token, NOW + 1_000)).toMatchObject({ status: "unknown" });
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
