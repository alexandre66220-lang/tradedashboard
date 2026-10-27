import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_KEEP, collectSnapshot, dailyKey, lastBackup, restoreSnapshot, saveBackup, validateSnapshot } from "@/lib/backup";
import { __resetMemoryStorage, getStorage } from "@/lib/journal/storage";

beforeEach(() => {
  vi.stubEnv("JOURNAL_STORAGE", "memory");
  vi.stubEnv("STORAGE_BACKEND", "");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "");
  __resetMemoryStorage();
});
afterEach(() => vi.unstubAllEnvs());

async function seed() {
  const s = getStorage()!;
  await s.write("journal/GOLD__MINUTE_5__30.json", [{ id: "a" }, { id: "b" }], null);
  await s.write("trades/trades.json", [{ id: "t1" }], null);
  await s.write("alerts/alerts.json", [{ id: "x" }], null);
  await s.write("cache/outlook/GOLD__day.json", [{ big: true }], null); // a computed cache: not worth saving
  await s.write("security/login-attempts.json", [{ id: "ip" }], null); // security counters: not saved either
}

describe("backup", () => {
  it("collects the journal, trades and alerts, and nothing else", async () => {
    await seed();
    const snap = await collectSnapshot(1_700_000_000_000);
    expect(Object.keys(snap.files).sort()).toEqual(["alerts/alerts.json", "journal/GOLD__MINUTE_5__30.json", "trades/trades.json"]);
    expect(snap.files["journal/GOLD__MINUTE_5__30.json"]).toHaveLength(2);
    expect(snap).toMatchObject({ version: 1, createdAt: 1_700_000_000_000 });
  });

  it("writes one file a day (replacing the same day's), and keeps only the last 14", async () => {
    await seed();
    const s = getStorage()!;
    for (let d = 1; d <= 20; d++) await saveBackup(new Date(Date.UTC(2026, 9, d, 3, 30)));
    const res = await saveBackup(new Date(Date.UTC(2026, 9, 20, 18, 0))); // same day again
    expect(res).toMatchObject({ key: "backup/2026-10-20.json", files: 3, entries: 4 });
    const kept = await s.list("backup/");
    expect(kept).toHaveLength(BACKUP_KEEP);
    expect(kept[0]).toBe("backup/2026-10-07.json");
    expect(kept.at(-1)).toBe("backup/2026-10-20.json");
    const last = await lastBackup();
    expect(last?.key).toBe("backup/2026-10-20.json");
    expect(last?.at).toBe(Date.UTC(2026, 9, 20));
  });

  it("restores a snapshot, after keeping the current state under a name that is never pruned", async () => {
    await seed();
    const s = getStorage()!;
    const snap = await collectSnapshot();
    await s.write("trades/trades.json", [{ id: "t1" }, { id: "t2" }, { id: "t3" }], (await s.read("trades/trades.json")).etag); // data changes afterwards
    const out = await restoreSnapshot(snap);
    expect(out.files).toBe(3);
    expect((await s.read("trades/trades.json")).entries).toEqual([{ id: "t1" }]);
    const before = (await s.read<{ files: Record<string, unknown[]> }>(out.safety)).entries[0];
    expect(before.files["trades/trades.json"]).toHaveLength(3);
    for (let d = 1; d <= 20; d++) await saveBackup(new Date(Date.UTC(2026, 9, d)));
    expect(await s.list("backup/")).toContain(out.safety);
  });

  it("is named by day", () => {
    expect(dailyKey(new Date(Date.UTC(2026, 0, 5, 23, 59)))).toBe("backup/2026-01-05.json");
  });
});

describe("validation of an uploaded backup", () => {
  const ok = { version: 1, createdAt: 1, files: { "journal/a.json": [{}], "trades/trades.json": [] } };
  it("accepts a real backup", () => {
    expect(validateSnapshot(ok)).toEqual(ok);
  });
  it("refuses anything else", () => {
    for (const bad of [null, "x", [], {}, { ...ok, version: 2 }, { ...ok, files: [] }, { ...ok, files: { "security/x.json": [] } }, { ...ok, files: { "journal/../x.json": [] } }, { ...ok, files: { "journal/a.json": "no" } }, { ...ok, files: { "journal/é.json": [] } }]) {
      expect(typeof validateSnapshot(bad)).toBe("string");
    }
    const huge = { ...ok, files: { "journal/a.json": new Array(20_001).fill(0) } };
    expect(typeof validateSnapshot(huge)).toBe("string");
  });
});
