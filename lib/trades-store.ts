import "server-only";
import { getStorage } from "./journal/storage";
import type { Trade } from "./trades";

const KEY = "trades/trades.json";
const RETRIES = 4;

export class StoreError extends Error {
  constructor(
    public code: "NOT_CONFIGURED" | "NOT_FOUND" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

/** Reads the trade log; null when no storage is configured. */
export async function readTrades(): Promise<Trade[] | null> {
  const storage = getStorage();
  return storage ? (await storage.read<Trade>(KEY)).entries : null;
}

/** Read-modify-write with ETag checks, so two simultaneous writes cannot overwrite each other. */
export async function updateTrades<R>(fn: (trades: Trade[]) => { trades: Trade[]; result: R }): Promise<R> {
  const storage = getStorage();
  if (!storage) throw new StoreError("NOT_CONFIGURED", "Le journal de trades n'est pas configuré : aucun stockage Blob n'est relié au projet.");
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const { entries, etag } = await storage.read<Trade>(KEY);
    const { trades, result } = fn(entries);
    if (await storage.write<Trade>(KEY, trades, etag)) return result;
  }
  throw new Error("trade log write kept conflicting");
}
