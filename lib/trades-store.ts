import "server-only";
import { readList, StoreError, updateList } from "./store";
import type { Trade } from "./trades";

export { StoreError };

const KEY = "trades/trades.json";

/** Reads the trade log; null when no storage is configured. */
export const readTrades = () => readList<Trade>(KEY);

export function updateTrades<R>(fn: (trades: Trade[]) => { trades: Trade[]; result: R }): Promise<R> {
  return updateList<Trade, R>(KEY, (items) => {
    const { trades, result } = fn(items);
    return { items: trades, result };
  });
}
