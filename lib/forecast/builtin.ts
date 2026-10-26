import type { Candle, ForecastPoint, ForecastResponse } from "../types";
import type { ForecastProvider, ForecastRequest } from "./types";

/**
 * Deliberately simple statistical model:
 * - trend = slope of an exponentially weighted linear regression on the last WINDOW log-closes,
 *   shrunk toward zero (SHRINK) because short-term trends persist only weakly;
 * - band = ±Z × recent volatility of log-returns × √steps (random-walk spread, ~80 % interval);
 * - direction is "flat" when the expected move is small compared with the noise.
 * No claim of accuracy: the backtest hit rate is computed with the exact same function.
 */
export const WINDOW = 48;
const SHRINK = 0.5;
const Z = 1.28;
const FLAT_RATIO = 0.1;
const MIN_BACKTEST_SAMPLES = 20;

export interface ModelOutput {
  /** expected log move per step */
  drift: number;
  /** std of 1-step log returns */
  sigma: number;
}

export function fitModel(closes: number[]): ModelOutput | null {
  const n = closes.length;
  if (n < 10) return null;
  const y = closes.map(Math.log);
  const halfLife = n / 3;
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.pow(0.5, (n - 1 - i) / halfLife);
    sw += w;
    sx += w * i;
    sy += w * y[i];
    sxx += w * i * i;
    sxy += w * i * y[i];
  }
  const den = sw * sxx - sx * sx;
  const slope = den > 0 ? (sw * sxy - sx * sy) / den : 0;

  let s = 0, s2 = 0;
  for (let i = 1; i < n; i++) {
    const r = y[i] - y[i - 1];
    s += r;
    s2 += r * r;
  }
  const m = n - 1;
  const sigma = Math.sqrt(Math.max(0, s2 / m - (s / m) ** 2));
  return { drift: slope * SHRINK, sigma };
}

/** Normal CDF (Abramowitz-Stegun approximation) */
function phi(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export function directionOf(model: ModelOutput, steps: number): { direction: "up" | "down" | "flat"; confidence: number } {
  const move = model.drift * steps;
  const noise = model.sigma * Math.sqrt(steps);
  if (noise <= 0) return { direction: move > 0 ? "up" : move < 0 ? "down" : "flat", confidence: move === 0 ? 0.5 : 1 };
  const ratio = move / noise;
  const confidence = phi(Math.abs(ratio));
  if (Math.abs(ratio) < FLAT_RATIO) return { direction: "flat", confidence };
  return { direction: ratio > 0 ? "up" : "down", confidence };
}

export function backtest(candles: Candle[], steps: number): { hitRate: number | null; samples: number } {
  const closes = candles.map((c) => c.close);
  let hits = 0, samples = 0;
  for (let i = WINDOW - 1; i + steps < closes.length; i++) {
    const model = fitModel(closes.slice(i - WINDOW + 1, i + 1));
    if (!model) continue;
    const { direction } = directionOf(model, steps);
    const actual = closes[i + steps] - closes[i];
    if (direction === "flat" || actual === 0) continue;
    samples++;
    if ((direction === "up") === actual > 0) hits++;
  }
  return { hitRate: samples >= MIN_BACKTEST_SAMPLES ? hits / samples : null, samples };
}

export function builtinForecast(req: ForecastRequest): ForecastResponse {
  const { candles, resolutionMinutes, horizon } = req;
  const steps = Math.max(1, Math.round(horizon / resolutionMinutes));
  const last = candles.at(-1);
  const model = fitModel(candles.slice(-WINDOW).map((c) => c.close));
  if (!last || !model) {
    return { points: [], direction: "flat", confidence: 0, backtestHitRate: null, backtestSamples: 0, source: "intégré" };
  }
  const base = Math.log(last.close);
  const stepSec = resolutionMinutes * 60;
  const points: ForecastPoint[] = [];
  for (let k = 1; k <= steps; k++) {
    const mu = base + model.drift * k;
    const spread = Z * model.sigma * Math.sqrt(k);
    points.push({ time: last.time + k * stepSec, value: Math.exp(mu), low: Math.exp(mu - spread), high: Math.exp(mu + spread) });
  }
  const { direction, confidence } = directionOf(model, steps);
  const bt = backtest(candles, steps);
  return { points, direction, confidence, backtestHitRate: bt.hitRate, backtestSamples: bt.samples, source: "intégré" };
}

export const builtinProvider: ForecastProvider = {
  name: "intégré",
  forecast: async (req) => builtinForecast(req),
};
