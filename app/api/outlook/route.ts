import { NextResponse } from "next/server";
import { handleError } from "@/lib/http";
import { readStored } from "@/lib/outlook";
import type { OutlookResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

// Reads the forecasts already computed (kept 30 min in the shared store); the missing ones are asked for one by one
// through /api/outlook/cell. A complete outlook is also kept a minute in memory.
const OUTLOOK_TTL_MS = 60_000;

let cache: { at: number; value: OutlookResponse } | null = null;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < OUTLOOK_TTL_MS) return NextResponse.json(cache.value, { headers: { "Cache-Control": "no-store" } });
    const value = await readStored();
    if (!value.pending) cache = { at: Date.now(), value };
    return NextResponse.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
