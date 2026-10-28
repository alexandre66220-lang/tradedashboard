// Trading sessions from the real opening hours of the three big cash markets, in their own time zones. Daylight saving
// time is handled by the time zone database (Intl), not by a fixed UTC hour: Europe and the United States change clocks
// on different dates, so for a week or two the Paris / New York gap is not the usual one.
// Holidays are not known here (the broker's market status tells when a market is closed).

export type MarketKey = "tokyo" | "london" | "newyork";

export interface Market {
  key: MarketKey;
  label: string;
  /** IANA time zone */
  zone: string;
  /** Local opening and closing time, minutes after midnight */
  open: number;
  close: number;
}

export const MARKETS: Market[] = [
  { key: "tokyo", label: "Tokyo", zone: "Asia/Tokyo", open: 9 * 60, close: 15 * 60 + 30 },
  { key: "london", label: "Londres", zone: "Europe/London", open: 8 * 60, close: 16 * 60 + 30 },
  { key: "newyork", label: "New York", zone: "America/New_York", open: 9 * 60 + 30, close: 16 * 60 },
];

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(zone, f);
  }
  return f;
}

/** Local weekday (0 = Sunday) and minutes after midnight in a time zone. */
function local(ms: number, zone: string): { weekday: number; minutes: number } {
  let weekday = 0, h = 0, m = 0;
  for (const p of formatter(zone).formatToParts(new Date(ms))) {
    if (p.type === "weekday") weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.value);
    else if (p.type === "hour") h = Number(p.value);
    else if (p.type === "minute") m = Number(p.value);
  }
  return { weekday, minutes: h * 60 + m };
}

export function isOpen(market: Market, ms: number): boolean {
  const { weekday, minutes } = local(ms, market.zone);
  return weekday >= 1 && weekday <= 5 && minutes >= market.open && minutes < market.close;
}

export type SessionKey = "asia" | "europe" | "overlap" | "us" | "night";

/**
 * The session a moment belongs to: Tokyo alone, London alone, the London / New York overlap (the most liquid hours),
 * New York alone, or none of them (night, weekend).
 */
export function sessionAt(ms: number): SessionKey {
  const london = isOpen(MARKETS[1], ms);
  const ny = isOpen(MARKETS[2], ms);
  if (london && ny) return "overlap";
  if (london) return "europe";
  if (ny) return "us";
  return isOpen(MARKETS[0], ms) ? "asia" : "night";
}

/** Offset of a time zone from UTC at a moment, in minutes. */
export function utcOffsetMinutes(zone: string, ms: number): number {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return Math.round((Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute) - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** Gap between Paris and New York clocks, in hours. */
export const parisNewYorkGap = (ms: number) => (utcOffsetMinutes("Europe/Paris", ms) - utcOffsetMinutes("America/New_York", ms)) / 60;

/** The next day (within `days`) on which the Paris / New York gap changes, with the new gap; null when it does not change. */
export function nextGapChange(ms: number, days = 21): { at: number; gap: number } | null {
  const now = parisNewYorkGap(ms);
  for (let d = 1; d <= days; d++) {
    const t = ms + d * 86_400_000;
    const gap = parisNewYorkGap(t);
    if (gap !== now) {
      // narrow down to the hour
      let lo = t - 86_400_000, hi = t;
      while (hi - lo > 3_600_000) {
        const mid = Math.floor((lo + hi) / 2);
        if (parisNewYorkGap(mid) === now) lo = mid;
        else hi = mid;
      }
      return { at: hi, gap };
    }
  }
  return null;
}

/** The next moment (within a week) at which a market opens or closes, found by stepping through time. */
export function nextChange(market: Market, ms: number): { at: number; opens: boolean } | null {
  const now = isOpen(market, ms);
  const step = 5 * 60_000;
  const start = Math.floor(ms / step) * step;
  for (let t = start + step; t <= start + 8 * 86_400_000; t += step) {
    if (isOpen(market, t) !== now) return { at: t, opens: !now };
  }
  return null;
}
