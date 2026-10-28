import { NextResponse } from "next/server";
import { crossOriginRefused, handleError, sameOrigin } from "@/lib/http";
import { previewOrder } from "@/lib/orders";

export const dynamic = "force-dynamic";

/** Checks an order against the live quote and the open positions; nothing is sent to the broker. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return crossOriginRefused();
  try {
    return NextResponse.json(await previewOrder(await req.json().catch(() => null)), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
