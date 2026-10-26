import type { Candle, ForecastResponse } from "../types";

export interface ForecastRequest {
  epic: string;
  /** Capital.com resolution, e.g. "MINUTE_5" */
  resolution: string;
  resolutionMinutes: number;
  /** Horizon in minutes */
  horizon: number;
  /** Oldest first */
  candles: Candle[];
}

export interface ForecastProvider {
  name: string;
  forecast(req: ForecastRequest): Promise<ForecastResponse>;
}
