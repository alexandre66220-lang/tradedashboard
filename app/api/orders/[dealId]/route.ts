import { NextResponse } from "next/server";
import { crossOriginRefused, handleError, sameOrigin } from "@/lib/http";
import { closeOrder } from "@/lib/orders";

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
