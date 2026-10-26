import { NextResponse } from "next/server";
import { INSTRUMENTS } from "@/config/instruments";
import { MAX_ALERTS, parseNewAlert, type PriceAlert } from "@/lib/alerts";
import { handleError, jsonError } from "@/lib/http";
import { notifyConfigured } from "@/lib/notify";
import { readList, StoreError, updateList } from "@/lib/store";

export const dynamic = "force-dynamic";
const ALERTS_KEY = "alerts/alerts.json";
const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const alerts = await readList<PriceAlert>(ALERTS_KEY);
    return NextResponse.json({ configured: alerts !== null, notify: notifyConfigured(), alerts: alerts ?? [] }, { headers: noStore });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: Request) {
  const parsed = parseNewAlert(await req.json().catch(() => null), INSTRUMENTS.map((i) => i.epic));
  if (!parsed.ok) return jsonError("BAD_REQUEST", parsed.error, 400);
  try {
    const alert: PriceAlert = { id: crypto.randomUUID(), ...parsed.value };
    await updateList<PriceAlert, null>(ALERTS_KEY, (items) => {
      if (items.filter((a) => a.firedAt === undefined).length >= MAX_ALERTS) throw new StoreError("INVALID", `Trop d'alertes actives (${MAX_ALERTS} maximum).`);
      return { items: [...items, alert].slice(-300), result: null };
    });
    return NextResponse.json({ alert }, { status: 201, headers: noStore });
  } catch (err) {
    if (err instanceof StoreError) return jsonError(err.code, err.message, err.code === "NOT_CONFIGURED" ? 503 : 409);
    return handleError(err);
  }
}
