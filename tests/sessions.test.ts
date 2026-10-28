import { describe, expect, it } from "vitest";
import { MARKETS, isOpen, nextChange, nextGapChange, parisNewYorkGap, sessionAt, utcOffsetMinutes } from "@/lib/sessions";

const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe("sessions follow the real opening hours", () => {
  it("in summer (London BST, New York EDT): London 07:00 UTC, New York 13:30 UTC", () => {
    expect(sessionAt(utc(2026, 7, 8, 6, 59))).toBe("night");
    expect(sessionAt(utc(2026, 7, 8, 7, 0))).toBe("europe");
    expect(sessionAt(utc(2026, 7, 8, 13, 29))).toBe("europe");
    expect(sessionAt(utc(2026, 7, 8, 13, 30))).toBe("overlap");
    expect(sessionAt(utc(2026, 7, 8, 15, 29))).toBe("overlap");
    expect(sessionAt(utc(2026, 7, 8, 15, 30))).toBe("us");
    expect(sessionAt(utc(2026, 7, 8, 19, 59))).toBe("us");
    expect(sessionAt(utc(2026, 7, 8, 20, 0))).toBe("night");
  });

  it("in winter (GMT, EST): London 08:00 UTC, New York 14:30 UTC", () => {
    expect(sessionAt(utc(2026, 1, 14, 7, 30))).toBe("night");
    expect(sessionAt(utc(2026, 1, 14, 8, 0))).toBe("europe");
    expect(sessionAt(utc(2026, 1, 14, 14, 29))).toBe("europe");
    expect(sessionAt(utc(2026, 1, 14, 14, 30))).toBe("overlap");
    expect(sessionAt(utc(2026, 1, 14, 21, 0))).toBe("night");
  });

  it("in the weeks when Europe is on winter time and the United States still on summer time", () => {
    // 28 Oct 2026: London is on GMT since 25 Oct, New York on EDT until 1 Nov
    expect(sessionAt(utc(2026, 10, 28, 13, 29))).toBe("europe");
    expect(sessionAt(utc(2026, 10, 28, 13, 30))).toBe("overlap"); // not 14:30
    expect(sessionAt(utc(2026, 10, 28, 16, 30))).toBe("us");
    expect(parisNewYorkGap(utc(2026, 10, 28, 12))).toBe(5);
    expect(parisNewYorkGap(utc(2026, 11, 3, 12))).toBe(6);
  });

  it("Tokyo alone is Asia, and weekends have no session", () => {
    expect(sessionAt(utc(2026, 10, 28, 1, 0))).toBe("asia"); // 10:00 in Tokyo
    expect(sessionAt(utc(2026, 10, 28, 6, 30))).toBe("night"); // Tokyo closed at 15:30 local, London not open yet
    expect(sessionAt(utc(2026, 10, 31, 15, 0))).toBe("night"); // Saturday
    expect(sessionAt(utc(2026, 11, 1, 15, 0))).toBe("night"); // Sunday
  });

  it("knows each market on its own", () => {
    const [tokyo, london, ny] = MARKETS;
    const t = utc(2026, 10, 28, 14, 0);
    expect([isOpen(tokyo, t), isOpen(london, t), isOpen(ny, t)]).toEqual([false, true, true]);
  });
});

describe("clock changes", () => {
  it("computes offsets with daylight saving time", () => {
    expect(utcOffsetMinutes("Europe/Paris", utc(2026, 7, 1, 12))).toBe(120);
    expect(utcOffsetMinutes("Europe/Paris", utc(2026, 1, 1, 12))).toBe(60);
    expect(utcOffsetMinutes("America/New_York", utc(2026, 7, 1, 12))).toBe(-240);
    expect(utcOffsetMinutes("America/New_York", utc(2026, 12, 1, 12))).toBe(-300);
    expect(utcOffsetMinutes("Asia/Tokyo", utc(2026, 7, 1, 12))).toBe(540);
  });

  it("announces the next change of the Paris / New York gap", () => {
    const c = nextGapChange(utc(2026, 10, 27, 12))!;
    expect(c.gap).toBe(6);
    expect(new Date(c.at).toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(nextGapChange(utc(2026, 7, 1, 12), 20)).toBeNull();
  });

  it("finds when a market next opens or closes", () => {
    const n = nextChange(MARKETS[1], utc(2026, 10, 28, 17, 0))!; // London closed, opens next morning 08:00 UTC
    expect(n).toEqual({ at: utc(2026, 10, 29, 8, 0), opens: true });
    const c = nextChange(MARKETS[2], utc(2026, 10, 28, 15, 0))!; // New York open, closes 16:00 EDT = 20:00 UTC
    expect(c).toEqual({ at: utc(2026, 10, 28, 20, 0), opens: false });
    expect(nextChange(MARKETS[1], utc(2026, 10, 30, 17, 0))!.at).toBe(utc(2026, 11, 2, 8, 0)); // over the weekend
  });
});
