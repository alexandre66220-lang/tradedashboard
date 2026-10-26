import { describe, expect, it } from "vitest";
import { toCandles } from "@/lib/capital";

describe("toCandles", () => {
  it("parses Capital.com prices as UTC mid candles, sorted and deduplicated", () => {
    const p = (bid: number) => ({ bid, ask: bid + 0.3 });
    const candles = toCandles([
      { snapshotTimeUTC: "2024-05-01T10:05:00", openPrice: p(2), closePrice: p(3), highPrice: p(4), lowPrice: p(1) },
      { snapshotTimeUTC: "2024-05-01T10:00:00", openPrice: p(1), closePrice: p(2), highPrice: p(3), lowPrice: p(0) },
      { snapshotTimeUTC: "2024-05-01T10:05:00", openPrice: p(2), closePrice: p(5), highPrice: p(6), lowPrice: p(1) },
    ]);
    expect(candles.map((c) => c.time)).toEqual([Date.UTC(2024, 4, 1, 10, 0) / 1000, Date.UTC(2024, 4, 1, 10, 5) / 1000]);
    expect(candles[0].close).toBeCloseTo(2.15);
    expect(candles[1].close).toBeCloseTo(5.15);
  });
});
