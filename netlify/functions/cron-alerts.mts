// Netlify scheduled function (UTC): checks price / announcement alerts every 5 minutes by calling the dashboard's own
// /api/alerts/check route with the shared secret. The route is read-only towards Capital.com and sends phone alerts.
export default async (_req: Request, context: { site?: { url?: string } }) => {
  const secret = process.env.CRON_SECRET;
  const site = context?.site?.url || process.env.URL;
  if (!secret || !site) {
    console.warn("[cron-alerts] CRON_SECRET or the site URL is missing");
    return;
  }
  try {
    const res = await fetch(`${site}/api/alerts/check`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(25_000),
    });
    console.log(`[cron-alerts] status ${res.status}`);
  } catch (err) {
    console.warn("[cron-alerts] failed:", err instanceof Error ? err.name : "unknown");
  }
};

export const config = { schedule: "*/5 * * * *" };
