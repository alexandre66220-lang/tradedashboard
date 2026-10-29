import { timingSafeEqual } from "node:crypto";

// Background function (up to 15 minutes): records the forecast journal by calling the dashboard's own
// /api/journal/record route. The caller gets an immediate 202 whatever happens; the secret is checked here, so that a
// stranger who finds this URL cannot trigger anything.
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export default async (req: Request, context: { site?: { url?: string } }) => {
  const secret = process.env.CRON_SECRET;
  const site = context?.site?.url || process.env.URL;
  if (!secret || !site) {
    console.warn("[journal-record] CRON_SECRET or the site URL is missing");
    return;
  }
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    console.warn("[journal-record] refused: bad credentials");
    return;
  }
  // "intraday" (every 30 min) or "daily" (daily and weekly outlooks, once a day); anything else records everything
  const asked = new URL(req.url).searchParams.get("scope");
  console.log(`[journal-record] started (${asked ?? "all"})`);
  const scope = asked === "intraday" || asked === "daily" ? `?scope=${asked}` : "";
  try {
    const res = await fetch(`${site}/api/journal/record${scope}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(58_000),
    });
    console.log(`[journal-record] status ${res.status}`, (await res.text()).slice(0, 200));
  } catch (err) {
    console.warn("[journal-record] failed:", err instanceof Error ? err.name : "unknown");
  }
};

export const config = { background: true };
