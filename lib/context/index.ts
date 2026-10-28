import "server-only";
import { getCot, COT_CONTRACTS } from "./cftc";
import { getBtcDerivs } from "./okx";
import type { ContextResponse } from "./types";

export async function getContext(epic: string): Promise<ContextResponse> {
  const wantsDerivs = epic === "BTCUSD";
  const wantsCot = epic in COT_CONTRACTS;
  const [derivs, cot] = await Promise.all([wantsDerivs ? getBtcDerivs() : null, wantsCot ? getCot(epic) : null]);
  return {
    derivs,
    cot,
    sources: { derivs: !wantsDerivs ? "none" : derivs ? "ok" : "down", cot: !wantsCot ? "none" : cot ? "ok" : "down" },
  };
}

/** For the journal: whatever can be read quickly, never waiting long and never failing. */
export async function readingsForJournal(epic: string, intraday: boolean): Promise<{ deriv?: { funding: number; longPct?: number; oi1hPct?: number }; cot?: number }> {
  const quick = <T>(p: Promise<T | null>) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 5_000))]).catch(() => null);
  const [derivs, cot] = await Promise.all([epic === "BTCUSD" && intraday ? quick(getBtcDerivs()) : null, quick(getCot(epic))]);
  return {
    ...(derivs ? { deriv: { funding: derivs.funding, ...(derivs.longPct !== null ? { longPct: derivs.longPct } : {}), ...(derivs.oi1hPct !== null ? { oi1hPct: derivs.oi1hPct } : {}) } } : {}),
    ...(cot ? { cot: cot.percentile } : {}),
  };
}
