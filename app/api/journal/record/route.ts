import { NextResponse } from "next/server";
import { INSTRUMENTS, OUTLOOKS } from "@/config/instruments";
import { timingSafeEqualStr } from "@/lib/auth";
import { getCandles } from "@/lib/capital";
import { runForecast } from "@/lib/forecast";
import { handleError, jsonError } from "@/lib/http";
import { recordSafe } from "@/lib/journal/service";
import { getStorage } from "@/lib/journal/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Called by Vercel Cron (see vercel.json), which sends `Authorization: Bearer $CRON_SECRET`.
 * This path bypasses the dashboard cookie in proxy.ts, so it must check the secret itself and fail closed.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return jsonError("CONFIG_MISSING", "CRON_SECRET n'est pas défini côté serveur.", 503);
  if (!timingSafeEqualStr(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return jsonError("UNAUTHORIZED", "Authentification requise.", 401);
  }
  if (!getStorage()) return NextResponse.json({ recorded: 0, note: "journal non configuré" });

  try {
    // Per instrument: the default intraday forecast, plus the daily and weekly outlooks
    const jobs = INSTRUMENTS.flatMap((inst) => [
      { epic: inst.epic, resolution: "MINUTE_5", resMinutes: 5, horizon: inst.defaultHorizon },
      ...OUTLOOKS.map((o) => ({ epic: inst.epic, resolution: o.api, resMinutes: o.minutes, horizon: o.minutes })),
    ]);
    const results = await Promise.allSettled(
      jobs.map(async (series) => {
        const candles = await getCandles(series.epic, series.resolution, 1000, 60_000);
        const forecast = await runForecast({
          epic: series.epic,
          resolution: series.resolution,
          resolutionMinutes: series.resMinutes,
          horizon: series.horizon,
          candles,
        });
        await recordSafe(series, candles, forecast);
      }),
    );
    return NextResponse.json(
      { jobs: jobs.length, failed: results.filter((r) => r.status === "rejected").length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleError(err);
  }
}
