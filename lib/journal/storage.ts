import "server-only";
import { BlobPreconditionFailedError, get, list, put } from "@vercel/blob";
import type { JournalEntry } from "./types";

export interface JournalStorage {
  read(key: string): Promise<{ entries: JournalEntry[]; etag: string | null }>;
  /** Returns false when the blob changed since `etag` was read (caller retries). */
  write(key: string, entries: JournalEntry[], etag: string | null): Promise<boolean>;
  list(): Promise<string[]>;
}

export const PREFIX = "journal/";

export function memoryStorage(): JournalStorage {
  const files = new Map<string, { data: string; version: number }>();
  return {
    async read(key) {
      const f = files.get(key);
      return f ? { entries: JSON.parse(f.data), etag: String(f.version) } : { entries: [], etag: null };
    },
    async write(key, entries, etag) {
      const f = files.get(key);
      if ((f?.version ?? null) !== (etag === null ? null : Number(etag))) return false;
      files.set(key, { data: JSON.stringify(entries), version: (f?.version ?? 0) + 1 });
      return true;
    },
    async list() {
      return [...files.keys()].sort();
    },
  };
}

/** Private Vercel Blob store: one JSON file per (instrument, timeframe, horizon), updated with ETag checks. */
export function blobStorage(): JournalStorage {
  return {
    async read(key) {
      const res = await get(key, { access: "private", useCache: false });
      if (!res || res.statusCode !== 200) return { entries: [], etag: null };
      const text = await new Response(res.stream).text();
      return { entries: JSON.parse(text) as JournalEntry[], etag: res.blob.etag };
    },
    async write(key, entries, etag) {
      try {
        await put(key, JSON.stringify(entries), {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
          ...(etag ? { ifMatch: etag } : { allowOverwrite: false }),
        });
        return true;
      } catch (err) {
        if (err instanceof BlobPreconditionFailedError) return false;
        // Creating a file that another instance just created
        if (!etag && err instanceof Error && /already exists/i.test(err.message)) return false;
        throw err;
      }
    },
    async list() {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: PREFIX, cursor });
        keys.push(...page.blobs.map((b) => b.pathname));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return keys.sort();
    },
  };
}

let memory: JournalStorage | null = null;

/** null when the journal is not configured (no Blob store connected). */
export function getStorage(): JournalStorage | null {
  if (process.env.BLOB_READ_WRITE_TOKEN) return blobStorage();
  // Local development only: non-persistent, handy to try the feature without a Blob store
  if (process.env.JOURNAL_STORAGE === "memory") return (memory ??= memoryStorage());
  return null;
}
