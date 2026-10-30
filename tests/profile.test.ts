import { describe, expect, it } from "vitest";
import { positionVsValue, profileWindow, valueRelation, volumeProfile } from "@/lib/profile";
import { computeStats, recordForecast, seriesKey } from "@/lib/journal/journal";
import { memoryStorage } from "@/lib/journal/storage";
import type { Candle } from "@/lib/types";
import type { JournalEntry } from "@/lib/journal/types";

const T0 = 1_700_000_000;
// a market that spends most of its time around 100 (volume 100 per candle), with brief visits to 90 and 110 (volume 5)
function candles(n = 120, withVolume = true): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const visit = i % 20 === 0 ? (i % 40 === 0 ? 110 : 90) : 100;
    const mid = visit;
    out.push({ time: T0 + i * 300, open: mid - 0.2, high: mid + 0.5, low: mid - 0.5, close: mid + 0.1, ...(withVolume ? { volume: visit === 100 ? 100 : 5 } : {}) });
  }
  out.push({ time: T0 + n * 300, open: 100, high: 101, low: 99, close: 100, volume: 3 }); // forming candle
  return out;
}

describe("volumeProfile", () => {
  it("puts the point of control where the volume is, and a value area around it", () => {
    const p = volumeProfile(candles(), 5)!;
    expect(p.basis).toBe("volume");
    expect(p.poc).toBeGreaterThan(99.4);
    expect(p.poc).toBeLessThan(100.6);
    expect(p.val).toBeLessThanOrEqual(p.poc);
    expect(p.vah).toBeGreaterThanOrEqual(p.poc);
    // the brief visits to 90 and 110 are outside the value area: it is a tight band around 100
    expect(p.vah - p.val).toBeLessThan(5);
    expect(p.vah).toBeLessThan(105);
    expect(p.val).toBeGreaterThan(95);
  });

  it("holds about 70 % of the volume inside the value area", () => {
    const p = volumeProfile(candles(), 5)!;
    const total = p.bins.reduce((s, b) => s + b.volume, 0);
    const inside = p.bins.filter((b) => b.price >= p.val && b.price <= p.vah).reduce((s, b) => s + b.volume, 0);
    expect(inside / total).toBeGreaterThanOrEqual(0.7);
    expect(inside / total).toBeLessThan(1);
  });

  it("does not count the candle still forming, and conserves the volume of the others", () => {
    const c = candles();
    const p = volumeProfile(c, 5)!;
    const expected = c.slice(0, -1).reduce((s, k) => s + (k.volume ?? 0), 0);
    expect(p.bins.reduce((s, b) => s + b.volume, 0)).toBeCloseTo(expected, 6);
    expect(p.candles).toBe(120);
  });

  it("falls back to time at price when the broker gives no volume", () => {
    const p = volumeProfile(candles(120, false), 5)!;
    expect(p.basis).toBe("temps");
    expect(p.poc).toBeGreaterThan(99.4);
    expect(p.poc).toBeLessThan(100.6);
  });

  it("looks back about one day, and needs enough candles and sane prices", () => {
    expect(profileWindow(5)).toBe(288);
    expect(profileWindow(15)).toBe(96);
    expect(profileWindow(1)).toBe(1440);
    expect(volumeProfile(candles(10), 5)).toBeNull();
    const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({ time: i, open: 5, high: 5, low: 5, close: 5, volume: 1 }));
    expect(volumeProfile(flat, 5)).toBeNull();
    const bad = candles(60);
    bad[10] = { ...bad[10], high: 1, low: 2 };
    expect(volumeProfile(bad, 5)).toBeNull();
  });

  it("with a profile skewed to one side, the point of control follows it", () => {
    const c: Candle[] = Array.from({ length: 100 }, (_, i) => ({ time: i, open: 0, high: 10 + (i < 80 ? 0 : 20), low: 9.5, close: 10, volume: i < 80 ? 50 : 1 }));
    const p = volumeProfile(c, 5)!;
    expect(p.poc).toBeLessThan(11);
  });
});

describe("position and relation", () => {
  const p = volumeProfile(candles(), 5)!;
  it("tells where the price stands against the value area", () => {
    expect(positionVsValue(p.poc, p)).toBe("in");
    expect(positionVsValue(p.vah + 1, p)).toBe("above");
    expect(positionVsValue(p.val - 1, p)).toBe("below");
  });
  it("tells a return to value from a move away from it", () => {
    expect(valueRelation("down", "above")).toBe("toward");
    expect(valueRelation("up", "above")).toBe("away");
    expect(valueRelation("up", "below")).toBe("toward");
    expect(valueRelation("down", "below")).toBe("away");
    expect(valueRelation("up", "in")).toBe("inside");
    expect(valueRelation("flat", "above")).toBe("inside");
  });
});

describe("journal measures the value area", () => {
  const entry = (i: number, direction: "up" | "down", up: boolean, va: JournalEntry["va"]): JournalEntry => ({
    id: `v${i}`, epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30, steps: 6, t: T0 + i * 3600, recordedAt: (T0 + i * 3600) * 1000,
    price: 100, direction, confidence: 0.6, target: 101, source: "ML v2", ref: 100, prev: 99.5, outcome: up ? 101 : 99, va,
  });

  it("splits hit rates between inside, toward and away", () => {
    const e: JournalEntry[] = [];
    for (let i = 0; i < 20; i++) e.push(entry(i, "down", false, "above")); // above, forecast down, price down: toward, right
    for (let i = 20; i < 40; i++) e.push(entry(i, "up", false, "above")); // above, forecast up, price down: away, wrong
    e.push(entry(40, "up", true, "in"));
    const st = computeStats(e, () => 1, () => 1);
    expect(st.byValue.toward).toMatchObject({ hits: 20, samples: 20, hitRate: 1 });
    expect(st.byValue.away).toMatchObject({ hits: 0, samples: 20, hitRate: 0 });
    expect(st.byValue.inside.samples).toBe(1);
  });

  it("records the position with the forecast", async () => {
    const storage = memoryStorage();
    const cs: Candle[] = Array.from({ length: 5 }, (_, i) => ({ time: T0 + i * 300, open: 1, high: 1, low: 1, close: 1 }));
    const series = { epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 90 };
    await recordForecast(storage, series, cs, { direction: "up", confidence: 0.6, points: [{ time: T0 + 4000, value: 1.1, low: 1, high: 1.2 }], source: "ML v2" }, 5_000_000, null, undefined, { va: "below" });
    expect((await storage.read<JournalEntry>(seriesKey(series))).entries[0].va).toBe("below");
  });
});
