import { describe, expect, it } from "vitest";
import { computeStats } from "@/lib/journal/journal";
import type { JournalEntry } from "@/lib/journal/types";
import { MIN_JUDGED, signalFrom } from "@/lib/signal";

const T0 = Date.UTC(2026, 9, 26, 0, 0, 0) / 1000; // a Monday, 00:00 UTC

function entry(i: number, over: Partial<JournalEntry> & { hourUtc?: number } = {}): JournalEntry {
  const { hourUtc, ...rest } = over;
  return {
    id: String(i), epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30, steps: 6,
    t: T0 + (hourUtc ?? 0) * 3600 + i * 60, recordedAt: 1000 + i, price: 100, direction: "up", confidence: 0.6, target: 101,
    source: "ML v2, test", ref: 100, prev: 100, outcome: 101, ...rest,
  };
}

/** n calls, `right` of them right. Directions alternate so that "always up" scores about 50 %, like the naive strategies. */
function series(n: number, right: number, hourUtc = 0) {
  return Array.from({ length: n }, (_, i) => {
    const direction = i % 2 ? ("down" as const) : ("up" as const);
    const ok = i < right;
    const rises = (direction === "up") === ok;
    return entry(i, { hourUtc, direction, outcome: rises ? 101 : 99, prev: i % 3 ? 99 : 101 });
  });
}

describe("signalFrom", () => {
  it("has nothing to say before any forecast is judged", () => {
    expect(signalFrom(undefined).level).toBe("none");
    expect(signalFrom(computeStats([], () => 0)).level).toBe("none");
  });

  it("only observes until enough forecasts were judged, whatever the score", () => {
    const s = signalFrom(computeStats(series(50, 50), () => 0));
    expect(s.level).toBe("watching");
    expect(s.label).toContain(`50 / ${MIN_JUDGED}`);
  });

  it("validates only a clear, positive edge after the spread", () => {
    const strong = computeStats(series(300, 210), () => 0); // 70 % right, no spread
    expect(signalFrom(strong).level).toBe("validated");
    const spreadEats = computeStats(series(300, 210), () => 200); // 2 % of the price per call: eats everything
    expect(signalFrom(spreadEats)).toMatchObject({ level: "unproven", label: "Non validé" });
    expect(signalFrom(spreadEats).detail).toMatch(/spread/);
  });

  it("does not validate a score that chance explains, and flags a clearly bad one", () => {
    expect(signalFrom(computeStats(series(300, 155), () => 0)).level).toBe("unproven");
    expect(signalFrom(computeStats(series(300, 110), () => 0)).level).toBe("avoid");
  });
});

describe("stats by moment of the day", () => {
  it("groups intraday calls by UTC session and ignores daily ones", () => {
    const entries = [
      ...series(25, 25, 3), // Asia: all right
      ...series(25, 0, 10).map((e) => ({ ...e, id: "e" + e.id })), // Europe: all wrong
      { ...entry(900, { hourUtc: 15 }), resolution: "DAY", resMinutes: 1440 }, // daily: ignored
    ];
    const st = computeStats(entries, () => 0);
    expect(st.bySession.asia.hit).toMatchObject({ hits: 25, samples: 25 });
    expect(st.bySession.europe.hit).toMatchObject({ hits: 0, samples: 25 });
    expect(st.bySession.us.hit.samples).toBe(0);
    expect(st.bySession.asia.netReturnPct).toBeGreaterThan(0);
    expect(st.bySession.europe.netReturnPct).toBeLessThan(0);
  });
});
