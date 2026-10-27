import { beforeEach, describe, expect, it, vi } from "vitest";

// A small fake of the Vercel Blob API that behaves like the real one where it matters here:
// - `head` gives the blob's ETag (the value `ifMatch` is compared with)
// - the download carries a *weak* ETag header, which can never satisfy `ifMatch`
// - an existing blob can only be replaced with allowOverwrite, and only if ifMatch (when given) is current
const store = new Map<string, { body: string; version: number }>();
let unreadable = false;

vi.mock("@vercel/blob", async () => {
  const actual = await vi.importActual<typeof import("@vercel/blob")>("@vercel/blob");
  return {
    ...actual,
    head: vi.fn(async (key: string) => {
      const f = store.get(key);
      if (!f) throw new actual.BlobNotFoundError();
      return { etag: `"v${f.version}"` };
    }),
    get: vi.fn(async (key: string) => {
      const f = store.get(key);
      if (!f) return null;
      if (unreadable) return { statusCode: 304, stream: null, blob: { etag: "" } };
      return { statusCode: 200, stream: new Response(f.body).body, blob: { etag: `W/"v${f.version}"` } };
    }),
    put: vi.fn(async (key: string, body: string, opts: { allowOverwrite?: boolean; ifMatch?: string }) => {
      const f = store.get(key);
      if (f && !opts.allowOverwrite) throw new actual.BlobError("This blob already exists, use `allowOverwrite: true` to overwrite it");
      if (f && opts.ifMatch && opts.ifMatch !== `"v${f.version}"`) throw new actual.BlobPreconditionFailedError();
      store.set(key, { body, version: (f?.version ?? 0) + 1 });
      return {};
    }),
    list: vi.fn(async () => ({ blobs: [...store.keys()].map((pathname) => ({ pathname })), hasMore: false })),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

import { blobStorage } from "@/lib/journal/storage";
import { recordForecast, resolveEntries, seriesKey, __resetJournalCache, type SeriesRef } from "@/lib/journal/journal";
import type { JournalStorage } from "@/lib/journal/storage";

beforeEach(() => {
  store.clear();
  unreadable = false;
  __resetJournalCache();
});

describe("blob storage", () => {
  it("creates, then updates with the ETag of the metadata (not the download header)", async () => {
    const s = blobStorage();
    expect(await s.read("a.json")).toEqual({ entries: [], etag: null });
    expect(await s.write("a.json", [{ n: 1 }], null)).toBe(true);
    const r1 = await s.read<{ n: number }>("a.json");
    expect(r1.entries).toEqual([{ n: 1 }]);
    expect(r1.etag).toBe('"v1"');
    expect(await s.write("a.json", [{ n: 1 }, { n: 2 }], r1.etag)).toBe(true);
    const r2 = await s.read<{ n: number }>("a.json");
    expect(r2.entries).toHaveLength(2);
    expect(await s.write("a.json", [], r2.etag)).toBe(true);
  });

  it("reports a conflict instead of overwriting a newer version", async () => {
    const s = blobStorage();
    await s.write("a.json", [{ n: 1 }], null);
    const mine = await s.read("a.json");
    const theirs = await s.read("a.json");
    expect(await s.write("a.json", [{ n: 2 }], theirs.etag)).toBe(true);
    expect(await s.write("a.json", [{ n: 3 }], mine.etag)).toBe(false);
    expect((await s.read<{ n: number }>("a.json")).entries).toEqual([{ n: 2 }]);
  });

  it("reports a conflict when two instances create the same file at once", async () => {
    const s = blobStorage();
    expect(await s.write("new.json", [{ n: 1 }], null)).toBe(true);
    expect(await s.write("new.json", [{ n: 2 }], null)).toBe(false);
  });

  it("refuses to treat an existing but unreadable file as empty", async () => {
    const s = blobStorage();
    await s.write("a.json", [{ n: 1 }], null);
    unreadable = true;
    await expect(s.read("a.json")).rejects.toThrow(/could not be read/);
  });

  it("removes a file, and does not mind one that is already gone", async () => {
    const s = blobStorage();
    await s.write("a.json", [1], null);
    await s.remove("a.json");
    expect(store.has("a.json")).toBe(false);
    await expect(s.remove("a.json")).resolves.toBeUndefined();
  });

  it("can force an overwrite", async () => {
    const s = blobStorage();
    await s.write("a.json", [{ n: 1 }], null);
    expect(await s.write("a.json", [{ n: 9 }], null, true)).toBe(true);
    expect((await s.read<{ n: number }>("a.json")).entries).toEqual([{ n: 9 }]);
  });
});

describe("journal under persistent conflicts", () => {
  const series: SeriesRef = { epic: "GOLD", resolution: "MINUTE_5", resMinutes: 5, horizon: 30 };
  const T0 = 1_700_000_000 - (1_700_000_000 % 1800);
  const candles = Array.from({ length: 3 }, (_, i) => ({ time: T0 + i * 300, open: 100, high: 100, low: 100, close: 100 }));
  const forecast = { direction: "up" as const, confidence: 0.6, points: [{ time: 0, value: 101, low: 0, high: 0 }], source: "ML v2, test" };

  /** A storage whose conditional writes never succeed, like an ETag that never matches. */
  function stuck(): JournalStorage & { forced: number } {
    const files = new Map<string, string>();
    const st = {
      forced: 0,
      async read(key: string) {
        return { entries: JSON.parse(files.get(key) ?? "[]"), etag: files.has(key) ? "weak" : null };
      },
      async write(key: string, entries: unknown[], _etag: string | null, force = false) {
        if (!force) return false;
        st.forced++;
        files.set(key, JSON.stringify(entries));
        return true;
      },
      async list() {
        return [...files.keys()];
      },
      async remove(key: string) {
        files.delete(key);
      },
    };
    return st as unknown as JournalStorage & { forced: number };
  }

  it("falls back to an overwrite so the journal still fills, and does not hammer a failing store", async () => {
    const s = stuck();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await recordForecast(s, series, candles, forecast, 1000, 60, false)).toBe(true);
    const stored = (await s.read(seriesKey(series))).entries as Array<{ id: string; sentiment: number }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].sentiment).toBe(60);
    expect(resolveEntries(stored as never, candles).changed).toBe(false);
    warn.mockRestore();
  });

  it("waits a minute before retrying a window that failed", async () => {
    const calls = { n: 0 };
    const broken: JournalStorage = {
      async read() {
        calls.n++;
        throw new Error("store down");
      },
      async write() {
        return false;
      },
      async list() {
        return [];
      },
      async remove() {},
    };
    await expect(recordForecast(broken, series, candles, forecast, 1000)).rejects.toThrow("store down");
    const first = calls.n;
    expect(await recordForecast(broken, series, candles, forecast, 20_000)).toBe(false); // within the cooldown
    expect(calls.n).toBe(first);
    await expect(recordForecast(broken, series, candles, forecast, 90_000)).rejects.toThrow("store down");
  });
});
