export interface Candle {
  /** UTC seconds, start of the candle */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Traded volume when the broker gives one (tick volume for most CFDs) */
  volume?: number;
}

export type MarketStatus = "TRADEABLE" | "CLOSED" | "UNKNOWN" | string;

export interface CandlesResponse {
  epic: string;
  resolution: string;
  candles: Candle[];
  marketStatus: MarketStatus;
  /** Live bid / offer, when the broker gives them */
  quote?: { bid: number; offer: number } | null;
  /** Share of Capital.com clients long / short, when available */
  sentiment?: { long: number; short: number } | null;
  env: "demo" | "live";
}

export interface ForecastPoint {
  time: number;
  value: number;
  low: number;
  high: number;
}

export interface HitStat {
  /** 0..1, null when fewer than 20 samples */
  hitRate: number | null;
  samples: number;
  /** Half-width of the ~95 % interval around hitRate (accounts for overlapping horizons) */
  margin: number | null;
}

export interface BacktestStats extends HitStat {
  /** Naive strategies scored on exactly the same cases as the model */
  baselines: { alwaysUp: HitStat; lastMove: HitStat };
  /** Hit rate when only the predictions above a confidence threshold are kept */
  byConfidence: Array<HitStat & { minConfidence: number }>;
  /** Mean result of one call after the spread, in basis points (external model only; null below 20 calls) */
  avgNetBps?: number | null;
  /** Share of the tested candles on which the model made a call; the rest were "neutral" */
  coverage?: number | null;
}

export interface ForecastResponse {
  points: ForecastPoint[];
  direction: "up" | "down" | "flat";
  /** 0..1 */
  confidence: number;
  /** 0..1, or null if not enough history */
  backtestHitRate: number | null;
  backtestSamples?: number;
  /** Detailed backtest (optional for external providers) */
  backtest?: BacktestStats;
  source?: string;
  /** What the external model looked at, e.g. ["prix", "volume"] */
  features?: string[];
}

/** One line of the model comparison: the same walk-forward backtest for one version of the model */
export interface ModelVariant {
  name: string;
  features: string[];
  hitRate: number | null;
  samples: number;
  margin: number | null;
  avgNetBps: number | null;
  coverage: number | null;
  /** This is the version currently used for the forecast */
  live: boolean;
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface OutlookCell {
  /** Expected relative change of the forecast target vs last close (0.01 = +1 %) */
  change: number;
  target: number;
  low: number;
  high: number;
  direction: ForecastResponse["direction"];
  confidence: number;
  backtestHitRate: number | null;
  backtestSamples?: number;
  backtest?: BacktestStats;
}

export interface OutlookItem {
  epic: string;
  name: string;
  last: number | null;
  horizons: Record<string, OutlookCell | { error: string }>;
}

export interface OutlookResponse {
  items: OutlookItem[];
  source?: string;
  generatedAt: number;
}
