import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake of the documented Netlify Blobs behaviour: JSON values, ETags, conditional writes that answer { modified: false }
const files = new Map<string, { value: unknown; version: number }>();
const opened: Array<{ name: string; consistency?: string }> = [];
// Production behaviour: the read of a file that does not exist never answers
let hangOnMissing = false;
const reads: string[] = [];

vi.mock("@netlify/blobs", () => ({
  getStore: (opts: { name: string; consistency?: string }) => {
    opened.push(opts);
    return {
      async getWithMetadata(key: string) {
        reads.push(key);
        const f = files.get(key);
        if (!f && hangOnMissing) return new Promise<never>(() => {});
        return f ? { data: f.value, etag: `"${f.version}"`, metadata: {} } : null;
      },
      async setJSON(key: string, value: unknown, cond?: { onlyIfNew?: boolean; onlyIfMatch?: string }) {
        const f = files.get(key);
        if (cond?.onlyIfNew && f) return { modified: false };
        if (cond?.onlyIfMatch && (!f || cond.onlyIfMatch !== `"${f.version}"`)) return { modified: false };
        const version = (f?.version ?? 0) + 1;
        files.set(key, { value, version });
        return { modified: true, etag: `"${version}"` };
      },
      async delete(key: string) {
        files.delete(key);
      },
      async list({ prefix }: { prefix?: string }) {
        return { blobs: [...files.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((key) => ({ key, etag: "x" })) };
      },
    };
  },
}));

import { getStorage, netlifyStorage, __resetMemoryStorage } from "@/lib/journal/storage";

beforeEach(() => {
  files.clear();
  opened.length = 0;
  reads.length = 0;
  hangOnMissing = false;
  __resetMemoryStorage();
});
afterEach(() => vi.unstubAllEnvs());

describe("Netlify Blobs storage", () => {
  it("creates only when new, then updates only with the current ETag", async () => {
    const s = netlifyStorage();
    expect(await s.read("journal/a.json")).toEqual({ entries: [], etag: null });
    expect(await s.write("journal/a.json", [{ n: 1 }], null)).toBe(true);
    expect(await s.write("journal/a.json", [{ n: 2 }], null)).toBe(false); // someone else created it first
    const r = await s.read<{ n: number }>("journal/a.json");
    expect(r.entries).toEqual([{ n: 1 }]);
    expect(await s.write("journal/a.json", [{ n: 1 }, { n: 2 }], r.etag)).toBe(true);
    expect(await s.write("journal/a.json", [], r.etag)).toBe(false); // stale ETag
    expect((await s.read("journal/a.json")).entries).toHaveLength(2);
  });

  it("can force an overwrite and lists by prefix", async () => {
    const s = netlifyStorage();
    await s.write("journal/a.json", [1], null);
    await s.write("trades/t.json", [2], null);
    expect(await s.write("journal/a.json", [9], "stale", true)).toBe(true);
    expect((await s.read<number>("journal/a.json")).entries).toEqual([9]);
    expect(await s.list("journal/")).toEqual(["journal/a.json"]);
  });

  it("removes a file", async () => {
    const s = netlifyStorage();
    await s.write("backup/a.json", [1], null);
    await s.remove("backup/a.json");
    expect(await s.list("backup/")).toEqual([]);
  });

  it("opens one strongly consistent store, whose name can be changed", async () => {
    const s = netlifyStorage();
    await s.read("x");
    vi.stubEnv("NETLIFY_BLOBS_STORE", "other");
    await netlifyStorage().read("x");
    expect(opened.map((o) => o.name)).toEqual(["tradedashboard", "other"]);
    expect(opened.every((o) => o.consistency === "strong")).toBe(true);
  });

  it("is chosen on Netlify, or by STORAGE_BACKEND, ahead of the Vercel token", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "tok");
    vi.stubEnv("STORAGE_BACKEND", "");
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "");
    vi.stubEnv("JOURNAL_STORAGE", "");
    const vercel = getStorage();
    expect(vercel).not.toBeNull();
    vi.stubEnv("STORAGE_BACKEND", "netlify");
    expect(getStorage()).not.toBe(vercel);
    vi.stubEnv("STORAGE_BACKEND", "");
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "abc");
    expect(getStorage()).not.toBeNull();
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect(getStorage()).toBeNull();
  });
});

describe("a store that never answers for a missing file", () => {
  it("answers an absent file with an empty list without reading it", async () => {
    hangOnMissing = true;
    const s = netlifyStorage();
    expect(await s.read("alerts/alerts.json")).toEqual({ entries: [], etag: null });
    expect(reads).toEqual([]);
  });

  it("does not mistake a longer file name for the file", async () => {
    hangOnMissing = true;
    const s = netlifyStorage();
    await s.write("alerts/alerts.json.bak", [1], null);
    expect(await s.read("alerts/alerts.json")).toEqual({ entries: [], etag: null });
    expect(reads).toEqual([]);
  });

  it("creates the file, then reads it", async () => {
    hangOnMissing = true;
    const s = netlifyStorage();
    expect(await s.read("alerts/alerts.json")).toEqual({ entries: [], etag: null });
    expect(await s.write("alerts/alerts.json", [{ a: 1 }], null)).toBe(true);
    expect((await s.read<{ a: number }>("alerts/alerts.json")).entries).toEqual([{ a: 1 }]);
  });

  it("reads again with the list when the file was removed behind its back", async () => {
    const s = netlifyStorage();
    await s.write("trades/t.json", [1], null);
    await s.read("trades/t.json");
    files.delete("trades/t.json");
    expect(await s.read("trades/t.json")).toEqual({ entries: [], etag: null });
  });
});
