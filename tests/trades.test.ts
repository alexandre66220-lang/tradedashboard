import { describe, expect, it } from "vitest";
import { applyPatch, parseNewTrade, parsePatch, tradePnl, tradeR, tradeStats, type Trade } from "@/lib/trades";

const EPICS = ["GOLD", "BTCUSD"];
const NOW = 1_800_000_000_000;
const base = { epic: "GOLD", side: "long", entry: 2000, size: 2, stop: 1990, target: 2030 };

describe("parseNewTrade", () => {
  it("accepts a well-formed trade and defaults the opening time", () => {
    const r = parseNewTrade({ ...base, note: "test" }, EPICS, NOW);
    expect(r).toMatchObject({ ok: true, value: { epic: "GOLD", side: "long", openedAt: NOW, entry: 2000, size: 2, stop: 1990, target: 2030, note: "test", model: null } });
  });

  it("rejects bad input", () => {
    const bad = (o: object) => parseNewTrade({ ...base, ...o }, EPICS, NOW);
    expect(bad({ epic: "NOPE" }).ok).toBe(false);
    expect(bad({ side: "buy" }).ok).toBe(false);
    expect(bad({ entry: -1 }).ok).toBe(false);
    expect(bad({ size: 0 }).ok).toBe(false);
    expect(bad({ size: "2" }).ok).toBe(false);
    expect(bad({ stop: 2010 }).ok).toBe(false); // stop above a long entry
    expect(bad({ target: 1990 }).ok).toBe(false);
    expect(bad({ side: "short", stop: 1990, target: 2030 }).ok).toBe(false); // mirrored
    expect(bad({ openedAt: NOW + 10 * 60_000 }).ok).toBe(false);
    expect(bad({ note: "x".repeat(501) }).ok).toBe(false);
    expect(bad({ model: { direction: "sideways", confidence: 1, source: "x" } }).ok).toBe(false);
    expect(parseNewTrade(null, EPICS, NOW).ok).toBe(false);
  });

  it("allows a short with consistent levels and no stop", () => {
    expect(parseNewTrade({ epic: "BTCUSD", side: "short", entry: 100, size: 1, stop: 110, target: 80 }, EPICS, NOW).ok).toBe(true);
    expect(parseNewTrade({ epic: "BTCUSD", side: "short", entry: 100, size: 1 }, EPICS, NOW).ok).toBe(true);
  });
});

describe("patches", () => {
  const open: Trade = { id: "a", epic: "GOLD", side: "long", openedAt: NOW - 3600_000, entry: 2000, size: 2, stop: 1990 };

  it("closes a trade with an exit price", () => {
    const p = parsePatch({ exit: 2015 }, NOW);
    if (!p.ok) throw new Error(p.error);
    const t = applyPatch(open, p.value, NOW);
    expect(t).toMatchObject({ exit: 2015, closedAt: NOW });
    expect(tradePnl(t as Trade)).toBe(30);
    expect(tradeR(t as Trade)).toBeCloseTo(1.5);
  });

  it("validates patches and refuses inconsistent changes", () => {
    expect(parsePatch({}, NOW).ok).toBe(false);
    expect(parsePatch({ exit: 0 }, NOW).ok).toBe(false);
    expect(parsePatch({ stop: "x" }, NOW).ok).toBe(false);
    expect(typeof applyPatch(open, { stop: 2005 }, NOW)).toBe("string");
    expect(typeof applyPatch(open, { closedAt: NOW }, NOW)).toBe("string"); // no exit price yet
    expect(typeof applyPatch(open, { exit: 2010, closedAt: open.openedAt - 1 }, NOW)).toBe("string");
    const cleared = applyPatch(open, { stop: null, note: "x" }, NOW) as Trade;
    expect(cleared.stop).toBeUndefined();
    expect(cleared.note).toBe("x");
  });
});

describe("tradeStats", () => {
  const mk = (i: number, side: "long" | "short", exit: number, model?: Trade["model"], stop: number | null = 90): Trade => ({
    id: String(i), epic: "GOLD", side, openedAt: NOW + i * 1000, closedAt: NOW + i * 1000 + 500, entry: 100, size: 1, exit, ...(stop !== null ? { stop: side === "long" ? stop : 200 - stop } : {}), model,
  });

  it("computes pnl, R, drawdown, profit factor and the daily result", () => {
    const trades = [
      mk(1, "long", 110), // +10, R=+1
      mk(2, "long", 95), // -5, R=-0.5
      mk(3, "short", 110), // -10 (stop 110 -> R=-1)
      mk(4, "short", 90), // +10, R=+1
      { id: "o", epic: "GOLD", side: "long", openedAt: NOW, entry: 100, size: 1 } as Trade, // still open
    ];
    const s = tradeStats(trades, NOW + 3000);
    expect(s).toMatchObject({ open: 1, closed: 4, wins: 2, totalPnl: 5, withStop: 4, noStop: 0 });
    expect(s.winRate).toBeNull(); // fewer than 20 trades
    expect(s.profitFactor).toBeCloseTo(20 / 15);
    expect(s.expectancyR).toBeCloseTo((1 - 0.5 - 1 + 1) / 4);
    expect(s.maxDrawdown).toBe(15); // peak +10, trough -5
    expect(s.todayPnl).toBe(0); // closed since NOW+3000: trade 3 (-10) and trade 4 (+10)
    expect(s.curve.map((c) => c.v)).toEqual([10, 5, -5, 5]);
  });

  it("splits results by agreement with the model and counts missing stops", () => {
    const up = { direction: "up", confidence: 0.6, source: "ML" } as const;
    const trades = [mk(1, "long", 105, up), mk(2, "short", 105, up), mk(3, "long", 105, { ...up, direction: "flat" }), mk(4, "long", 105, null, null)];
    const s = tradeStats(trades, 0);
    expect(s.withModel).toEqual({ trades: 1, wins: 1, pnl: 5 });
    expect(s.againstModel).toEqual({ trades: 1, wins: 0, pnl: -5 });
    expect(s.noStop).toBe(1);
  });

  it("gives a win rate and margin from 20 closed trades", () => {
    const trades = Array.from({ length: 20 }, (_, i) => mk(i, "long", i < 12 ? 105 : 95));
    const s = tradeStats(trades, 0);
    expect(s.winRate).toBeCloseTo(0.6);
    expect(s.margin).toBeCloseTo(0.219, 2);
  });
});
