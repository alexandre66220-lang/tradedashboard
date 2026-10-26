import { averageTrueRange } from "./risk";
import type { Candle } from "./types";

export type Side = "long" | "short";

export interface Level {
  price: number;
  touches: number;
}

/** Cluster nearby prices into levels (mean price, number of touches). */
function cluster(prices: number[], tol: number): Level[] {
  const out: Array<{ sum: number; n: number }> = [];
  for (const p of [...prices].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && p - last.sum / last.n <= tol) {
      last.sum += p;
      last.n++;
    } else out.push({ sum: p, n: 1 });
  }
  return out.map((c) => ({ price: c.sum / c.n, touches: c.n }));
}

/**
 * Swing highs / lows: a candle whose high (low) is the extreme of the `k` candles on each side.
 * Only completed candles are passed in; the last `k` cannot be confirmed yet and are skipped.
 */
export function pivotLevels(done: Candle[], tol: number, k = 3, lookback = 300): { highs: Level[]; lows: Level[] } {
  const n = done.length;
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = Math.max(k, n - lookback); i <= n - 1 - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (done[j].high > done[i].high) isHigh = false;
      if (done[j].low < done[i].low) isLow = false;
    }
    if (isHigh) highs.push(done[i].high);
    if (isLow) lows.push(done[i].low);
  }
  return { highs: cluster(highs, tol), lows: cluster(lows, tol) };
}

export interface ExitStats {
  samples: number;
  /** Share of entries where the target was hit first */
  pTp: number;
  pSl: number;
  /** Neither hit within the holding time: closed at market */
  pTimeout: number;
  /** Mean result in R (1 R = the stop distance), before cost */
  grossR: number;
  /** Mean result in R after the spread */
  netR: number;
  /** Standard error of netR, counting overlapping entries only once */
  se: number;
}

/**
 * Replays "enter at each candle's close, exit at stop, target or after `hold` candles" on the history.
 * If a candle touches both the stop and the target, the stop is assumed hit first (conservative).
 * `cost` is the round-trip spread in price units.
 */
export function simulateExits(done: Candle[], side: Side, slDist: number, tpDist: number, hold: number, cost: number): ExitStats | null {
  const n = done.length - hold - 1;
  if (n < 20 || !(slDist > 0) || !(tpDist > 0)) return null;
  const dir = side === "long" ? 1 : -1;
  let tp = 0, sl = 0, to = 0, sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) {
    const entry = done[i].close;
    const stop = entry - dir * slDist;
    const target = entry + dir * tpDist;
    let r: number | null = null;
    for (let j = 1; j <= hold; j++) {
      const c = done[i + j];
      const slHit = dir === 1 ? c.low <= stop : c.high >= stop;
      const tpHit = dir === 1 ? c.high >= target : c.low <= target;
      if (slHit) {
        r = -1;
        sl++;
        break;
      }
      if (tpHit) {
        r = tpDist / slDist;
        tp++;
        break;
      }
    }
    if (r === null) {
      r = (dir * (done[i + hold].close - entry)) / slDist;
      to++;
    }
    sum += r;
    sum2 += r * r;
  }
  const mean = sum / n;
  const variance = Math.max(0, sum2 / n - mean * mean);
  const costR = cost / slDist;
  return {
    samples: n,
    pTp: tp / n,
    pSl: sl / n,
    pTimeout: to / n,
    grossR: mean,
    netR: mean - costR,
    se: Math.sqrt(variance / Math.max(1, n / hold)),
  };
}

export type Significance = "edge" | "none" | "against";
export function significance(s: ExitStats): Significance {
  if (s.netR - 2 * s.se > 0) return "edge";
  if (s.netR + 2 * s.se < 0) return "against";
  return "none";
}

export interface Forecast {
  direction: "up" | "down" | "flat";
  target: number;
}

export interface Candidate {
  key: string;
  label: string;
  price: number;
  distance: number;
  /** reward / risk */
  rr: number;
  reason: string;
  /** Result on the history, for this side and for the opposite one (same distances) */
  stats: ExitStats | null;
  otherSide: ExitStats | null;
}

export interface Advice {
  side: Side;
  entry: number;
  atr: number;
  stop: { price: number; distance: number; atrMultiple: number; reason: string; structure: boolean };
  targets: Candidate[];
  recommended: string;
  holdBars: number;
  costPrice: number;
  levels: { support: Level | null; resistance: Level | null };
  /** Things worth knowing before taking the trade */
  warnings: string[];
}

export function adviseSlTp(input: {
  candles: Candle[];
  side: Side;
  entry: number;
  forecast?: Forecast | null;
  spreadBps: number;
  holdBars: number;
}): Advice | { error: string } {
  const { candles, side, entry, forecast, spreadBps, holdBars } = input;
  const atr = averageTrueRange(candles);
  if (atr === null || atr <= 0) return { error: "Historique insuffisant pour estimer la volatilité." };
  const done = candles.slice(0, -1);
  const dir = side === "long" ? 1 : -1;
  const { highs, lows } = pivotLevels(done, 0.25 * atr);

  // Protective level: the nearest swing low (long) / high (short) that is neither too tight nor too far
  const against = (side === "long" ? lows : highs)
    .filter((l) => dir * (entry - l.price) >= 0.8 * atr && dir * (entry - l.price) <= 3.5 * atr)
    .sort((a, b) => dir * (b.price - a.price));
  const level = against[0] ?? null;
  const structural = level !== null;
  const stopPrice = structural ? level.price - dir * 0.25 * atr : entry - dir * 1.5 * atr;
  const slDist = dir * (entry - stopPrice);
  const stop = {
    price: stopPrice,
    distance: slDist,
    atrMultiple: slDist / atr,
    structure: structural,
    reason: structural
      ? `Juste ${side === "long" ? "sous le dernier creux" : "au-dessus du dernier sommet"} (touché ${level.touches} fois), avec une marge de 0,25 ATR`
      : "Aucun creux ni sommet exploitable à bonne distance : 1,5 × ATR, hors du bruit normal",
  };

  const costPrice = (entry * spreadBps) / 1e4;
  const targets: Candidate[] = [];
  const add = (key: string, label: string, price: number, reason: string) => {
    const distance = dir * (price - entry);
    if (!(distance > 0)) return;
    targets.push({
      key,
      label,
      price,
      distance,
      rr: distance / slDist,
      reason,
      stats: simulateExits(done, side, slDist, distance, holdBars, costPrice),
      otherSide: simulateExits(done, side === "long" ? "short" : "long", slDist, distance, holdBars, costPrice),
    });
  };

  const next = (side === "long" ? highs : lows)
    .filter((l) => dir * (l.price - entry) >= 0.8 * atr)
    .sort((a, b) => dir * (a.price - b.price))[0];
  if (next) add("structure", `Prochain ${side === "long" ? "sommet" : "creux"}`, next.price - dir * 0.1 * atr, `Juste avant le niveau ${next.price.toFixed(2)} (touché ${next.touches} fois)`);
  if (forecast && forecast.direction === (side === "long" ? "up" : "down")) {
    add("model", "Objectif du modèle", forecast.target, "Cible de la prévision actuelle (modèle expérimental)");
  }
  for (const r of [1, 1.5, 2, 3]) add(`r${r}`, `${String(r).replace(".", ",")} × le risque`, entry + dir * r * slDist, "Multiple fixe du risque pris");

  targets.sort((a, b) => a.rr - b.rr);
  const inRange = (c?: Candidate) => c !== undefined && c.rr >= 1.5 && c.rr <= 3.5;
  // Without a sensible level or model target, fall back on 1.5 x the risk: the usual minimum, and the most reachable
  const pick = [targets.find((c) => c.key === "structure"), targets.find((c) => c.key === "model")].find(inRange) ?? targets.find((c) => c.key === "r1.5");

  const warnings: string[] = [];
  const obstacle = targets.find((c) => c.key === "structure");
  if (obstacle && obstacle.rr < 1) {
    warnings.push(
      `Le prochain ${side === "long" ? "sommet" : "creux"} est à seulement ${obstacle.rr.toFixed(2).replace(".", ",")} fois le risque : peu d’espace avant un obstacle, donc un rapport gain/risque médiocre. Attendre un meilleur point d’entrée est souvent préférable.`,
    );
  }
  if (slDist > 3 * atr) warnings.push(`Stop large (${(slDist / atr).toFixed(1).replace(".", ",")} ATR) : la taille de position sera réduite pour garder le même risque.`);
  return {
    side,
    entry,
    atr,
    stop,
    targets,
    recommended: pick?.key ?? "r1.5",
    warnings,
    holdBars,
    costPrice,
    levels: {
      support: (lows.filter((l) => l.price < entry).sort((a, b) => b.price - a.price)[0]) ?? null,
      resistance: (highs.filter((l) => l.price > entry).sort((a, b) => a.price - b.price)[0]) ?? null,
    },
  };
}
