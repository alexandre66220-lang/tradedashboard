// Netlify scheduled function (UTC), once a day: records the daily and weekly outlooks of the forecast journal. They change
// at most once a day, so running them every 30 minutes would only burn model runs. Hands over to the background function.
export default async (_req: Request, context: { site?: { url?: string } }) => {
  const secret = process.env.CRON_SECRET;
  const site = context?.site?.url || process.env.URL;
  if (!secret || !site) {
    console.warn("[cron-journal-daily] CRON_SECRET or the site URL is missing");
    return;
  }
  try {
    const res = await fetch(`${site}/.netlify/functions/journal-record-background?scope=daily`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(20_000),
    });
    console.log(`[cron-journal-daily] handed over: ${res.status}`);
  } catch (err) {
    console.warn("[cron-journal-daily] failed:", err instanceof Error ? err.name : "unknown");
  }
};

// 07:05 UTC
export const config = { schedule: "5 7 * * *" };
