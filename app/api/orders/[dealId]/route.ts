import { NextResponse } from "next/server";
import { crossOriginRefused, handleError, sameOrigin } from "@/lib/http";
import { closeOrder, moveStop } from "@/lib/orders";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ dealId: string }> };

/** Closes one open position (demo account only). */
export async function DELETE(req: Request, { params }: Ctx) {
  if (!sameOrigin(req)) return crossOriginRefused();
  const { dealId } = await params;
  try {
    return NextResponse.json(await closeOrder(dealId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}

/** Moves the stop of one open position closer to the price (demo account only). */
export async function PATCH(req: Request, { params }: Ctx) {
  if (!sameOrigin(req)) return crossOriginRefused();
  const { dealId } = await params;
  const body = (await req.json().catch(() => null)) as { stop?: unknown } | null;
  try {
    return NextResponse.json(await moveStop(dealId, body?.stop), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
