import "server-only";
import { type CalendarEvent, FeedFormatError, parseFeed } from "./calendar";

const DEFAULT_FEED = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const TTL_MS = 30 * 60_000; // the feed is rate limited: refresh at most twice an hour
const FAILURE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;

export interface CalendarSnapshot {
  events: CalendarEvent[];
  updatedAt: number;
  /** The data is older than expected because the last refresh failed */
  stale: boolean;
}

let good: { at: number; events: CalendarEvent[] } | null = null;
let failedAt = 0;
let inflight: Promise<CalendarSnapshot> | null = null;

export function __resetCalendarCache() {
  good = null;
  failedAt = 0;
  inflight = null;
}

async function fetchFeed(url: string): Promise<CalendarEvent[]> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`calendar feed returned ${res.status}`);
  return parseFeed(await res.json());
}

async function refresh(): Promise<CalendarSnapshot> {
  const base = process.env.CALENDAR_FEED_URL || DEFAULT_FEED;
  try {
    const events = await fetchFeed(base);
    // Next week's feed only exists from late in the week: best effort, to see Monday's announcements on a Sunday
    if (base.includes("thisweek")) {
      events.push(...(await fetchFeed(base.replace("thisweek", "nextweek")).catch(() => [] as CalendarEvent[])));
    }
    good = { at: Date.now(), events: events.sort((a, b) => a.time - b.time) };
    failedAt = 0;
    return { events: good.events, updatedAt: good.at, stale: false };
  } catch (err) {
    failedAt = Date.now();
    console.warn("[calendar] refresh failed:", err instanceof FeedFormatError || err instanceof Error ? err.message : "unknown");
    if (good) return { events: good.events, updatedAt: good.at, stale: true };
    throw err;
  }
}

/** Cached calendar; serves the last good copy if the source fails. Throws only when nothing was ever fetched. */
export async function getCalendar(): Promise<CalendarSnapshot> {
  const now = Date.now();
  if (good && now - good.at < TTL_MS) return { events: good.events, updatedAt: good.at, stale: false };
  if (good && failedAt && now - failedAt < FAILURE_TTL_MS) return { events: good.events, updatedAt: good.at, stale: true };
  if (!good && failedAt && now - failedAt < FAILURE_TTL_MS) throw new Error("calendar unavailable");
  return (inflight ??= refresh().finally(() => (inflight = null)));
}
