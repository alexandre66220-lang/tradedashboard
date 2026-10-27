import "server-only";
import { INSTRUMENTS, spreadBpsFor } from "@/config/instruments";
import { getHistory } from "@/lib/capital";
import type { ForecastRequest } from "./types";

/** How many candles the external model gets to learn from (it accepts up to 5000 per request). */
export const HISTORY_TARGET: Record<string, number> = { MINUTE: 4000, MINUTE_5: 5000, MINUTE_15: 5000 };

/**
 * Gives the external model more to work with than the chart's 1000 candles: a longer history for intraday series,
 * the other instruments' prices, and the instrument's spread (the cost a move has to beat). Best effort: whatever
 * cannot be fetched is simply left out and the model works with what it has.
 */
export async function enrichRequest(req: ForecastRequest): Promise<ForecastRequest> {
  const out: ForecastRequest = { ...req, spreadBps: spreadBpsFor(req.epic) };
  const target = HISTORY_TARGET[req.resolution] ?? 1000;
  try {
    const others = INSTRUMENTS.filter((i) => i.epic !== req.epic);
    const [own, ...ctx] = await Promise.all([
      getHistory(req.epic, req.resolution, target),
      ...others.map((i) => getHistory(i.epic, req.resolution, target).catch(() => null)),
    ]);
    // The chart's candles are the freshest: they win over the (possibly cached) history where both have a candle
    if (own.length > req.candles.length) {
      const merged = new Map(own.map((c) => [c.time, c] as const));
      for (const c of req.candles) merged.set(c.time, c);
      out.candles = [...merged.values()].sort((a, b) => a.time - b.time);
    }
    out.context = ctx.flatMap((c, i) =>
      c && c.length >= 100 ? [{ epic: others[i].epic, time: c.map((k) => k.time), close: c.map((k) => k.close) }] : [],
    );
  } catch (err) {
    console.warn("[forecast] could not enrich the request:", err instanceof Error ? err.message : "unknown");
  }
  return out;
}
