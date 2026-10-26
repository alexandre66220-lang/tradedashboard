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
