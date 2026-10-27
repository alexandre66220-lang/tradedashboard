import "server-only";
import type { ModelVariant } from "../types";
import { enrichRequest } from "./enrich";
import { externalCompare } from "./external";
import type { ForecastRequest } from "./types";

// Scoring six versions of the model takes a while: the answer is kept per (instrument, timeframe, horizon, latest
// candle) for a few minutes, and a failure only briefly.
const TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 30_000;

interface Entry {
  expires: number;
  value: Promise<ModelVariant[]>;
}
const cache = new Map<string, Entry>();

export class CompareUnavailable extends Error {}

export function __resetCompareCache() {
  cache.clear();
}

export function compareModels(req: ForecastRequest): Promise<ModelVariant[]> {
  const url = process.env.FORECAST_SERVICE_URL;
  if (!url) return Promise.reject(new CompareUnavailable("Aucun modèle externe n’est configuré (FORECAST_SERVICE_URL)."));

  const now = Date.now();
  for (const [k, e] of cache) if (e.expires <= now) cache.delete(k);
  const key = [req.epic, req.resolution, req.horizon, req.candles.at(-1)?.time ?? 0].join("|");
  const hit = cache.get(key);
  if (hit) return hit.value;

  const entry: Entry = { expires: now + TTL_MS, value: Promise.resolve([]) };
  entry.value = enrichRequest(req)
    .then((r) => externalCompare(url, r))
    .catch((err) => {
      entry.expires = Date.now() + FAILURE_TTL_MS;
      throw err;
    });
  cache.set(key, entry);
  return entry.value;
}
