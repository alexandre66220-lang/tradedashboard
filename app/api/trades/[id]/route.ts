import { NextResponse } from "next/server";
import { handleError, jsonError } from "@/lib/http";
import { applyPatch, parsePatch, type Trade } from "@/lib/trades";
import { StoreError, updateTrades } from "@/lib/trades-store";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

type Ctx = { params: Promise<{ id: string }> };

function fail(err: unknown) {
  if (err instanceof StoreError) {
    const status = err.code === "NOT_CONFIGURED" ? 503 : err.code === "NOT_FOUND" ? 404 : 400;
    return jsonError(err.code, err.message, status);
  }
  return handleError(err);
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const patch = parsePatch(await req.json().catch(() => null));
  if (!patch.ok) return jsonError("BAD_REQUEST", patch.error, 400);
  try {
    const trade = await updateTrades<Trade>((trades) => {
      const i = trades.findIndex((t) => t.id === id);
      if (i < 0) throw new StoreError("NOT_FOUND", "Trade introuvable.");
      const next = applyPatch(trades[i], patch.value);
      if (typeof next === "string") throw new StoreError("INVALID", next);
      const copy = [...trades];
      copy[i] = next;
      return { trades: copy, result: next };
    });
    return NextResponse.json({ trade }, { headers: noStore });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    await updateTrades((trades) => {
      if (!trades.some((t) => t.id === id)) throw new StoreError("NOT_FOUND", "Trade introuvable.");
      return { trades: trades.filter((t) => t.id !== id), result: null };
    });
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (err) {
    return fail(err);
  }
}
