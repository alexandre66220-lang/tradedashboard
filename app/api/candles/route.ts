import { NextResponse } from "next/server";
import { capitalEnv, getCandles, getMarketQuote } from "@/lib/capital";
import { handleError, parseCommon } from "@/lib/http";
import type { CandlesResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const p = parseCommon(new URL(req.url));
  if (!p.ok) return p.response;
  try {
    const [candles, market] = await Promise.all([
      getCandles(p.instrument.epic, p.api),
      getMarketQuote(p.instrument.epic).catch(() => ({ status: "UNKNOWN", bid: null, offer: null })),
    ]);
    const quote = market.bid !== null && market.offer !== null && market.offer >= market.bid ? { bid: market.bid, offer: market.offer } : null;
    const body: CandlesResponse = { epic: p.instrument.epic, resolution: p.resolution, candles, marketStatus: market.status, quote, env: capitalEnv() };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
