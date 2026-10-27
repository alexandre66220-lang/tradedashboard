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
  /** Assumed spread of the instrument, in basis points of the price (external model: the move must beat it) */
  spreadBps?: number;
  /** Price history of the other instruments, as columns (external model: cross-market features) */
  context?: Array<{ epic: string; time: number[]; close: number[] }>;
  /** "compare": the external model scores several versions of itself instead of forecasting */
  mode?: "forecast" | "compare";
}

export interface ForecastProvider {
  name: string;
  forecast(req: ForecastRequest): Promise<ForecastResponse>;
}
