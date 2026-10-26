import "server-only";
import type { Notification } from "./alerts";

export const notifyConfigured = () => Boolean(process.env.NTFY_TOPIC);

/**
 * Sends a phone notification through ntfy (https://ntfy.sh, free, no account). The topic name is the secret:
 * anyone who knows it can read the notifications, so it must be long and random. It is never logged.
 */
export async function sendNotification(n: Notification): Promise<boolean> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
  try {
    // JSON publishing keeps accents and emojis intact (HTTP headers would not)
    const res = await fetch(server, {
      method: "POST",
      headers,
      body: JSON.stringify({ topic, title: n.title, message: n.message, priority: n.priority, tags: n.tags ?? [], ...(process.env.DASHBOARD_URL ? { click: process.env.DASHBOARD_URL } : {}) }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!res.ok) console.warn("[notify] ntfy answered", res.status);
    return res.ok;
  } catch {
    console.warn("[notify] ntfy unreachable");
    return false;
  }
}
