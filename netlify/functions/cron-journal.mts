// Netlify scheduled function (UTC), every 30 minutes (short forecasts only; the daily / weekly ones have their own). Scheduled functions stop after 30 s, but recording the forecasts of
// all instruments can take longer (the ML model trains on each request): this one only hands over to a background
// function, which may run for minutes.
export default async (_req: Request, context: { site?: { url?: string } }) => {
  const secret = process.env.CRON_SECRET;
  const site = context?.site?.url || process.env.URL;
  if (!secret || !site) {
    console.warn("[cron-journal] CRON_SECRET or the site URL is missing");
    return;
  }
  try {
    const res = await fetch(`${site}/.netlify/functions/journal-record-background?scope=intraday`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(20_000),
    });
    console.log(`[cron-journal] handed over: ${res.status}`);
  } catch (err) {
    console.warn("[cron-journal] failed:", err instanceof Error ? err.name : "unknown");
  }
};

export const config = { schedule: "*/30 * * * *" };
