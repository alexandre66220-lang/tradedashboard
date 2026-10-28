import "server-only";
import { NextResponse } from "next/server";
import { CapitalError } from "./capital";
import { findInstrument, isResolutionKey, RESOLUTIONS, type Instrument, type ResolutionKey } from "@/config/instruments";

export function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export function handleError(err: unknown) {
  if (err instanceof CapitalError) return jsonError(err.code, err.message, err.httpStatus);
  console.error("[api] unexpected error:", err instanceof Error ? err.message : "unknown");
  return jsonError("INTERNAL", "Erreur interne du serveur.", 500);
}

export function parseCommon(url: URL):
  | { ok: true; instrument: Instrument; resolution: ResolutionKey; api: string }
  | { ok: false; response: NextResponse } {
  const instrument = findInstrument(url.searchParams.get("epic"));
  if (!instrument) return { ok: false, response: jsonError("BAD_REQUEST", "Instrument non configuré.", 400) };
  const res = url.searchParams.get("resolution");
  if (!isResolutionKey(res)) {
    return { ok: false, response: jsonError("BAD_REQUEST", "Résolution invalide (1, 5 ou 15).", 400) };
  }
  return { ok: true, instrument, resolution: res, api: RESOLUTIONS[res].api };
}

/**
 * Requests that move money must come from this site's own pages: a form on another site cannot make the browser send
 * the session cookie along with a matching Origin.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = [req.headers.get("host"), req.headers.get("x-forwarded-host"), new URL(req.url).host];
  return allowed.some((h) => h && h === host);
}

export const crossOriginRefused = () => jsonError("FORBIDDEN", "Requête refusée : elle ne vient pas de ce site.", 403);
