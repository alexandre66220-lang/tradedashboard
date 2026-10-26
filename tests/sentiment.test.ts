import { describe, expect, it } from "vitest";
import { parseSentiment } from "@/lib/capital";
import { computeStats, crowdRelation } from "@/lib/journal/journal";
import type { JournalEntry } from "@/lib/journal/types";

describe("parseSentiment", () => {
  it("reads the documented shape and is case-insensitive on the market id", () => {
    const r = parseSentiment({ clientSentiments: [{ marketId: "gold", longPositionPercentage: 72.5, shortPositionPercentage: 27.5 }] });
    expect(r.GOLD.long).toBeCloseTo(72.5);
    expect(r.GOLD.short).toBeCloseTo(27.5);
  });

  it("skips rows it cannot trust instead of guessing", () => {
    const r = parseSentiment({
      clientSentiments: [
        { marketId: "A", longPositionPercentage: "x", shortPositionPercentage: 10 },
        { marketId: "B", longPositionPercentage: 60, shortPositionPercentage: 10 }, // does not add up to 100
        { marketId: "C", longPositionPercentage: -5, shortPositionPercentage: 105 },
        { longPositionPercentage: 50, shortPositionPercentage: 50 }, // no id
        { marketId: "D", longPositionPercentage: 30, shortPositionPercentage: 70 },
        null,
      ],
    });
    expect(Object.keys(r)).toEqual(["D"]);
    expect(parseSentiment(null)).toEqual({});
    expect(parseSentiment({ clientSentiments: "no" })).toEqual({});
    expect(parseSentiment({})).toEqual({});
  });

  it("normalises sums that are slightly off", () => {
    const r = parseSentiment({ clientSentiments: [{ marketId: "X", longPositionPercentage: 50.5, shortPositionPercentage: 50 }] });
    expect(r.X.long + r.X.short).toBeCloseTo(100);
  });
});

describe("crowdRelation", () => {
  it("only gives the crowd a side from 60 % on one side", () => {
    expect(crowdRelation("up", 72)).toBe("with");
    expect(crowdRelation("down", 72)).toBe("against");
    expect(crowdRelation("up", 30)).toBe("against");
    expect(crowdRelation("down", 30)).toBe("with");
    expect(crowdRelation("up", 55)).toBe("neutral");
    expect(crowdRelation("up", 60)).toBe("with");
    expect(crowdRelation("down", 40)).toBe("with");
    expect(crowdRelation("flat", 90)).toBe("neutral");
  });
});

describe("journal stats by sentiment", () => {
  const mk = (i: number, direction: "up" | "down", sentiment: number | undefined, outcome: number): JournalEntry => ({
    id: String(i), epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30, steps: 6, t: i, recordedAt: i, price: 100, direction, confidence: 0.6, target: 100,
    source: "ML", ref: 100, prev: 100, outcome, ...(sentiment !== undefined ? { sentiment } : {}),
  });

  it("splits hit rates by relation to the crowd and ignores entries without sentiment", () => {
    const entries = [
      ...Array.from({ length: 20 }, (_, i) => mk(i, "up", 70, 101)), // with the crowd, right
      ...Array.from({ length: 20 }, (_, i) => mk(100 + i, "down", 70, 101)), // against the crowd, wrong
      ...Array.from({ length: 3 }, (_, i) => mk(200 + i, "up", 50, 101)), // neutral crowd
      mk(300, "up", undefined, 101), // recorded before sentiment existed
    ];
    const st = computeStats(entries, () => 0);
    expect(st.bySentiment.with).toMatchObject({ hits: 20, samples: 20, hitRate: 1 });
    expect(st.bySentiment.against).toMatchObject({ hits: 0, samples: 20, hitRate: 0 });
    expect(st.bySentiment.neutral).toMatchObject({ samples: 3, hitRate: null });
    expect(st.evaluated).toBe(44);
  });
});
