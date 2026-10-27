import { NextResponse } from "next/server";
import { collectSnapshot, restoreSnapshot, validateSnapshot } from "@/lib/backup";
import { handleError, jsonError } from "@/lib/http";
import { getStorage } from "@/lib/journal/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY = 10 * 1024 * 1024;

/** Download of a full backup (journal, trades, alerts) as one JSON file. Behind the dashboard password like everything else. */
export async function GET() {
  if (!getStorage()) return jsonError("NOT_CONFIGURED", "Aucun stockage configuré : rien à sauvegarder.", 501);
  try {
    const snap = await collectSnapshot();
    return new NextResponse(JSON.stringify(snap), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="tradedashboard-sauvegarde-${new Date(snap.createdAt).toISOString().slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleError(err);
  }
}

/** Restores a downloaded backup. The state before the restoration is kept in the store first. */
export async function POST(req: Request) {
  if (!getStorage()) return jsonError("NOT_CONFIGURED", "Aucun stockage configuré.", 501);
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return jsonError("TOO_LARGE", "Fichier trop volumineux.", 413);
  const text = await req.text();
  if (text.length > MAX_BODY) return jsonError("TOO_LARGE", "Fichier trop volumineux.", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonError("BAD_REQUEST", "Ce fichier n'est pas du JSON.", 400);
  }
  const snap = validateSnapshot(body);
  if (typeof snap === "string") return jsonError("BAD_REQUEST", snap, 400);
  try {
    const done = await restoreSnapshot(snap);
    return NextResponse.json(done, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
