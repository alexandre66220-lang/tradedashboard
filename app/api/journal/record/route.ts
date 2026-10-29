import { NextResponse } from "next/server";
import { INSTRUMENTS } from "@/config/instruments";
import { timingSafeEqualStr } from "@/lib/auth";
import { getCandles } from "@/lib/capital";
import { runForecast } from "@/lib/forecast";
import { handleError, jsonError } from "@/lib/http";
import { buildOutlook, computeCell, findOutlook } from "@/lib/outlook";
import { OUTLOOKS } from "@/config/instruments";
import { recordSafe } from "@/lib/journal/service";
import { getStorage } from "@/lib/journal/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Job {
  epic: string;
  resolution: string;
  resMinutes: number;
  horizon: number;
}

async function recordOne(series: Job): Promise<void> {
  const candles = await getCandles(series.epic, series.resolution, 1000, 60_000);
  const forecast = await runForecast({
    epic: series.epic,
    resolution: series.resolution,
    resolutionMinutes: series.resMinutes,
    horizon: series.horizon,
    candles,
  });
  await recordSafe(series, candles, forecast);
}

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

  // ?scope=intraday: only the short forecasts (every 30 min); ?scope=daily: only the daily and weekly outlooks (once a day,
  // they cannot change faster, and each one costs a model run); no scope: everything.
  const params = new URL(req.url).searchParams;
  const scope = params.get("scope");

  // ?plan=intraday|daily: the list of single calls that make up a run, for the Netlify background function. Recording
  // everything in one request takes longer than the 30 s a request may last there, so it asks for one forecast at a time.
  const plan = params.get("plan");
  if (plan === "intraday" || plan === "daily") {
    const calls =
      plan === "intraday"
        ? INSTRUMENTS.map((i) => `scope=intraday&epic=${i.epic}`)
        : INSTRUMENTS.flatMap((i) => OUTLOOKS.map((o) => `scope=daily&epic=${i.epic}&key=${o.key}`));
    return NextResponse.json({ calls }, { headers: { "Cache-Control": "no-store" } });
  }

  // One forecast: ?scope=intraday&epic=GOLD, or ?scope=daily&epic=GOLD&key=day (the model run records it in the journal)
  const epic = params.get("epic");
  if (epic) {
    try {
      if (scope === "daily") {
        const found = findOutlook(epic, params.get("key") ?? "");
        if (!found) return jsonError("BAD_REQUEST", "Instrument ou horizon inconnu.", 400);
        await computeCell(found.inst, found.o);
        return NextResponse.json({ recorded: 1, epic, key: found.o.key }, { headers: { "Cache-Control": "no-store" } });
      }
      const inst = INSTRUMENTS.find((i) => i.epic === epic);
      if (!inst) return jsonError("BAD_REQUEST", "Instrument inconnu.", 400);
      await recordOne({ epic: inst.epic, resolution: "MINUTE_5", resMinutes: 5, horizon: inst.defaultHorizon });
      return NextResponse.json({ recorded: 1, epic }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      return handleError(err);
    }
  }

  try {
    // Per instrument: the default intraday forecast. The daily and weekly outlooks are computed (and recorded) by buildOutlook.
    const jobs = scope === "daily" ? [] : INSTRUMENTS.map((inst) => ({ epic: inst.epic, resolution: "MINUTE_5", resMinutes: 5, horizon: inst.defaultHorizon }));
    const outlook = scope === "intraday" ? null : buildOutlook(45_000);
    // A few at a time: each forecast reads several price histories and trains the model, and Capital.com limits the calls
    const results: PromiseSettledResult<void>[] = [];
    for (let i = 0; i < jobs.length; i += 3) {
      results.push(...(await Promise.allSettled(jobs.slice(i, i + 3).map(async (series) => {
        const candles = await getCandles(series.epic, series.resolution, 1000, 60_000);
        const forecast = await runForecast({
          epic: series.epic,
          resolution: series.resolution,
          resolutionMinutes: series.resMinutes,
          horizon: series.horizon,
          candles,
        });
        await recordSafe(series, candles, forecast);
      }))));
    }
    const done = outlook ? await outlook : null;
    return NextResponse.json(
      { jobs: jobs.length, failed: results.filter((r) => r.status === "rejected").length, ...(done ? { outlookPending: Boolean(done.pending) } : {}) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleError(err);
  }
}
