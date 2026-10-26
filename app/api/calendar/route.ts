import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getCalendar } from "@/lib/calendar-source";

export const dynamic = "force-dynamic";

const PAST_S = 6 * 3600;
const AHEAD_S = 7 * 24 * 3600;

export async function GET() {
  try {
    const cal = await getCalendar();
    const now = Math.floor(Date.now() / 1000);
    // Medium and high impact only, from 6 h ago to 7 days ahead; the page filters per instrument
    const events = cal.events.filter((e) => e.impact !== "low" && e.time >= now - PAST_S && e.time <= now + AHEAD_S);
    return NextResponse.json({ events, updatedAt: cal.updatedAt, stale: cal.stale }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return jsonError("CALENDAR_UNAVAILABLE", "Calendrier économique indisponible pour le moment.", 502);
  }
}
