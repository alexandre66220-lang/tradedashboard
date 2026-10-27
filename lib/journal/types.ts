import type { Regime, TrendRegime, VolRegime } from "../regime";

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
  /** % of Capital.com clients long when the forecast was made (not available for older entries) */
  sentiment?: number;
  /** A high-impact announcement for the instrument fell inside the window (intraday series only; unknown for older entries) */
  news?: boolean;
  /** How many classic technical readings agreed with the forecast (not recorded for neutral forecasts / older entries) */
  confluence?: { agree: number; against: number; voting: number };
  /** The price was sitting on a Fibonacci retracement level (within 0.15 ATR) when the forecast was made */
  nearFib?: boolean;
  /** ATR(14) when the forecast was made: the simulated stop and target are multiples of it */
  atr?: number;
  /** Spread on the broker's quote when the forecast was made, in basis points of the price (else the assumed one is used) */
  spreadBps?: number;
  /** Market state when the forecast was made */
  regime?: Regime;
  /** Simulated trade on the forecast (stop 1.5 ATR, target twice the stop, else out at the horizon), gross result in R */
  sim?: { r: number; exit: "stop" | "target" | "time" };
  /** Final close of candle t */
  ref?: number;
  /** Final close of the candle before t (for the "follow the last candle" baseline) */
  prev?: number;
  /** Final close `steps` candles after t (same definition as the backtest) */
  outcome?: number;
  /** The candle left the loaded history before the outcome could be read */
  expired?: boolean;
}

/** ml2 = ML with volume / other instruments / cost target (source "ML v2…"), ml = the first ML version, builtin = regression in the app */
export const MODEL_FAMILIES = ["ml2", "ml", "builtin"] as const;
export const SESSIONS = [
  { key: "asia", label: "Asie", from: 0, to: 7 },
  { key: "europe", label: "Europe", from: 7, to: 13 },
  { key: "us", label: "New York", from: 13, to: 21 },
  { key: "night", label: "Nuit", from: 21, to: 24 },
] as const;
export type SessionKey = (typeof SESSIONS)[number]["key"];

export type ModelFamily = (typeof MODEL_FAMILIES)[number];

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
  /** Hit rate depending on whether the forecast agreed with the crowd (>= 60 % on one side) */
  bySentiment: { with: JournalHit; against: JournalHit; neutral: JournalHit };
  /** Hit rate and net result by moment of the day (UTC hour of the forecast), intraday series only */
  bySession: Record<SessionKey, { hit: JournalHit; netReturnPct: number }>;
  /** Simulated trades (stop 1.5 ATR, target 2 R) after spread and financing; the mean is null below 20 trades */
  strategy: { trades: number; meanNetR: number | null; se: number | null; target: number; stop: number; time: number };
  /** Is the displayed confidence honest? Observed hit rate by confidence level */
  calibration: Array<{ from: number; to: number; meanConfidence: number | null; hit: JournalHit }>;
  /** Hit rate by volatility and by trend at the time of the forecast */
  byVol: Record<VolRegime, JournalHit>;
  byTrend: Record<TrendRegime, JournalHit>;
  /** Hit rate by number of technical readings agreeing with the forecast: 0-1, 2-3, 4-5 */
  byConfluence: { low: JournalHit; mid: JournalHit; high: JournalHit };
  /** Hit rate depending on whether the price sat on a Fibonacci retracement level */
  byFib: { near: JournalHit; away: JournalHit };
  /** Hit rate depending on whether a high-impact announcement fell inside the forecast window */
  byNews: { near: JournalHit; calm: JournalHit };
  /** Net simulated return in %, one unit of notional per call, after the assumed spread */
  netReturnPct: number;
  grossReturnPct: number;
  /** Cumulative net return (%) after each resolved call */
  curve: Array<{ t: number; v: number }>;
  firstRecordedAt: number | null;
}

export interface CrowdFadeGroup {
  /** Calls "against the crowd": a hit is a move opposite to the side holding the majority of clients */
  fade: JournalHit;
  /** Net simulated return in % of fading the crowd, one unit per window, after the assumed spread */
  netReturnPct: number;
  grossReturnPct: number;
}

/**
 * Model-independent test of "go against the crowd": every resolved window with a recorded client
 * sentiment counts, whatever the forecast said.
 */
export interface CrowdFadeStats {
  /** Resolved windows that have a recorded sentiment */
  judged: number;
  /** >= 70 % or <= 30 % of clients on one side */
  extreme: CrowdFadeGroup;
  /** 60-70 % or 30-40 % on one side */
  moderate: CrowdFadeGroup;
}
