import "server-only";
import { getStorage } from "./journal/storage";

const RETRIES = 4;

export class StoreError extends Error {
  constructor(
    public code: "NOT_CONFIGURED" | "NOT_FOUND" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

/** Reads a JSON list; null when no storage is configured. */
export async function readList<T>(key: string): Promise<T[] | null> {
  const storage = getStorage();
  return storage ? (await storage.read<T>(key)).entries : null;
}

/** Read-modify-write with ETag checks, so two simultaneous writes cannot overwrite each other. */
export async function updateList<T, R>(key: string, fn: (items: T[]) => { items: T[]; result: R }): Promise<R> {
  const storage = getStorage();
  if (!storage) throw new StoreError("NOT_CONFIGURED", "Aucun stockage Blob n'est relié au projet : cette fonction n'est pas configurée.");
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const { entries, etag } = await storage.read<T>(key);
    const { items, result } = fn(entries);
    if (await storage.write<T>(key, items, etag)) return result;
  }
  throw new Error(`write to ${key} kept conflicting`);
}
