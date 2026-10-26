export type NewsImpact = "high" | "medium" | "low";

export interface CalendarEvent {
  id: string;
  title: string;
  /** Currency / region code as given by the feed, e.g. "USD" */
  currency: string;
  /** UTC seconds */
  time: number;
  impact: NewsImpact;
  forecast?: string;
  previous?: string;
}

const IMPACTS: Record<string, NewsImpact> = { high: "high", medium: "medium", low: "low" };

export class FeedFormatError extends Error {}

/**
 * Reads a ForexFactory-style weekly feed (an array of { title, country, date, impact, forecast, previous }).
 * Malformed rows are skipped. If a sizeable feed yields nothing usable, the format is unexpected: throw rather
 * than let the dashboard claim "no announcement".
 */
export function parseFeed(json: unknown): CalendarEvent[] {
  if (!Array.isArray(json)) throw new FeedFormatError("calendar feed is not a list");
  const out: CalendarEvent[] = [];
  for (const raw of json) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r.title !== "string" || typeof r.country !== "string" || typeof r.date !== "string") continue;
    const impact = IMPACTS[String(r.impact ?? "").toLowerCase()];
    if (!impact) continue; // holidays and unknown levels
    // An explicit UTC offset is required: guessing a timezone would shift every announcement
    if (!/(Z|[+-]\d\d:?\d\d)$/.test(r.date)) continue;
    const ms = Date.parse(r.date);
    if (!Number.isFinite(ms)) continue;
    const time = Math.floor(ms / 1000);
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : undefined);
    out.push({
      id: `${time}|${r.country}|${r.title}`.slice(0, 160),
      title: r.title.trim().slice(0, 120),
      currency: r.country.trim().toUpperCase().slice(0, 8),
      time,
      impact,
      forecast: str(r.forecast),
      previous: str(r.previous),
    });
  }
  if (json.length >= 10 && out.length === 0) throw new FeedFormatError("calendar feed has an unexpected format");
  return out.sort((a, b) => a.time - b.time);
}

export interface NewsProfile {
  /** Currencies whose announcements move this instrument (default: USD) */
  newsCurrencies?: string[];
  /** Titles containing one of these words count as high impact for this instrument */
  newsKeywords?: string[];
}

export interface RelevantEvent extends CalendarEvent {
  /** Negative when the announcement has already happened */
  minutesFromNow: number;
}

/** Announcements that matter for an instrument, between `fromMin` (past, negative) and `toMin` minutes from now. */
export function relevantEvents(events: CalendarEvent[], profile: NewsProfile, nowSec: number, fromMin: number, toMin: number): RelevantEvent[] {
  const currencies = (profile.newsCurrencies ?? ["USD"]).map((c) => c.toUpperCase());
  const words = (profile.newsKeywords ?? []).map((w) => w.toLowerCase());
  const out: RelevantEvent[] = [];
  for (const e of events) {
    const minutesFromNow = (e.time - nowSec) / 60;
    if (minutesFromNow < fromMin || minutesFromNow > toMin) continue;
    const keyword = words.some((w) => e.title.toLowerCase().includes(w));
    if (!currencies.includes(e.currency) && !keyword) continue;
    if (e.impact === "low" && !keyword) continue;
    out.push({ ...e, impact: keyword && e.impact !== "high" ? "high" : e.impact, minutesFromNow });
  }
  return out;
}

/** Formats a delay like "dans 25 min", "dans 3 h 10", "demain 14:30". */
export function countdown(minutes: number): string {
  const m = Math.round(Math.abs(minutes));
  const h = Math.floor(m / 60), r = m % 60;
  const span = h >= 24 ? `${Math.floor(h / 24)} j` : h > 0 ? `${h} h${r ? ` ${String(r).padStart(2, "0")}` : ""}` : `${m} min`;
  return minutes >= 0 ? `dans ${span}` : `il y a ${span}`;
}
