import { NextResponse } from "next/server";
import { crossOriginRefused, handleError, sameOrigin } from "@/lib/http";
import { ordersState, placeOrder } from "@/lib/orders";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

/** Is trading switched on (demo account only), and the positions currently open. */
export async function GET() {
  try {
    return NextResponse.json(await ordersState(), { headers: noStore });
  } catch (err) {
    return handleError(err);
  }
}

/** Sends the order whose signed recap (from /api/orders/preview) is given. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return crossOriginRefused();
  const body = (await req.json().catch(() => null)) as { token?: unknown; model?: unknown } | null;
  try {
    return NextResponse.json(await placeOrder(body?.token, body?.model), { headers: noStore });
  } catch (err) {
    return handleError(err);
  }
}
