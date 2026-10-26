export interface RiskInput {
  capital: number;
  /** % of capital risked on the trade */
  riskPct: number;
  entry: number;
  /** Stop distance in price units (always positive) */
  stopDistance: number;
  side: "long" | "short";
  /** Reward-to-risk ratio for the take-profit */
  rewardRatio: number;
}

export interface RiskResult {
  riskAmount: number;
  /** Position size in contract units, rounded down to 0.01 */
  units: number;
  stop: number;
  takeProfit: number;
  notional: number;
  leverage: number;
  /** Loss if the stop is hit, with the rounded size */
  maxLoss: number;
  /** Gain if the take-profit is hit */
  potentialGain: number;
  warnings: string[];
}

export function averageTrueRange(candles: Array<{ high: number; low: number; close: number }>, period = 14): number | null {
  // the last candle is still forming: ignore it
  const done = candles.slice(0, -1);
  if (done.length <= period) return null;
  const recent = done.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < recent.length; i++) {
    const c = recent[i], prev = recent[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  }
  return sum / period;
}

export function sizePosition(i: RiskInput): RiskResult | { error: string } {
  const finite = [i.capital, i.riskPct, i.entry, i.stopDistance, i.rewardRatio].every(Number.isFinite);
  if (!finite || i.capital <= 0 || i.riskPct <= 0 || i.entry <= 0 || i.stopDistance <= 0 || i.rewardRatio <= 0) {
    return { error: "Renseignez des valeurs positives." };
  }
  if (i.stopDistance >= i.entry && i.side === "long") return { error: "Le stop serait à zéro ou en dessous : réduisez la distance." };

  const riskAmount = i.capital * (i.riskPct / 100);
  const units = Math.floor((riskAmount / i.stopDistance) * 100) / 100;
  if (units < 0.01) return { error: "Taille inférieure à 0,01 : augmentez le risque ou resserrez le stop." };

  const dir = i.side === "long" ? 1 : -1;
  const notional = units * i.entry;
  const leverage = notional / i.capital;
  const warnings: string[] = [];
  if (i.riskPct > 2) warnings.push("Risque supérieur à 2 % du capital par trade : élevé.");
  if (leverage > 5) warnings.push(`Levier effectif de ${leverage.toFixed(1)}× : une petite variation contre vous coûte cher.`);
  return {
    riskAmount,
    units,
    stop: i.entry - dir * i.stopDistance,
    takeProfit: i.entry + dir * i.stopDistance * i.rewardRatio,
    notional,
    leverage,
    maxLoss: units * i.stopDistance,
    potentialGain: units * i.stopDistance * i.rewardRatio,
    warnings,
  };
}
