import { averageTrueRange } from "./risk";
import type { Candle } from "./types";

// Classic chart indicators, computed from the candles already on screen. They are display aids and simple votes for the
// "confluence" panel; whether they help is measured by the live journal, not assumed.

/** Exponential moving average, same length as the input (the first values are warming up). */
export function ema(values: number[], span: number): number[] {
  const out: number[] = [];
  const a = 2 / (span + 1);
  for (let i = 0; i < values.length; i++) out.push(i === 0 ? values[0] : a * values[i] + (1 - a) * out[i - 1]);
  return out;
}

/** Wilder's RSI; null while there is not enough history. */
export function rsi(closes: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = closes.map(() => null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

/** MACD histogram (MACD line minus its signal line); null while warming up. */
export function macdHistogram(closes: number[], fast = 12, slow = 26, signal = 9): Array<number | null> {
  if (closes.length < slow + signal) return closes.map(() => null);
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const macd = closes.map((_, i) => f[i] - s[i]);
  const sig = ema(macd, signal);
  return closes.map((_, i) => (i < slow + signal - 2 ? null : macd[i] - sig[i]));
}

export interface BollingerPoint {
  mid: number;
  upper: number;
  lower: number;
}

/** Bollinger bands: moving average ± k standard deviations; null while warming up. */
export function bollinger(closes: number[], period = 20, k = 2): Array<BollingerPoint | null> {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const w = closes.slice(i - period + 1, i + 1);
    const mid = w.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
    return { mid, upper: mid + k * sd, lower: mid - k * sd };
  });
}

// --------------------------------------------------------------------------- Fibonacci

export const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786] as const;

export interface FibRetracement {
  /** Direction of the last leg: retracements go against it */
  leg: "up" | "down";
  high: number;
  low: number;
  levels: Array<{ ratio: number; price: number }>;
}

/**
 * Retracement levels of the most recent leg: between the highest high and the lowest low of the last `lookback`
 * candles. The result depends on the window chosen, which is why the levels are a reading aid, not a measurement.
 */
export function fibRetracement(candles: Candle[], lookback = 100): FibRetracement | null {
  const w = candles.slice(-lookback);
  if (w.length < 20) return null;
  let hi = 0;
  let lo = 0;
  w.forEach((c, i) => {
    if (c.high >= w[hi].high) hi = i;
    if (c.low <= w[lo].low) lo = i;
  });
  const high = w[hi].high;
  const low = w[lo].low;
  if (!(high > low)) return null;
  const leg = hi > lo ? "up" : "down";
  const range = high - low;
  return {
    leg,
    high,
    low,
    levels: FIB_RATIOS.map((ratio) => ({ ratio, price: leg === "up" ? high - ratio * range : low + ratio * range })),
  };
}

/** Is the price within `tolerance` ATR of a retracement level? (With five levels, "near one" happens often.) */
export function nearFibLevel(price: number, fib: FibRetracement | null, atr: number | null, tolerance = 0.15): boolean {
  if (!fib || !atr || !(atr > 0)) return false;
  return fib.levels.some((l) => Math.abs(price - l.price) <= tolerance * atr);
}

// --------------------------------------------------------------------------- confluence

export type VoteValue = -1 | 0 | 1;

export interface Vote {
  id: string;
  label: string;
  vote: VoteValue;
  detail: string;
}

/** Groups candles into longer ones of `bucketSec` seconds (open of the first, close of the last, extremes of all). */
export function aggregateCandles(candles: Candle[], bucketSec: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Math.floor(c.time / bucketSec) * bucketSec;
    const last = out.at(-1);
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return out;
}

const side = (v: number): VoteValue => (v > 0 ? 1 : v < 0 ? -1 : 0);
/** Longer timeframe used for the "higher timeframe" vote, as a multiple of the one on screen. */
const HIGHER: Record<number, number> = { 1: 5, 5: 3, 15: 4 };

function trendOf(closes: number[], atr: number | null): VoteValue {
  if (closes.length < 55) return 0;
  const f = ema(closes, 20).at(-1)!;
  const s = ema(closes, 50).at(-1)!;
  return atr && Math.abs(f - s) < 0.05 * atr ? 0 : side(f - s);
}

/**
 * Five simple technical votes on the candles at hand (the model's own direction is not one of them: the confluence
 * asks whether classic readings agree with it). 1 = up, -1 = down, 0 = no opinion.
 */
export function technicalVotes(candles: Candle[], resMinutes: number): Vote[] {
  const closes = candles.map((c) => c.close);
  const atr = averageTrueRange(candles);
  const last = candles.at(-1);
  const votes: Vote[] = [];

  const trend = trendOf(closes, atr);
  votes.push({ id: "trend", label: "Moyennes (20 / 50)", vote: trend, detail: trend === 1 ? "La moyenne rapide est au-dessus de la lente." : trend === -1 ? "La moyenne rapide est sous la lente." : "Moyennes proches ou historique insuffisant." });

  const r = rsi(closes).at(-1) ?? null;
  const rv: VoteValue = r === null ? 0 : r > 55 ? 1 : r < 45 ? -1 : 0;
  votes.push({ id: "rsi", label: "RSI (14)", vote: rv, detail: r === null ? "Historique insuffisant." : `RSI ${r.toFixed(0)} : ${rv === 1 ? "élan haussier (> 55)" : rv === -1 ? "élan baissier (< 45)" : "zone neutre (45–55)"}.` });

  const m = macdHistogram(closes).at(-1) ?? null;
  const mv: VoteValue = m === null ? 0 : side(m);
  votes.push({ id: "macd", label: "MACD", vote: mv, detail: m === null ? "Historique insuffisant." : mv === 1 ? "Histogramme positif." : mv === -1 ? "Histogramme négatif." : "Histogramme nul." });

  let bv: VoteValue = 0;
  if (last && candles.length > 21) {
    const prev = candles.slice(-21, -1);
    if (last.close > Math.max(...prev.map((c) => c.high))) bv = 1;
    else if (last.close < Math.min(...prev.map((c) => c.low))) bv = -1;
  }
  votes.push({ id: "breakout", label: "Cassure (20 bougies)", vote: bv, detail: bv === 1 ? "Clôture au-dessus du plus haut des 20 dernières bougies." : bv === -1 ? "Clôture sous le plus bas des 20 dernières bougies." : "Le prix reste dans sa fourchette récente." });

  const mult = HIGHER[resMinutes];
  if (!mult) {
    votes.push({ id: "higher", label: "Unité de temps supérieure", vote: 0, detail: "Non applicable à cette unité de temps." });
  } else {
    const agg = aggregateCandles(candles, resMinutes * mult * 60);
    const hv = trendOf(agg.map((c) => c.close), averageTrueRange(agg));
    votes.push({ id: "higher", label: `Tendance en ${resMinutes * mult} min`, vote: hv, detail: hv === 1 ? "Moyennes haussières sur l'unité supérieure." : hv === -1 ? "Moyennes baissières sur l'unité supérieure." : "Pas de tendance nette sur l'unité supérieure." });
  }
  return votes;
}

export interface ConfluenceStamp {
  /** Votes in the direction of the forecast */
  agree: number;
  /** Votes against it */
  against: number;
  /** Votes that had an opinion */
  voting: number;
}

/** How many of the technical votes agree with a forecast direction. A flat forecast has no agreement to count. */
export function stampFor(votes: Vote[], direction: "up" | "down" | "flat"): ConfluenceStamp | null {
  if (direction === "flat") return null;
  const want = direction === "up" ? 1 : -1;
  return {
    agree: votes.filter((v) => v.vote === want).length,
    against: votes.filter((v) => v.vote === -want).length,
    voting: votes.filter((v) => v.vote !== 0).length,
  };
}
