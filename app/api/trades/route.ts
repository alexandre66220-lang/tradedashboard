import { NextResponse } from "next/server";
import { INSTRUMENTS } from "@/config/instruments";
import { handleError, jsonError } from "@/lib/http";
import { MAX_TRADES, parseNewTrade, type Trade } from "@/lib/trades";
import { readTrades, StoreError, updateTrades } from "@/lib/trades-store";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const trades = await readTrades();
    return NextResponse.json({ configured: trades !== null, trades: trades ?? [] }, { headers: noStore });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  const parsed = parseNewTrade(await req.json().catch(() => null), INSTRUMENTS.map((i) => i.epic));
  if (!parsed.ok) return jsonError("BAD_REQUEST", parsed.error, 400);
  try {
    const trade: Trade = { id: crypto.randomUUID(), ...parsed.value };
    await updateTrades((trades) => {
      if (trades.length >= MAX_TRADES) throw new StoreError("INVALID", `Le journal est plein (${MAX_TRADES} trades).`);
      return { trades: [...trades, trade], result: null };
    });
    return NextResponse.json({ trade }, { status: 201, headers: noStore });
  } catch (err) {
    if (err instanceof StoreError) return jsonError(err.code, err.message, err.code === "NOT_CONFIGURED" ? 503 : 409);
    return handleError(err);
  }
}
