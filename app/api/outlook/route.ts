import { NextResponse } from "next/server";
import { INSTRUMENTS, OUTLOOKS } from "@/config/instruments";
import { CapitalError, getCandles } from "@/lib/capital";
import { runForecast } from "@/lib/forecast";
import { handleError } from "@/lib/http";
import type { OutlookCell, OutlookItem, OutlookResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

// Daily/weekly candles move slowly: refresh them every 5 min, the whole outlook every minute.
const CANDLES_TTL_MS = 5 * 60_000;
const OUTLOOK_TTL_MS = 60_000;

let cache: { at: number; value: Promise<OutlookResponse> } | null = null;

function message(err: unknown): string {
  return err instanceof CapitalError ? err.message : "Prévision indisponible.";
}

async function buildOutlook(): Promise<OutlookResponse> {
  let source: string | undefined;
  const items = await Promise.all(
    INSTRUMENTS.map(async (inst): Promise<OutlookItem> => {
      const item: OutlookItem = { epic: inst.epic, name: inst.name, last: null, horizons: {} };
      await Promise.all(
        OUTLOOKS.map(async (o) => {
          try {
            const candles = await getCandles(inst.epic, o.api, 1000, CANDLES_TTL_MS);
            const last = candles.at(-1);
            if (!last) throw new CapitalError("NO_DATA", "Pas d'historique disponible.");
            if (o.key === "day") item.last = last.close;
            const f = await runForecast({
              epic: inst.epic,
              resolution: o.api,
              resolutionMinutes: o.minutes,
              horizon: o.minutes,
              candles,
            });
            const end = f.points.at(-1);
            if (!end || ![end.value, end.low, end.high, f.confidence].every(Number.isFinite)) {
              throw new CapitalError("NO_DATA", "Historique insuffisant pour cette prévision.");
            }
            source ??= f.source;
            const cell: OutlookCell = {
              change: end.value / last.close - 1,
              target: end.value,
              low: end.low,
              high: end.high,
              direction: f.direction,
              confidence: f.confidence,
              backtestHitRate: f.backtestHitRate,
              backtestSamples: f.backtestSamples,
            };
            item.horizons[o.key] = cell;
          } catch (err) {
            item.horizons[o.key] = { error: message(err) };
          }
        }),
      );
      return item;
    }),
  );
  return { items, source, generatedAt: Date.now() };
}

export async function GET() {
  try {
    let entry = cache;
    if (!entry || Date.now() - entry.at > OUTLOOK_TTL_MS) {
      const fresh = { at: Date.now(), value: buildOutlook() };
      entry = cache = fresh;
      // Keep partial failures out of the cache so the next poll retries them.
      fresh.value
        .then((r) => r.items.some((i) => Object.values(i.horizons).some((h) => "error" in h)) && cache === fresh && (cache = null))
        .catch(() => cache === fresh && (cache = null));
    }
    return NextResponse.json(await entry.value, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
