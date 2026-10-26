import { after, NextResponse } from "next/server";
import { RESOLUTIONS } from "@/config/instruments";
import { getCandles } from "@/lib/capital";
import { runForecast } from "@/lib/forecast";
import { handleError, jsonError, parseCommon } from "@/lib/http";
import { recordSafe } from "@/lib/journal/service";

export const dynamic = "force-dynamic";
// An external ML model may need a few seconds (cold start + training).
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = parseCommon(url);
  if (!p.ok) return p.response;
  const horizon = Number(url.searchParams.get("horizon") ?? p.instrument.defaultHorizon);
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 24 * 60) {
    return jsonError("BAD_REQUEST", "Horizon invalide (1 à 1440 minutes).", 400);
  }
  try {
    const candles = await getCandles(p.instrument.epic, p.api);
    const result = await runForecast({
      epic: p.instrument.epic,
      resolution: p.api,
      resolutionMinutes: RESOLUTIONS[p.resolution].minutes,
      horizon,
      candles,
    });
    const series = { epic: p.instrument.epic, resolution: p.api, resMinutes: RESOLUTIONS[p.resolution].minutes, horizon };
    after(() => recordSafe(series, candles, result));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
