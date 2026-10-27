import { describe, expect, it } from "vitest";
import { aggregateCandles, bollinger, ema, fibRetracement, macdHistogram, nearFibLevel, rsi, stampFor, technicalVotes } from "@/lib/indicators";
import type { Candle } from "@/lib/types";

const T0 = 1_700_000_000 - (1_700_000_000 % 900);
const candles = (closes: number[], step = 300, wick = 0.3): Candle[] =>
  closes.map((c, i) => ({ time: T0 + i * step, open: i ? closes[i - 1] : c, high: Math.max(c, i ? closes[i - 1] : c) + wick, low: Math.min(c, i ? closes[i - 1] : c) - wick, close: c }));
const up = Array.from({ length: 240 }, (_, i) => 100 + i * 0.5);
const down = Array.from({ length: 240 }, (_, i) => 220 - i * 0.5);

describe("indicators", () => {
  it("ema follows a constant, and lags a ramp", () => {
    expect(ema([5, 5, 5, 5], 3)).toEqual([5, 5, 5, 5]);
    const e = ema(up, 20);
    expect(e.at(-1)!).toBeLessThan(up.at(-1)!);
    expect(e.at(-1)!).toBeGreaterThan(up.at(-30)!);
  });

  it("rsi is 100 in a straight rise, 0 in a straight fall, 50 when nothing moves, null while warming up", () => {
    expect(rsi(up).at(-1)).toBe(100);
    expect(rsi(down).at(-1)).toBeCloseTo(0, 5);
    expect(rsi(Array(30).fill(7)).at(-1)).toBe(50);
    expect(rsi(up)[5]).toBeNull();
  });

  it("macd histogram is zero on a flat line and null while warming up", () => {
    const flat = macdHistogram(Array(80).fill(10));
    expect(flat.at(-1)).toBeCloseTo(0, 9);
    expect(flat[10]).toBeNull();
  });

  it("bollinger bands collapse on a flat series and widen with volatility", () => {
    const flat = bollinger(Array(30).fill(10)).at(-1)!;
    expect(flat.upper).toBe(10);
    expect(flat.lower).toBe(10);
    const wild = bollinger(Array.from({ length: 30 }, (_, i) => 10 + (i % 2 ? 2 : -2))).at(-1)!;
    expect(wild.upper - wild.lower).toBeGreaterThan(5);
    expect(bollinger([1, 2, 3])[1]).toBeNull();
  });

  it("aggregates candles into longer ones", () => {
    const base = [
      { time: T0, open: 1, high: 3, low: 0, close: 2 },
      { time: T0 + 300, open: 2, high: 5, low: 1, close: 4 },
      { time: T0 + 600, open: 4, high: 4, low: 2, close: 3 },
      { time: T0 + 900, open: 3, high: 6, low: 3, close: 6 },
    ];
    expect(aggregateCandles(base, 900)).toEqual([
      { time: T0, open: 1, high: 5, low: 0, close: 3 },
      { time: T0 + 900, open: 3, high: 6, low: 3, close: 6 },
    ]);
  });
});

describe("fibonacci retracement", () => {
  it("measures the last leg: down from the high after a rise, up from the low after a fall", () => {
    const rise = fibRetracement(candles([...Array.from({ length: 60 }, (_, i) => 100 + i)], 300, 0))!;
    expect(rise.leg).toBe("up");
    expect(rise.high).toBe(159);
    expect(rise.low).toBe(100);
    const l618 = rise.levels.find((l) => l.ratio === 0.618)!;
    expect(l618.price).toBeCloseTo(159 - 0.618 * 59, 6);
    const fall = fibRetracement(candles(Array.from({ length: 60 }, (_, i) => 159 - i), 300, 0))!;
    expect(fall.leg).toBe("down");
    expect(fall.levels.find((l) => l.ratio === 0.5)!.price).toBeCloseTo(100 + 0.5 * 59, 6);
  });

  it("has nothing to say without a range or enough candles", () => {
    expect(fibRetracement(candles(Array(10).fill(1)))).toBeNull();
    expect(fibRetracement(candles(Array(40).fill(1), 300, 0))).toBeNull();
  });

  it("detects a price sitting on a level, within a fraction of the ATR", () => {
    const fib = fibRetracement(candles(Array.from({ length: 60 }, (_, i) => 100 + i), 300, 0))!;
    const level = fib.levels[3].price;
    expect(nearFibLevel(level + 0.1, fib, 2)).toBe(true);
    expect(nearFibLevel(level + 5, fib, 2)).toBe(false);
    expect(nearFibLevel(level, null, 2)).toBe(false);
    expect(nearFibLevel(level, fib, null)).toBe(false);
  });
});

describe("technical votes and confluence", () => {
  it("all lean up in a steady rise, and all lean down in a steady fall", () => {
    const u = technicalVotes(candles(up), 5);
    expect(u.map((v) => v.id)).toEqual(["trend", "rsi", "macd", "breakout", "higher"]);
    expect(u.every((v) => v.vote === 1)).toBe(true);
    const d = technicalVotes(candles(down), 5);
    expect(d.every((v) => v.vote === -1)).toBe(true);
  });

  it("has no opinion without history, and the higher timeframe does not apply to daily candles", () => {
    expect(technicalVotes(candles(up.slice(0, 10)), 5).every((v) => v.vote === 0)).toBe(true);
    const daily = technicalVotes(candles(up, 86_400), 1440);
    expect(daily.find((v) => v.id === "higher")).toMatchObject({ vote: 0, detail: expect.stringMatching(/Non applicable/) });
  });

  it("counts agreement with the forecast direction, and none for a neutral forecast", () => {
    const votes = [
      { id: "a", label: "", vote: 1 as const, detail: "" },
      { id: "b", label: "", vote: 1 as const, detail: "" },
      { id: "c", label: "", vote: -1 as const, detail: "" },
      { id: "d", label: "", vote: 0 as const, detail: "" },
    ];
    expect(stampFor(votes, "up")).toEqual({ agree: 2, against: 1, voting: 3 });
    expect(stampFor(votes, "down")).toEqual({ agree: 1, against: 2, voting: 3 });
    expect(stampFor(votes, "flat")).toBeNull();
  });
});
