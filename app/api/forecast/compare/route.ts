import { NextResponse } from "next/server";
import { RESOLUTIONS } from "@/config/instruments";
import { getCandles } from "@/lib/capital";
import { CompareUnavailable, compareModels } from "@/lib/forecast/compare";
import { handleError, jsonError, parseCommon } from "@/lib/http";

export const dynamic = "force-dynamic";
// Scores several versions of the ML model one after the other.
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
    const variants = await compareModels({
      epic: p.instrument.epic,
      resolution: p.api,
      resolutionMinutes: RESOLUTIONS[p.resolution].minutes,
      horizon,
      candles,
    });
    return NextResponse.json({ variants }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof CompareUnavailable) return jsonError("NOT_CONFIGURED", err.message, 501);
    if (err instanceof Error && (err.name === "TimeoutError" || err.message.startsWith("external forecast service"))) {
      return jsonError("MODEL_UNAVAILABLE", "Le service de prévision n’a pas pu comparer les versions du modèle.", 502);
    }
    return handleError(err);
  }
}
