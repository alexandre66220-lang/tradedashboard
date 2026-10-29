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
  // "intraday" (every 30 min) or "daily" (daily and weekly outlooks, once a day); anything else records everything at once
  const asked = new URL(req.url).searchParams.get("scope");
  console.log(`[journal-record] started (${asked ?? "all"})`);
  const headers = { Authorization: `Bearer ${secret}` };
  try {
    if (asked !== "intraday" && asked !== "daily") {
      const res = await fetch(`${site}/api/journal/record`, { headers, signal: AbortSignal.timeout(58_000) });
      console.log(`[journal-record] status ${res.status}`, (await res.text()).slice(0, 200));
      return;
    }
    // A request may last 30 s here and a run of everything takes longer: the dashboard lists its single forecasts, and they
    // are asked for one by one (two at a time), each in its own request.
    const planRes = await fetch(`${site}/api/journal/record?plan=${asked}`, { headers, signal: AbortSignal.timeout(20_000) });
    const plan = (await planRes.json().catch(() => null)) as { calls?: unknown } | null;
    const calls = Array.isArray(plan?.calls) ? (plan.calls as unknown[]).filter((c): c is string => typeof c === "string" && /^[A-Za-z0-9=&_.-]+$/.test(c)) : [];
    if (!calls.length) {
      console.warn(`[journal-record] no plan (status ${planRes.status})`);
      return;
    }
    let ok = 0, failed = 0;
    const queue = [...calls];
    const worker = async () => {
      for (let call = queue.shift(); call; call = queue.shift()) {
        try {
          const res = await fetch(`${site}/api/journal/record?${call}`, { headers, signal: AbortSignal.timeout(58_000) });
          if (res.ok) ok++;
          else {
            failed++;
            console.warn(`[journal-record] ${call}: status ${res.status}`);
          }
        } catch (err) {
          failed++;
          console.warn(`[journal-record] ${call}: ${err instanceof Error ? err.name : "unknown"}`);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    console.log(`[journal-record] done (${asked}): ${ok} recorded, ${failed} failed`);
  } catch (err) {
    console.warn("[journal-record] failed:", err instanceof Error ? err.name : "unknown");
  }
};

export const config = { background: true };
