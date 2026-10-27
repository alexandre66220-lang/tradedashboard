import { atrPercentile } from "./trafficlight";
import type { Candle } from "./types";

export type VolRegime = "calm" | "normal" | "wild";
export type TrendRegime = "trend" | "range";

export interface Regime {
  vol: VolRegime;
  trend: TrendRegime;
}

export const VOL_LABEL: Record<VolRegime, string> = { calm: "calme", normal: "normal", wild: "agité" };
export const TREND_LABEL: Record<TrendRegime, string> = { trend: "en tendance", range: "sans tendance" };

/** Kaufman efficiency ratio over `n` candles: 1 = a straight line, 0 = back and forth. */
export function efficiencyRatio(candles: Candle[], n = 30): number | null {
  if (candles.length <= n) return null;
  const w = candles.slice(-(n + 1));
  const path = w.slice(1).reduce((a, c, i) => a + Math.abs(c.close - w[i].close), 0);
  return path > 0 ? Math.abs(w[n].close - w[0].close) / path : 0;
}

/**
 * The market state around a forecast: volatility against its own history (bottom / top quarter of the loaded history
 * = calm / wild) and whether the last 30 candles went somewhere (efficiency ratio above 0.3) or just wandered.
 */
export function regimeOf(candles: Candle[]): Regime | null {
  const pct = atrPercentile(candles);
  const er = efficiencyRatio(candles);
  if (pct === null || er === null) return null;
  return { vol: pct < 0.25 ? "calm" : pct > 0.75 ? "wild" : "normal", trend: er > 0.3 ? "trend" : "range" };
}
