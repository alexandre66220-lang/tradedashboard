import { NextResponse } from "next/server";
import { handleError } from "@/lib/http";
import { buildOutlook } from "@/lib/outlook";
import type { OutlookResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
// An external ML model may need a few seconds (cold start + training).
export const maxDuration = 60;

// A complete outlook is kept a minute in memory; each forecast is also kept half an hour in the shared store (lib/outlook.ts).
const OUTLOOK_TTL_MS = 60_000;

let cache: { at: number; value: OutlookResponse } | null = null;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < OUTLOOK_TTL_MS) return NextResponse.json(cache.value, { headers: { "Cache-Control": "no-store" } });
    const value = await buildOutlook();
    // Keep partial results out of the cache so that the next poll fills in the missing ones.
    const complete = !value.pending && value.items.every((i) => Object.values(i.horizons).every((h) => !("error" in h)));
    if (complete) cache = { at: Date.now(), value };
    return NextResponse.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
