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

export async function runForecast(req: ForecastRequest): Promise<ForecastResponse> {
  const provider = getProvider();
  if (provider === builtinProvider) return provider.forecast(req);
  try {
    return await provider.forecast(req);
  } catch (err) {
    console.warn("[forecast] external service failed, using built-in model:", err instanceof Error ? err.message : "unknown");
    const fallback = await builtinProvider.forecast(req);
    return { ...fallback, source: "intégré — service externe indisponible" };
  }
}
