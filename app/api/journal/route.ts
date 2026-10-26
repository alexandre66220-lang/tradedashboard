import { NextResponse } from "next/server";
import { journalOverview } from "@/lib/journal/service";
import { handleError } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json(await journalOverview(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleError(err);
  }
}
