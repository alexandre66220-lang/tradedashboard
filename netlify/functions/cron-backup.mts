// Netlify scheduled function (UTC), once a day: asks the dashboard to copy its journal, trades and alerts into a dated
// backup file (the last 14 are kept). The copy is made by the dashboard's own route, with the shared secret.
export default async (_req: Request, context: { site?: { url?: string } }) => {
  const secret = process.env.CRON_SECRET;
  const site = context?.site?.url || process.env.URL;
  if (!secret || !site) {
    console.warn("[cron-backup] CRON_SECRET or the site URL is missing");
    return;
  }
  try {
    const res = await fetch(`${site}/api/backup/run`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(25_000) });
    console.log(`[cron-backup] status ${res.status}`);
  } catch (err) {
    console.warn("[cron-backup] failed:", err instanceof Error ? err.name : "unknown");
  }
};

// 03:30 UTC
export const config = { schedule: "30 3 * * *" };
