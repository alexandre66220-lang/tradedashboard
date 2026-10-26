import { describe, expect, it } from "vitest";
import { atrPercentile, trafficLight, type LightInput } from "@/lib/trafficlight";
import type { Candle } from "@/lib/types";

const NOW = 1_800_000_000;
function candles(n: number, range: (i: number) => number, end = NOW): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const r = range(i);
    return { time: end - (n - 1 - i) * 300, open: 100, high: 100 + r / 2, low: 100 - r / 2, close: 100 };
  });
}
const calm = candles(300, () => 1);
const base: LightInput = {
  marketStatus: "TRADEABLE",
  quote: { bid: 2650, offer: 2650.53 }, // 2 bps
  assumedSpreadBps: 2,
  candles: calm,
  resMinutes: 5,
  todayPnl: 0,
  dailyLossLimit: 50,
  now: NOW,
};

describe("trafficLight", () => {
  it("is green when nothing is wrong", () => {
    const r = trafficLight(base);
    expect(r.light).toBe("green");
    expect(r.reasons).toEqual([]);
    expect(r.spreadBps).toBeCloseTo(2, 1);
  });

  it("turns red when the market is closed, the spread explodes or the daily loss is reached", () => {
    expect(trafficLight({ ...base, marketStatus: "CLOSED" }).light).toBe("red");
    expect(trafficLight({ ...base, quote: { bid: 2650, offer: 2653.2 } }).light).toBe("red"); // ~12 bps = 6x
    expect(trafficLight({ ...base, todayPnl: -50 }).light).toBe("red");
    expect(trafficLight({ ...base, todayPnl: -80 }).light).toBe("red");
  });

  it("turns orange for a wider spread, half the daily loss, stale data or an extreme volatility", () => {
    expect(trafficLight({ ...base, quote: { bid: 2650, offer: 2650.99 } }).light).toBe("orange"); // ~3.7 bps = 1.9x
    expect(trafficLight({ ...base, todayPnl: -30 }).light).toBe("orange");
    expect(trafficLight({ ...base, now: NOW + 5 * 300 }).reasons.some((x) => /retard/.test(x.text))).toBe(true);
    const wild = candles(300, (i) => (i > 285 ? 8 : 1));
    expect(trafficLight({ ...base, candles: wild }).reasons.some((x) => /agité/.test(x.text))).toBe(true);
    const dead = candles(300, (i) => (i > 285 ? 0.05 : 1));
    expect(trafficLight({ ...base, candles: dead }).reasons.some((x) => /calme/.test(x.text))).toBe(true);
  });

  it("ignores the loss limit when it is not set, and works without a quote", () => {
    const r = trafficLight({ ...base, quote: null, dailyLossLimit: null, todayPnl: -999 });
    expect(r.light).toBe("green");
    expect(r.spreadBps).toBeNull();
  });

  it("reacts to announcements", () => {
    const high = trafficLight({ ...base, news: [{ title: "NFP", minutesFromNow: 10, impact: "high" }] });
    expect(high.light).toBe("red");
    expect(trafficLight({ ...base, news: [{ title: "NFP", minutesFromNow: -20, impact: "high" }] }).light).toBe("red");
    expect(trafficLight({ ...base, news: [{ title: "NFP", minutesFromNow: 60, impact: "high" }] }).light).toBe("orange");
    expect(trafficLight({ ...base, news: [{ title: "PMI", minutesFromNow: 15, impact: "medium" }] }).light).toBe("orange");
    expect(trafficLight({ ...base, news: [{ title: "PMI", minutesFromNow: 200, impact: "medium" }] }).light).toBe("green");
  });

  it("reports no volatility rank with too little history", () => {
    expect(atrPercentile(candles(50, () => 1))).toBeNull();
  });
});
