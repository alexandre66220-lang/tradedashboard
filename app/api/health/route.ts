import { NextResponse } from "next/server";
import { handleError } from "@/lib/http";
import { healthReport, type HealthReport } from "@/lib/health";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// A report is kept half a minute: opening the panel several times must not call every service each time.
const TTL_MS = 30_000;
let cache: { at: number; value: Promise<HealthReport> } | null = null;

export async function GET() {
  try {
    if (!cache || Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), value: healthReport() };
    return NextResponse.json(await cache.value, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    cache = null;
    return handleError(err);
  }
}
