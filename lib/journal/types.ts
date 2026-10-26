export interface JournalEntry {
  /** `${epic}|${resolution}|${horizon}|${window}`: one entry per horizon-long window, so entries never overlap */
  id: string;
  epic: string;
  /** Capital.com resolution, e.g. "MINUTE_5", "DAY" */
  resolution: string;
  resMinutes: number;
  /** Horizon in minutes */
  horizon: number;
  /** Candles ahead */
  steps: number;
  /** Start time (UTC seconds) of the candle the forecast was made on */
  t: number;
  recordedAt: number;
  /** Price at recording time (the candle was still forming) */
  price: number;
  direction: "up" | "down" | "flat";
  confidence: number;
  target: number;
  /** Provider label shown in the UI, e.g. "ML, gradient boosting + logistique" */
  source: string;
  /** Final close of candle t */
  ref?: number;
  /** Final close of the candle before t (for the "follow the last candle" baseline) */
  prev?: number;
  /** Final close `steps` candles after t (same definition as the backtest) */
  outcome?: number;
  /** The candle left the loaded history before the outcome could be read */
  expired?: boolean;
}

export type ModelFamily = "ml" | "builtin";

export interface JournalHit {
  hits: number;
  samples: number;
  /** null below 20 samples */
  hitRate: number | null;
  margin: number | null;
}

export interface JournalStats {
  recorded: number;
  pending: number;
  expired: number;
  /** resolved "flat" predictions (no call made) */
  flat: number;
  /** resolved up/down predictions */
  evaluated: number;
  model: JournalHit;
  baselines: { alwaysUp: JournalHit; lastMove: JournalHit };
  /** Net simulated return in %, one unit of notional per call, after the assumed spread */
  netReturnPct: number;
  grossReturnPct: number;
  /** Cumulative net return (%) after each resolved call */
  curve: Array<{ t: number; v: number }>;
  firstRecordedAt: number | null;
}
