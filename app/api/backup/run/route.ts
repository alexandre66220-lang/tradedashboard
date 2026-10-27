import { NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/auth";
import { saveBackup } from "@/lib/backup";
import { handleError, jsonError } from "@/lib/http";
import { getStorage } from "@/lib/journal/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily copy of the journal, trades and alerts into `backup/<date>.json` (the last 14 are kept). Called by the scheduler
 * with `Authorization: Bearer $CRON_SECRET`; this path bypasses the dashboard cookie in proxy.ts, so it checks the
 * secret itself and fails closed.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return jsonError("CONFIG_MISSING", "CRON_SECRET n'est pas défini côté serveur.", 503);
  if (!timingSafeEqualStr(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return jsonError("UNAUTHORIZED", "Authentification requise.", 401);
  }
  if (!getStorage()) return NextResponse.json({ saved: false, note: "stockage non configuré" });
  try {
    return NextResponse.json({ saved: true, ...(await saveBackup()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
