import { NextResponse } from "next/server";
import { findInstrument } from "@/config/instruments";
import { getContext } from "@/lib/context";
import { handleError, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/context?epic=BTCUSD: positioning data around an instrument (derivatives, big speculators). Sources that do not answer are reported, never fatal. */
export async function GET(req: Request) {
  const inst = findInstrument(new URL(req.url).searchParams.get("epic"));
  if (!inst) return jsonError("BAD_REQUEST", "Instrument non configuré.", 400);
  try {
    return NextResponse.json(await getContext(inst.epic), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
