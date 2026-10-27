import "server-only";
import { notifyConfigured, sendNotification } from "./notify";
import { StoreError, readList, updateList } from "./store";

// Brute-force protection of the login, shared by every server instance through the store (a counter kept in memory is
// useless on a serverless host: each request may land on a different instance).

export const WINDOW_MS = 15 * 60_000; // failures older than this are forgotten
export const MAX_FAILURES = 5; // failures within the window that lock a client out
export const BASE_LOCK_MS = 15 * 60_000;
export const MAX_LOCK_MS = 24 * 3600_000;
const STRIKES_MS = 24 * 3600_000; // lock-outs within this period make the next one longer
const KEY = "security/login-attempts.json";
const MAX_RECORDS = 200;

export interface Attempt {
  /** Hash of the client address (the address itself is not stored) */
  id: string;
  /** Times (ms) of recent failures */
  fails: number[];
  /** Times (ms) of recent lock-outs */
  strikes: number[];
  lockedUntil: number;
}

/** The address of the visitor, as given by the host (these headers are set by the platform, not by the visitor). */
export function clientIp(req: Request): string {
  const h = req.headers;
  return h.get("x-nf-client-connection-ip") || h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0].trim() || "local";
}

export async function clientId(ip: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`login|${ip}`));
  return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isLocked(a: Attempt | undefined, now: number): boolean {
  return !!a && a.lockedUntil > now;
}

/** Records one failure: five within 15 minutes lock the client out for 15 minutes, doubling at each new lock-out (up to a day). */
export function withFailure(a: Attempt | undefined, id: string, now: number): { next: Attempt; justLocked: boolean } {
  const fails = [...(a?.fails ?? []).filter((t) => now - t < WINDOW_MS), now];
  let strikes = (a?.strikes ?? []).filter((t) => now - t < STRIKES_MS);
  let lockedUntil = a?.lockedUntil ?? 0;
  const justLocked = fails.length >= MAX_FAILURES && lockedUntil <= now;
  if (justLocked) {
    lockedUntil = now + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** strikes.length);
    strikes = [...strikes, now];
  }
  return { next: { id, fails: justLocked ? [] : fails, strikes, lockedUntil }, justLocked };
}

const stale = (a: Attempt, now: number) => a.lockedUntil <= now && a.fails.every((t) => now - t >= WINDOW_MS) && a.strikes.every((t) => now - t >= STRIKES_MS);

// When there is no store (or it fails), a per-instance memory keeps some protection.
const memory = new Map<string, Attempt>();

export function __resetLoginGuard() {
  memory.clear();
}

async function readOne(id: string): Promise<Attempt | undefined> {
  try {
    const list = await readList<Attempt>(KEY);
    if (list) return list.find((a) => a.id === id) ?? memory.get(id);
  } catch {
    /* store down: fall back to memory */
  }
  return memory.get(id);
}

/** Is this client locked out? Returns the seconds left. */
export async function lockStatus(ip: string, now = Date.now()): Promise<{ locked: boolean; retryAfterSec: number }> {
  const a = await readOne(await clientId(ip));
  return isLocked(a, now) ? { locked: true, retryAfterSec: Math.ceil((a!.lockedUntil - now) / 1000) } : { locked: false, retryAfterSec: 0 };
}

/** Counts a failed login. Warns the owner on the phone the moment a client gets locked out. */
export async function recordFailure(ip: string, now = Date.now()): Promise<{ justLocked: boolean }> {
  const id = await clientId(ip);
  let result = { justLocked: false };
  try {
    await updateList<Attempt, void>(KEY, (items) => {
      const { next, justLocked } = withFailure(items.find((a) => a.id === id), id, now);
      result = { justLocked };
      const others = items.filter((a) => a.id !== id && !stale(a, now));
      return { items: [...others, next].slice(-MAX_RECORDS), result: undefined };
    });
  } catch (err) {
    if (!(err instanceof StoreError)) console.warn("[login] attempts store unavailable, counting in memory");
    const { next, justLocked } = withFailure(memory.get(id), id, now);
    memory.set(id, next);
    result = { justLocked };
  }
  if (result.justLocked && notifyConfigured()) {
    await sendNotification({
      title: "Connexion bloquée",
      message: `${MAX_FAILURES} mots de passe erronés de suite sur votre dashboard : l'accès est bloqué pour ce visiteur. Si ce n'était pas vous, pensez à changer DASHBOARD_PASSWORD.`,
      priority: 4,
      tags: ["warning"],
    }).catch(() => false);
  }
  return result;
}

/** A correct password clears the client's failures (but not its history of lock-outs). */
export async function recordSuccess(ip: string, now = Date.now()): Promise<void> {
  const id = await clientId(ip);
  memory.delete(id);
  try {
    await updateList<Attempt, void>(KEY, (items) => ({
      items: items.flatMap((a) => (a.id === id ? (a.strikes.length ? [{ ...a, fails: [], lockedUntil: 0 }] : []) : stale(a, now) ? [] : [a])),
      result: undefined,
    }));
  } catch {
    /* nothing to clear, or the store is down */
  }
}
