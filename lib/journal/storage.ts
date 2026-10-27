import "server-only";
import { getStore } from "@netlify/blobs";
import { BlobNotFoundError, BlobPreconditionFailedError, del, get, head, list, put } from "@vercel/blob";
import type { JournalEntry } from "./types";

/** JSON arrays in a key/value store with optimistic concurrency. Defaults to journal entries. */
export interface JournalStorage {
  read<T = JournalEntry>(key: string): Promise<{ entries: T[]; etag: string | null }>;
  /**
   * Returns false when the blob changed since `etag` was read (caller retries).
   * `force` overwrites whatever is stored, for data that can be rebuilt (the forecast journal).
   */
  write<T = JournalEntry>(key: string, entries: T[], etag: string | null, force?: boolean): Promise<boolean>;
  list(prefix?: string): Promise<string[]>;
  /** Deletes a file (backups older than the retention period). Nothing happens if it does not exist. */
  remove(key: string): Promise<void>;
}

export const PREFIX = "journal/";

export function memoryStorage(): JournalStorage {
  const files = new Map<string, { data: string; version: number }>();
  return {
    async read(key) {
      const f = files.get(key);
      return f ? { entries: JSON.parse(f.data), etag: String(f.version) } : { entries: [], etag: null };
    },
    async write(key, entries, etag, force = false) {
      const f = files.get(key);
      if (!force && (f?.version ?? null) !== (etag === null ? null : Number(etag))) return false;
      files.set(key, { data: JSON.stringify(entries), version: (f?.version ?? 0) + 1 });
      return true;
    },
    async list(prefix = PREFIX) {
      return [...files.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async remove(key) {
      files.delete(key);
    },
  };
}

/** Private Vercel Blob store: one JSON file per (instrument, timeframe, horizon), updated with ETag checks. */
export function blobStorage(): JournalStorage {
  return {
    async read(key) {
      // The ETag comes from the metadata call, the one `ifMatch` is compared with. The ETag header of the download can
      // be a weak or re-encoded value that never matches (every conditional write then fails). Reading the metadata
      // first is safe: if the content changes in between, the stale ETag makes the write fail and the caller retries.
      let etag: string;
      try {
        etag = (await head(key)).etag;
      } catch (err) {
        if (err instanceof BlobNotFoundError) return { entries: [], etag: null };
        throw err;
      }
      const res = await get(key, { access: "private", useCache: false });
      // The blob exists (metadata found) but its content cannot be read: never pretend it is empty, a write would erase it
      if (!res || res.statusCode !== 200) throw new Error(`blob ${key} exists but could not be read (status ${res?.statusCode ?? "none"})`);
      const text = await new Response(res.stream).text();
      return { entries: JSON.parse(text), etag };
    },
    async write(key, entries, etag, force = false) {
      try {
        await put(key, JSON.stringify(entries), {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
          ...(force ? { allowOverwrite: true } : etag ? { ifMatch: etag, allowOverwrite: true } : { allowOverwrite: false }),
        });
        return true;
      } catch (err) {
        if (err instanceof BlobPreconditionFailedError) return false;
        // Creating a file that another instance just created
        if (!etag && err instanceof Error && /already exists/i.test(err.message)) return false;
        throw err;
      }
    },
    async list(prefix = PREFIX) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, cursor });
        keys.push(...page.blobs.map((b) => b.pathname));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return keys.sort();
    },
    async remove(key) {
      try {
        await del(key);
      } catch (err) {
        if (!(err instanceof BlobNotFoundError)) throw err;
      }
    },
  };
}

/**
 * Netlify Blobs: one site-wide store, JSON values, conditional writes with `onlyIfMatch` / `onlyIfNew`.
 * Strong consistency, so that a read after a write sees it (and the ETag is the current one).
 */
// A Netlify Blobs call that never answers would hold the whole request until the platform cuts it (30 s); fail sooner instead.
const NETLIFY_TIMEOUT_MS = 10_000;
function within<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Netlify Blobs did not answer in time")), NETLIFY_TIMEOUT_MS);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

export function netlifyStorage(): JournalStorage {
  const store = () => getStore({ name: process.env.NETLIFY_BLOBS_STORE || "tradedashboard", consistency: "strong" });
  return {
    async read<T>(key: string) {
      const found = await within(store().getWithMetadata(key, { type: "json", consistency: "strong" }));
      if (!found) return { entries: [] as T[], etag: null };
      return { entries: (Array.isArray(found.data) ? found.data : []) as T[], etag: found.etag ?? null };
    },
    async write<T>(key: string, entries: T[], etag: string | null, force = false) {
      const s = store();
      if (force) {
        await within(s.setJSON(key, entries));
        return true;
      }
      const res = await within(etag ? s.setJSON(key, entries, { onlyIfMatch: etag }) : s.setJSON(key, entries, { onlyIfNew: true }));
      return res.modified;
    },
    async list(prefix = PREFIX) {
      const { blobs } = await within(store().list({ prefix }));
      return blobs.map((b) => b.key).sort();
    },
    async remove(key) {
      await store().delete(key);
    },
  };
}

type Backend = "netlify" | "vercel" | "memory";

/** Which store to use: STORAGE_BACKEND if set, else Netlify when running there, else Vercel Blob when a token exists. */
function backend(): Backend | null {
  const forced = process.env.STORAGE_BACKEND;
  if (forced === "netlify" || forced === "vercel" || forced === "memory") return forced;
  if (process.env.NETLIFY_BLOBS_CONTEXT || (globalThis as { netlifyBlobsContext?: unknown }).netlifyBlobsContext) return "netlify";
  if (process.env.BLOB_READ_WRITE_TOKEN) return "vercel";
  // Local development only: non-persistent, handy to try the feature without a store
  if (process.env.JOURNAL_STORAGE === "memory") return "memory";
  return null;
}

let memory: JournalStorage | null = null;

/** Tests only: forget what the in-memory store holds. */
export function __resetMemoryStorage() {
  memory = null;
}

/** null when the journal is not configured (no store available). */
export function getStorage(): JournalStorage | null {
  switch (backend()) {
    case "netlify":
      return netlifyStorage();
    case "vercel":
      return process.env.BLOB_READ_WRITE_TOKEN ? blobStorage() : null;
    case "memory":
      return (memory ??= memoryStorage());
    default:
      return null;
  }
}
