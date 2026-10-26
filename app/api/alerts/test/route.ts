import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { notifyConfigured, sendNotification } from "@/lib/notify";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!notifyConfigured()) return jsonError("CONFIG_MISSING", "NTFY_TOPIC n'est pas défini côté serveur : les notifications ne sont pas configurées.", 503);
  const ok = await sendNotification({
    title: "Test du dashboard",
    message: "Si vous lisez ceci sur votre téléphone, les notifications fonctionnent.",
    priority: 3,
    tags: ["white_check_mark"],
  });
  return ok ? NextResponse.json({ ok: true }) : jsonError("NOTIFY_FAILED", "L'envoi a échoué : vérifiez NTFY_TOPIC et NTFY_SERVER.", 502);
}
