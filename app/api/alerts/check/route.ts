import { NextResponse } from "next/server";
import { INSTRUMENTS } from "@/config/instruments";
import { mergeSent, runChecks, type PriceAlert, type SentRecord } from "@/lib/alerts";
import { timingSafeEqualStr } from "@/lib/auth";
import { getCalendar } from "@/lib/calendar-source";
import { getCandles } from "@/lib/capital";
import { handleError, jsonError } from "@/lib/http";
import { backend, getStorage, netlifyDiagnostics } from "@/lib/journal/storage";
import { notifyConfigured, sendNotification } from "@/lib/notify";
import { readList, updateList } from "@/lib/store";
import { readTrades } from "@/lib/trades-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ALERTS_KEY = "alerts/alerts.json";
const SENT_KEY = "alerts/sent.json";

/**
 * Called every few minutes by an external scheduler (cron-job.org, ...) with `Authorization: Bearer $CRON_SECRET`.
 * This path bypasses the dashboard cookie in proxy.ts, so it checks the secret itself and fails closed.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return jsonError("CONFIG_MISSING", "CRON_SECRET n'est pas défini côté serveur.", 503);
  if (!timingSafeEqualStr(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return jsonError("UNAUTHORIZED", "Authentification requise.", 401);
  }
  // Temporary: while Netlify Blobs misbehaves, each check writes what works and what does not into the function logs
  if (backend() === "netlify") {
    const d = await netlifyDiagnostics().catch(() => null);
    if (d) console.warn(`[storage-diag] ${d.context} | ${d.steps.join(" | ")}`);
  }
  if (!notifyConfigured()) return NextResponse.json({ sent: 0, note: "notifications non configurées (NTFY_TOPIC)" });
  if (!getStorage()) return NextResponse.json({ sent: 0, note: "stockage non configuré" });

  try {
    const now = Date.now();
    const [alerts, trades, sent, events] = await Promise.all([
      readList<PriceAlert>(ALERTS_KEY),
      readTrades(),
      readList<SentRecord>(SENT_KEY),
      getCalendar().then((c) => c.events).catch(() => null),
    ]);
    const r = await runChecks({
      now,
      instruments: INSTRUMENTS,
      alerts: alerts ?? [],
      trades: trades ?? [],
      sent: sent ?? [],
      events,
      candles: (epic) => getCandles(epic, "MINUTE", 1000, 10_000),
      notify: sendNotification,
    });
    if (r.firedAlerts.length) {
      const fired = new Set(r.firedAlerts);
      await updateList<PriceAlert, null>(ALERTS_KEY, (items) => ({ items: items.map((a) => (fired.has(a.id) ? { ...a, firedAt: now } : a)), result: null }));
    }
    if (r.newSent.length) {
      await updateList<SentRecord, null>(SENT_KEY, (items) => ({ items: mergeSent(items, r.newSent, now), result: null }));
    }
    return NextResponse.json({ sent: r.sent, failed: r.failed, fired: r.firedAlerts.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
