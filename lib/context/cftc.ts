import "server-only";
import type { CotReading } from "./types";

// CFTC Commitments of Traders, legacy futures-only report (public Socrata API, no key). Weekly: positions as of Tuesday,
// published on Friday afternoon (US Eastern). Read-only, never required: every function fails soft.
// CFTC_URL is only meant for local tests against a mock server.
const url = () => process.env.CFTC_URL || "https://publicreporting.cftc.gov/resource/6dca-aqww.json";
const TIMEOUT_MS = 8_000;
const TTL_MS = 6 * 3600_000;
const FAILURE_TTL_MS = 30 * 60_000;
const WEEKS = 156;
export const MIN_WEEKS = 52;
/** Report date (Tuesday) + 3 days + 20 h 30 min = Friday 20:30 UTC, after the release in every season: a later reading is never used before it was out */
export const RELEASE_DELAY_MS = (3 * 24 + 20.5) * 3600_000;

/** CFTC contract market codes of the futures behind each instrument. */
export const COT_CONTRACTS: Record<string, { code: string; label: string }> = {
  GOLD: { code: "088691", label: "Or (COMEX)" },
  OIL_CRUDE: { code: "067651", label: "Pétrole WTI (NYMEX)" },
  BTCUSD: { code: "133741", label: "Bitcoin (CME)" },
  US100: { code: "209742", label: "Nasdaq 100 mini (CME)" },
  US500: { code: "13874A", label: "S&P 500 E-mini (CME)" },
  EURUSD: { code: "099741", label: "Euro FX (CME)" },
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

interface Week {
  date: number;
  net: number;
}

/**
 * Rows look like { report_date_as_yyyy_mm_dd, open_interest_all, noncomm_positions_long_all, noncomm_positions_short_all }
 * (numbers as strings). Rows that do not look right are skipped; `now` keeps out a report not yet released.
 */
export function parseCot(json: unknown, label: string, now = Date.now()): CotReading | null {
  if (!Array.isArray(json)) return null;
  const weeks: Week[] = [];
  for (const r of json as Array<Record<string, unknown>>) {
    const date = typeof r?.report_date_as_yyyy_mm_dd === "string" ? Date.parse(r.report_date_as_yyyy_mm_dd.slice(0, 10) + "T00:00:00Z") : NaN;
    const oi = num(r?.open_interest_all), long = num(r?.noncomm_positions_long_all), short = num(r?.noncomm_positions_short_all);
    if (!Number.isFinite(date) || oi === null || oi <= 0 || long === null || short === null || long < 0 || short < 0) continue;
    if (date + RELEASE_DELAY_MS > now) continue;
    weeks.push({ date, net: ((long - short) / oi) * 100 });
  }
  weeks.sort((a, b) => b.date - a.date);
  const recent = weeks.slice(0, WEEKS);
  if (recent.length < MIN_WEEKS) return null;
  const latest = recent[0];
  const below = recent.filter((w) => w.net < latest.net).length;
  const equal = recent.filter((w) => w.net === latest.net).length;
  const percentile = ((below + (equal - 1) / 2) / (recent.length - 1)) * 100;
  return {
    label,
    reportDate: latest.date,
    netPct: Math.round(latest.net * 10) / 10,
    percentile: Math.round(percentile),
    weekChange: recent[1] ? Math.round((latest.net - recent[1].net) * 10) / 10 : null,
    weeks: recent.length,
  };
}

const cache = new Map<string, { at: number; failed: boolean; value: Promise<CotReading | null> }>();
export function __resetCftc() {
  cache.clear();
}

/** Positioning of the big speculators for an instrument; null when there is none for it or the source did not answer. Never throws. */
export function getCot(epic: string): Promise<CotReading | null> {
  const c = COT_CONTRACTS[epic];
  if (!c) return Promise.resolve(null);
  const hit = cache.get(epic);
  if (hit && Date.now() - hit.at < (hit.failed ? FAILURE_TTL_MS : TTL_MS)) return hit.value;
  const query = new URLSearchParams({
    cftc_contract_market_code: c.code,
    $select: "report_date_as_yyyy_mm_dd,open_interest_all,noncomm_positions_long_all,noncomm_positions_short_all",
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: String(WEEKS + 4),
  });
  const entry = { at: Date.now(), failed: false, value: null as unknown as Promise<CotReading | null> };
  entry.value = fetch(`${url()}?${query}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reading = parseCot(await res.json(), c.label);
      if (!reading) throw new Error("unexpected format");
      return reading;
    })
    .catch((err) => {
      entry.failed = true;
      console.warn(`[context] CFTC ${epic} unavailable: ${err instanceof Error ? err.message : "unknown"}`);
      return null;
    });
  cache.set(epic, entry);
  return entry.value;
}
