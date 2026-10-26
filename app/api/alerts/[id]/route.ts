import { NextResponse } from "next/server";
import type { PriceAlert } from "@/lib/alerts";
import { handleError, jsonError } from "@/lib/http";
import { StoreError, updateList } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await updateList<PriceAlert, null>("alerts/alerts.json", (items) => {
      if (!items.some((a) => a.id === id)) throw new StoreError("NOT_FOUND", "Alerte introuvable.");
      return { items: items.filter((a) => a.id !== id), result: null };
    });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof StoreError) return jsonError(err.code, err.message, err.code === "NOT_FOUND" ? 404 : 503);
    return handleError(err);
  }
}
