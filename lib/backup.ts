import "server-only";
import { getStorage } from "./journal/storage";

/** What is worth keeping: the forecast journal, the real trades and the alerts. Computed caches and security counters are not. */
export const BACKUP_PREFIXES = ["journal/", "trades/", "alerts/"] as const;
export const BACKUP_KEEP = 14;
const DAILY = /^backup\/\d{4}-\d{2}-\d{2}\.json$/;
const MAX_FILES = 500;
const MAX_ENTRIES_PER_FILE = 20_000;

export interface Snapshot {
  version: 1;
  createdAt: number;
  files: Record<string, unknown[]>;
}

export const dailyKey = (now = new Date()) => `backup/${now.toISOString().slice(0, 10)}.json`;

function storageOrThrow() {
  const storage = getStorage();
  if (!storage) throw new Error("Aucun stockage configuré.");
  return storage;
}

/** Every file under the backed-up prefixes, as one object. */
export async function collectSnapshot(now = Date.now()): Promise<Snapshot> {
  const storage = storageOrThrow();
  const keys = (await Promise.all(BACKUP_PREFIXES.map((p) => storage.list(p)))).flat();
  const files: Record<string, unknown[]> = {};
  for (const key of keys) files[key] = (await storage.read<unknown>(key)).entries;
  return { version: 1, createdAt: now, files };
}

/** Writes today's snapshot (replacing an earlier one of the same day) and removes the daily backups beyond the retention. */
export async function saveBackup(now = new Date()): Promise<{ key: string; files: number; entries: number; kept: number; removed: number }> {
  const storage = storageOrThrow();
  const snap = await collectSnapshot(now.getTime());
  const key = dailyKey(now);
  await storage.write(key, [snap], null, true);
  const daily = (await storage.list("backup/")).filter((k) => DAILY.test(k)).sort();
  const old = daily.slice(0, Math.max(0, daily.length - BACKUP_KEEP));
  for (const k of old) await storage.remove(k);
  return { key, files: Object.keys(snap.files).length, entries: Object.values(snap.files).reduce((a, e) => a + e.length, 0), kept: daily.length - old.length, removed: old.length };
}

/** Date of the latest daily backup, from its file name; null if there is none. */
export async function lastBackup(): Promise<{ key: string; at: number } | null> {
  const storage = getStorage();
  if (!storage) return null;
  const latest = (await storage.list("backup/")).filter((k) => DAILY.test(k)).sort().at(-1);
  return latest ? { key: latest, at: Date.parse(`${latest.slice(7, 17)}T00:00:00Z`) } : null;
}

/** Checks an uploaded snapshot; returns it, or a message saying what is wrong. */
export function validateSnapshot(x: unknown): Snapshot | string {
  const s = x as Partial<Snapshot> | null;
  if (!s || typeof s !== "object" || s.version !== 1 || typeof s.createdAt !== "number" || !s.files || typeof s.files !== "object" || Array.isArray(s.files)) {
    return "Ce fichier n'est pas une sauvegarde de ce dashboard.";
  }
  const keys = Object.keys(s.files);
  if (keys.length > MAX_FILES) return "Sauvegarde trop volumineuse.";
  for (const key of keys) {
    if (!BACKUP_PREFIXES.some((p) => key.startsWith(p)) || key.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(key)) return `Fichier inattendu dans la sauvegarde : ${key.slice(0, 60)}.`;
    const entries = s.files[key];
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES_PER_FILE) return `Contenu invalide pour ${key}.`;
  }
  return s as Snapshot;
}

/**
 * Puts a snapshot back, replacing the files it contains (files it does not contain are left alone). The current state is
 * saved first, under a name that is never deleted automatically.
 */
export async function restoreSnapshot(snap: Snapshot): Promise<{ files: number; safety: string }> {
  const storage = storageOrThrow();
  const before = await collectSnapshot();
  const safety = `backup/avant-restauration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await storage.write(safety, [before], null, true);
  let files = 0;
  for (const [key, entries] of Object.entries(snap.files)) {
    await storage.write(key, entries, null, true);
    files++;
  }
  return { files, safety };
}
