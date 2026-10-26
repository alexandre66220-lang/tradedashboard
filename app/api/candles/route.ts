import { NextResponse } from "next/server";
import { capitalEnv, getCandles, getMarketStatus } from "@/lib/capital";
import { handleError, parseCommon } from "@/lib/http";
import type { CandlesResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const p = parseCommon(new URL(req.url));
  if (!p.ok) return p.response;
  try {
    const [candles, marketStatus] = await Promise.all([
      getCandles(p.instrument.epic, p.api),
      getMarketStatus(p.instrument.epic).catch(() => "UNKNOWN"),
    ]);
    const body: CandlesResponse = { epic: p.instrument.epic, resolution: p.resolution, candles, marketStatus, env: capitalEnv() };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
