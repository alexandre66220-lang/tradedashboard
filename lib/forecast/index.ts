import "server-only";
import type { ForecastResponse } from "../types";
import { builtinProvider } from "./builtin";
import { externalProvider } from "./external";
import type { ForecastProvider, ForecastRequest } from "./types";

export type { ForecastProvider, ForecastRequest } from "./types";

export function getProvider(): ForecastProvider {
  const url = process.env.FORECAST_SERVICE_URL;
  return url ? externalProvider(url) : builtinProvider;
}

// An external model (training + backtest) is slow and the browser polls every few seconds, so its
// answers are cached per (instrument, timeframe, horizon, latest candle). A failure is cached
// briefly too, so a down service is not hit on every poll.
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 15 * 60_000;
const FAILURE_TTL_MS = 30_000;

interface Entry {
  expires: number;
  value: Promise<ForecastResponse>;
}
const externalCache = new Map<string, Entry>();

function ttlFor(req: ForecastRequest): number {
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, (req.resolutionMinutes * 60_000) / 5));
}

export function __resetForecastCache() {
  externalCache.clear();
}

export async function runForecast(req: ForecastRequest): Promise<ForecastResponse> {
  const provider = getProvider();
  if (provider === builtinProvider) return provider.forecast(req);

  const now = Date.now();
  for (const [k, e] of externalCache) if (e.expires <= now) externalCache.delete(k);

  const key = [provider.name, req.epic, req.resolution, req.horizon, req.candles.at(-1)?.time ?? 0].join("|");
  const hit = externalCache.get(key);
  if (hit) return hit.value;

  const entry: Entry = { expires: now + ttlFor(req), value: Promise.resolve(null as never) };
  entry.value = provider.forecast(req).catch(async (err) => {
    console.warn("[forecast] external service failed, using built-in model:", err instanceof Error ? err.message : "unknown");
    entry.expires = Date.now() + FAILURE_TTL_MS;
    const fallback = await builtinProvider.forecast(req);
    return { ...fallback, source: "intégré — service externe indisponible" };
  });
  externalCache.set(key, entry);
  return entry.value;
}
