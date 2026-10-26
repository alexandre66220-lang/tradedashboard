import type { CalendarEvent, NewsProfile } from "./calendar";
import { relevantEvents } from "./calendar";
import type { Trade } from "./trades";
import type { Candle } from "./types";

export type AlertOp = "above" | "below";

export interface PriceAlert {
  id: string;
  epic: string;
  op: AlertOp;
  price: number;
  note?: string;
  /** ms */
  createdAt: number;
  /** ms, set once the notification went out */
  firedAt?: number;
}

export interface SentRecord {
  key: string;
  at: number;
}

export interface Notification {
  title: string;
  message: string;
  /** 1 (min) to 5 (urgent) */
  priority: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
}

export const MAX_ALERTS = 100;
const NOTE_MAX = 200;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseNewAlert(body: unknown, validEpics: string[], now = Date.now()): Parsed<Omit<PriceAlert, "id">> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.epic !== "string" || !validEpics.includes(b.epic)) return { ok: false, error: "Instrument inconnu." };
  if (b.op !== "above" && b.op !== "below") return { ok: false, error: "Condition invalide." };
  if (typeof b.price !== "number" || !Number.isFinite(b.price) || b.price <= 0) return { ok: false, error: "Prix invalide." };
  if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > NOTE_MAX)) return { ok: false, error: `Note trop longue (${NOTE_MAX} caractères maximum).` };
  return { ok: true, value: { epic: b.epic, op: b.op, price: b.price, createdAt: now, ...(typeof b.note === "string" && b.note.trim() ? { note: b.note.trim() } : {}) } };
}

/** Did price reach `price` (from below for "above", from above for "below") in 1-minute candles since `sinceSec`? */
export function priceHit(candles: Candle[], op: AlertOp, price: number, sinceSec: number): { hit: boolean; at?: number } {
  for (const c of candles) {
    if (c.time + 60 <= sinceSec) continue; // candle ended before the alert existed
    if (op === "above" ? c.high >= price : c.low <= price) return { hit: true, at: c.time };
  }
  return { hit: false };
}

/** First time the stop or target of an open trade was touched; the stop wins when a candle touches both. */
export function tradeHit(candles: Candle[], t: Trade): { kind: "stop" | "target" | null; at?: number } {
  const since = Math.floor(t.openedAt / 1000);
  for (const c of candles) {
    if (c.time + 60 <= since) continue;
    const stopHit = t.stop !== undefined && (t.side === "long" ? c.low <= t.stop : c.high >= t.stop);
    if (stopHit) return { kind: "stop", at: c.time };
    const targetHit = t.target !== undefined && (t.side === "long" ? c.high >= t.target : c.low <= t.target);
    if (targetHit) return { kind: "target", at: c.time };
  }
  return { kind: null };
}

const num = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 4 });

export interface CheckDeps {
  /** ms */
  now: number;
  instruments: Array<{ epic: string; name: string } & NewsProfile>;
  alerts: PriceAlert[];
  trades: Trade[];
  sent: SentRecord[];
  /** null when the calendar is unavailable */
  events: CalendarEvent[] | null;
  /** 1-minute candles, oldest first */
  candles(epic: string): Promise<Candle[]>;
  /** true when the notification was delivered */
  notify(n: Notification): Promise<boolean>;
}

export interface CheckResult {
  sent: number;
  failed: number;
  firedAlerts: string[];
  newSent: SentRecord[];
}

const NEWS_AHEAD_MIN = 35;

/** Decides which notifications are due, sends them, and reports what to remember. Nothing is sent twice. */
export async function runChecks(d: CheckDeps): Promise<CheckResult> {
  const done = new Set(d.sent.map((s) => s.key));
  const result: CheckResult = { sent: 0, failed: 0, firedAlerts: [], newSent: [] };
  const name = (epic: string) => d.instruments.find((i) => i.epic === epic)?.name ?? epic;
  const nowSec = Math.floor(d.now / 1000);

  const deliver = async (n: Notification, remember: () => void) => {
    let ok = false;
    try {
      ok = await d.notify(n);
    } catch {
      ok = false;
    }
    if (ok) {
      result.sent++;
      remember();
    } else result.failed++; // not remembered: tried again at the next check
  };

  // 1. Major announcements about to happen
  if (d.events) {
    const seen = new Set<string>();
    for (const inst of d.instruments) {
      for (const e of relevantEvents(d.events, inst, nowSec, 0, NEWS_AHEAD_MIN)) {
        if (e.impact !== "high" || seen.has(e.id) || done.has(`news|${e.id}`)) continue;
        seen.add(e.id);
        const concerned = d.instruments.filter((i) => relevantEvents([e], i, nowSec, 0, NEWS_AHEAD_MIN).length > 0).map((i) => i.name);
        await deliver(
          {
            title: `Annonce majeure dans ${Math.max(1, Math.round(e.minutesFromNow))} min`,
            message: `${e.title} (${e.currency})${e.forecast ? ` · prévu ${e.forecast}` : ""}${e.previous ? ` · précédent ${e.previous}` : ""}. Concerne : ${concerned.join(", ")}. Les prix peuvent sauter : le feu passe au rouge.`,
            priority: 4,
            tags: ["warning"],
          },
          () => result.newSent.push({ key: `news|${e.id}`, at: d.now }),
        );
      }
    }
  }

  const cache = new Map<string, Promise<Candle[]>>();
  const candles = (epic: string) => (cache.get(epic) ?? cache.set(epic, d.candles(epic)).get(epic)!);

  // 2. Price alerts
  for (const a of d.alerts.filter((x) => x.firedAt === undefined)) {
    let hit: ReturnType<typeof priceHit>;
    try {
      hit = priceHit(await candles(a.epic), a.op, a.price, Math.floor(a.createdAt / 1000));
    } catch {
      result.failed++;
      continue;
    }
    if (!hit.hit) continue;
    await deliver(
      {
        title: `${name(a.epic)} : ${num(a.price)} ${a.op === "above" ? "atteint par le haut" : "atteint par le bas"}`,
        message: `Le prix a ${a.op === "above" ? "touché ou dépassé" : "touché ou franchi vers le bas"} ${num(a.price)}.${a.note ? ` Note : ${a.note}` : ""}`,
        priority: 4,
        tags: ["chart_with_upwards_trend"],
      },
      () => result.firedAlerts.push(a.id),
    );
  }

  // 3. Stop or target of the trades you logged as open
  for (const t of d.trades.filter((x) => x.exit === undefined && (x.stop !== undefined || x.target !== undefined))) {
    let hit: ReturnType<typeof tradeHit>;
    try {
      hit = tradeHit(await candles(t.epic), t);
    } catch {
      result.failed++;
      continue;
    }
    if (!hit.kind) continue;
    const key = `trade|${t.id}|${hit.kind}`;
    if (done.has(key)) continue;
    const level = hit.kind === "stop" ? t.stop! : t.target!;
    await deliver(
      {
        title: `${hit.kind === "stop" ? "Stop" : "Objectif"} touché : ${name(t.epic)}`,
        message: `Votre ${t.side === "long" ? "achat" : "vente"} (entrée ${num(t.entry)}) a atteint ${hit.kind === "stop" ? "son stop" : "son objectif"} à ${num(level)}. Pensez à noter la clôture dans le journal.`,
        priority: hit.kind === "stop" ? 5 : 4,
        tags: [hit.kind === "stop" ? "rotating_light" : "white_check_mark"],
      },
      () => result.newSent.push({ key, at: d.now }),
    );
  }
  return result;
}

const KEEP_SENT_MS = 14 * 24 * 3600_000;
/** Adds new records and forgets old ones. */
export function mergeSent(existing: SentRecord[], added: SentRecord[], now: number): SentRecord[] {
  const known = new Set(existing.map((s) => s.key));
  return [...existing, ...added.filter((s) => !known.has(s.key))].filter((s) => now - s.at < KEEP_SENT_MS);
}
