import "server-only";
import type { ForecastResponse } from "../types";
import type { ForecastProvider } from "./types";

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
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`external forecast service returned ${res.status}`);
      const body: unknown = await res.json();
      if (!isValid(body)) throw new Error("external forecast service returned an invalid payload");
      return { ...body, source: body.source ?? "externe" };
    },
  };
}
