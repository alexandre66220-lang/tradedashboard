import { NextResponse } from "next/server";
import { CapitalError } from "@/lib/capital";
import { handleError, jsonError } from "@/lib/http";
import { computeCell, findOutlook } from "@/lib/outlook";

export const dynamic = "force-dynamic";
// One model run, possibly on a cold start.
export const maxDuration = 60;

/** GET /api/outlook/cell?epic=GOLD&key=day: computes (or reads) one daily / weekly forecast and stores it. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const found = findOutlook(url.searchParams.get("epic") ?? "", url.searchParams.get("key") ?? "");
  if (!found) return jsonError("BAD_REQUEST", "Instrument ou horizon inconnu.", 400);
  try {
    const stored = await computeCell(found.inst, found.o);
    return NextResponse.json(stored, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof CapitalError) return handleError(err);
    console.warn("[outlook] forecast failed:", err instanceof Error ? err.message : "unknown");
    return jsonError("FORECAST_FAILED", "Prévision indisponible pour le moment.", 502);
  }
}
