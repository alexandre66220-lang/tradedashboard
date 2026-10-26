export interface Candle {
  /** UTC seconds, start of the candle */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type MarketStatus = "TRADEABLE" | "CLOSED" | "UNKNOWN" | string;

export interface CandlesResponse {
  epic: string;
  resolution: string;
  candles: Candle[];
  marketStatus: MarketStatus;
  env: "demo" | "live";
}

export interface ForecastPoint {
  time: number;
  value: number;
  low: number;
  high: number;
}

export interface ForecastResponse {
  points: ForecastPoint[];
  direction: "up" | "down" | "flat";
  /** 0..1 */
  confidence: number;
  /** 0..1, or null if not enough history */
  backtestHitRate: number | null;
  backtestSamples?: number;
  source?: string;
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
