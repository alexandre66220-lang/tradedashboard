import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countdown, FeedFormatError, parseFeed, relevantEvents } from "@/lib/calendar";
import { __resetCalendarCache, getCalendar } from "@/lib/calendar-source";

const row = (o: object = {}) => ({ title: "CPI m/m", country: "USD", date: "2026-10-27T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.4%", ...o });
const T = Date.parse("2026-10-27T12:30:00Z") / 1000; // 08:30 New York = 12:30 UTC

describe("parseFeed", () => {
  it("converts offsets to UTC seconds and keeps forecast / previous", () => {
    const [e] = parseFeed([row()]);
    expect(e).toMatchObject({ title: "CPI m/m", currency: "USD", time: T, impact: "high", forecast: "0.3%", previous: "0.4%" });
  });

  it("skips malformed rows, holidays and dates without an explicit offset", () => {
    const ok = parseFeed([
      row(),
      row({ impact: "Holiday" }),
      row({ date: "2026-10-27T08:30:00" }), // no offset: refuse to guess the timezone
      row({ date: "garbage" }),
      row({ title: 5 }),
      null,
      row({ impact: "Low", title: "Minor" }),
      row({ forecast: "", previous: undefined }),
    ]);
    expect(ok.map((e) => e.title)).toEqual(["CPI m/m", "Minor", "CPI m/m"]);
    expect(ok[2].forecast).toBeUndefined();
  });

  it("sorts by time and rejects an unexpected format instead of reporting no announcement", () => {
    const sorted = parseFeed([row({ date: "2026-10-28T08:30:00-04:00" }), row()]);
    expect(sorted[0].time).toBeLessThan(sorted[1].time);
    expect(() => parseFeed({ events: [] })).toThrow(FeedFormatError);
    expect(() => parseFeed(Array.from({ length: 12 }, () => ({ foo: "bar" })))).toThrow(FeedFormatError);
    expect(parseFeed([])).toEqual([]); // an empty week is not an error
  });
});

describe("relevantEvents", () => {
  const events = parseFeed([
    row({ title: "CPI m/m" }),
    row({ title: "Crude Oil Inventories", impact: "Medium", date: "2026-10-27T10:30:00-04:00" }),
    row({ title: "German Ifo", country: "EUR", date: "2026-10-27T04:00:00-04:00" }),
    row({ title: "Minor data", impact: "Low", date: "2026-10-27T09:00:00-04:00" }),
  ]);

  it("keeps the instrument's currencies and window, and drops low impact", () => {
    const r = relevantEvents(events, {}, T - 20 * 60, -60, 180);
    expect(r.map((e) => e.title)).toEqual(["CPI m/m", "Crude Oil Inventories"]);
    expect(r[0].minutesFromNow).toBeCloseTo(20);
    expect(relevantEvents(events, {}, T - 20 * 60, -60, 120).map((e) => e.title)).toEqual(["CPI m/m"]); // oil inventories are 140 min away
    expect(relevantEvents(events, {}, T - 20 * 60, -60, 10)).toEqual([]);
  });

  it("promotes keyword matches to high impact and accepts other currencies", () => {
    const r = relevantEvents(events, { newsCurrencies: ["EUR"], newsKeywords: ["crude oil"] }, T - 3600, -600, 600);
    // the USD CPI is dropped (wrong currency, no keyword); the USD oil report comes in through its keyword, as high impact
    expect(r.map((e) => [e.title, e.impact])).toEqual([
      ["German Ifo", "high"],
      ["Crude Oil Inventories", "high"],
    ]);
  });
});

describe("countdown", () => {
  it("formats minutes, hours and days", () => {
    expect(countdown(25)).toBe("dans 25 min");
    expect(countdown(190)).toBe("dans 3 h 10");
    expect(countdown(120)).toBe("dans 2 h");
    expect(countdown(-45)).toBe("il y a 45 min");
    expect(countdown(60 * 50)).toBe("dans 2 j");
  });
});

describe("calendar source", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
    process.env.CALENDAR_FEED_URL = "http://cal.test/ff_calendar_thisweek.json";
    __resetCalendarCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.CALENDAR_FEED_URL;
  });
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it("caches for 30 minutes and tolerates a missing next-week feed", async () => {
    const f = vi.fn(async (url: string) => (url.includes("nextweek") ? { ok: false, status: 404, json: async () => ({}) } : ok([row()])));
    vi.stubGlobal("fetch", f);
    const a = await getCalendar();
    expect(a.events).toHaveLength(1);
    await getCalendar();
    expect(f).toHaveBeenCalledTimes(2); // this week + next week, once
    vi.setSystemTime(new Date("2026-10-27T00:31:00Z"));
    await getCalendar();
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("serves the last good copy when the source fails, and backs off", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = false;
    const f = vi.fn(async () => (fail ? { ok: false, status: 429, json: async () => ({}) } : ok([row()])));
    vi.stubGlobal("fetch", f);
    await getCalendar();
    fail = true;
    vi.setSystemTime(new Date("2026-10-27T00:40:00Z"));
    const stale = await getCalendar();
    expect(stale.stale).toBe(true);
    expect(stale.events).toHaveLength(2); // this week + next week, both served by the stub
    const calls = f.mock.calls.length;
    vi.setSystemTime(new Date("2026-10-27T00:45:00Z")); // inside the 10 min back-off
    await getCalendar();
    expect(f.mock.calls.length).toBe(calls);
  });

  it("throws when nothing was ever fetched", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(getCalendar()).rejects.toThrow();
    await expect(getCalendar()).rejects.toThrow("unavailable"); // back-off, no new request
  });
});
