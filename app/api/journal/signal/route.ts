import { NextResponse } from "next/server";
import { RESOLUTIONS } from "@/config/instruments";
import { handleError, jsonError, parseCommon } from "@/lib/http";
import { signalFor } from "@/lib/journal/service";

export const dynamic = "force-dynamic";

/** GET /api/journal/signal?epic=GOLD&resolution=5&horizon=30&source=ML%20v2…: is this forecast series proven in live conditions? */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = parseCommon(url);
  if (!p.ok) return p.response;
  const horizon = Number(url.searchParams.get("horizon") ?? p.instrument.defaultHorizon);
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 24 * 60) return jsonError("BAD_REQUEST", "Horizon invalide (1 à 1440 minutes).", 400);
  try {
    const conf = Number(url.searchParams.get("confidence"));
    const vol = url.searchParams.get("vol");
    const trend = url.searchParams.get("trend");
    const status = await signalFor(p.instrument.epic, RESOLUTIONS[p.resolution].api, horizon, url.searchParams.get("source") ?? undefined, {
      ...(conf >= 0.5 && conf <= 1 ? { confidence: conf } : {}),
      ...(vol === "calm" || vol === "normal" || vol === "wild" ? { vol } : {}),
      ...(trend === "trend" || trend === "range" ? { trend } : {}),
    });
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
