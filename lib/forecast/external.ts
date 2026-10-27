import "server-only";
import type { ForecastResponse, ModelVariant } from "../types";
import type { ForecastProvider, ForecastRequest } from "./types";

function isValid(r: unknown): r is ForecastResponse {
  const o = r as ForecastResponse;
  return (
    !!o &&
    Array.isArray(o.points) &&
    o.points.every((p) => [p?.time, p?.value, p?.low, p?.high].every((v) => typeof v === "number" && Number.isFinite(v))) &&
    ["up", "down", "flat"].includes(o.direction) &&
    typeof o.confidence === "number" &&
    (o.backtestHitRate === null || typeof o.backtestHitRate === "number")
  );
}

/** Relays the request to an external service (e.g. a Python ML model) that returns the same JSON format. */
export function externalProvider(url: string): ForecastProvider {
  return {
    name: "externe",
    async forecast(req) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (process.env.FORECAST_SERVICE_TOKEN) headers.Authorization = `Bearer ${process.env.FORECAST_SERVICE_TOKEN}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
        cache: "no-store",
        // Training + backtest can take a few seconds, more on a cold start.
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`external forecast service returned ${res.status}`);
      const body: unknown = await res.json();
      if (!isValid(body)) throw new Error("external forecast service returned an invalid payload");
      return { ...body, source: body.source ?? "externe" };
    },
  };
}

function isVariant(v: unknown): v is ModelVariant {
  const o = v as ModelVariant;
  const num = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x));
  return (
    !!o &&
    typeof o.name === "string" &&
    Array.isArray(o.features) &&
    typeof o.samples === "number" &&
    num(o.hitRate) &&
    num(o.margin) &&
    num(o.avgNetBps) &&
    num(o.coverage) &&
    typeof o.live === "boolean"
  );
}

/** Asks the external service to score several versions of its own model on the same history (slow: seconds to tens of seconds). */
export async function externalCompare(url: string, req: ForecastRequest): Promise<ModelVariant[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.FORECAST_SERVICE_TOKEN) headers.Authorization = `Bearer ${process.env.FORECAST_SERVICE_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...req, mode: "compare" }),
    cache: "no-store",
    signal: AbortSignal.timeout(50_000),
  });
  if (!res.ok) throw new Error(`external forecast service returned ${res.status}`);
  const body = (await res.json()) as { variants?: unknown };
  if (!Array.isArray(body?.variants) || !body.variants.every(isVariant)) throw new Error("external forecast service returned an invalid comparison");
  return body.variants;
}
