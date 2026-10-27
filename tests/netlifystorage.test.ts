import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake of the documented Netlify Blobs behaviour: JSON values, ETags, conditional writes that answer { modified: false }
const files = new Map<string, { value: unknown; version: number }>();
const opened: Array<{ name: string; consistency?: string }> = [];

vi.mock("@netlify/blobs", () => ({
  getStore: (opts: { name: string; consistency?: string }) => {
    opened.push(opts);
    return {
      async getWithMetadata(key: string) {
        const f = files.get(key);
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
      async list({ prefix }: { prefix?: string }) {
        return { blobs: [...files.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((key) => ({ key, etag: "x" })) };
      },
    };
  },
}));

import { getStorage, netlifyStorage } from "@/lib/journal/storage";

beforeEach(() => {
  files.clear();
  opened.length = 0;
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
