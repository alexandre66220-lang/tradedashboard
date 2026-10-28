/** Bitcoin perpetual futures positioning (OKX public data). */
export interface BtcDerivs {
  /** Funding rate per 8 h, as a fraction (0.0001 = 0.01 %): positive when longs pay shorts */
  funding: number;
  /** % of accounts long (OKX long/short account ratio), when available */
  longPct: number | null;
  /** Change of the open interest over about one hour, in %, when available */
  oi1hPct: number | null;
  /** When it was read (ms) */
  at: number;
}

/** What the big speculators hold, from the CFTC weekly Commitments of Traders report. */
export interface CotReading {
  label: string;
  /** Report date (the Tuesday the positions are as of), ms */
  reportDate: number;
  /** Net position (long - short) of non-commercial traders, % of open interest */
  netPct: number;
  /** Rank of that net position among the last weeks, 0 (the most short) to 100 (the most long) */
  percentile: number;
  /** Change since the previous week, in points of open interest */
  weekChange: number | null;
  /** How many weeks the percentile is computed over */
  weeks: number;
}

export interface ContextResponse {
  /** null for instruments other than Bitcoin, or when the source did not answer */
  derivs: BtcDerivs | null;
  cot: CotReading | null;
  /** Whether each source was asked and answered, so that "nothing to show" and "source down" can be told apart */
  sources: { derivs: "ok" | "down" | "none"; cot: "ok" | "down" | "none" };
}

/** Funding at or above this (twice the usual 0.01 %) means the longs are crowded; at or below the second, the shorts. */
export const FUNDING_LONG_CROWDED = 0.0002;
export const FUNDING_SHORT_CROWDED = -0.00005;
export const COT_EXTREME_HIGH = 80;
export const COT_EXTREME_LOW = 20;

export type Relation = "with" | "against" | "neutral";

/** Was the forecast with or against the funding crowd? */
export function fundingRelation(direction: "up" | "down" | "flat", funding: number): Relation {
  const crowd = funding >= FUNDING_LONG_CROWDED ? "up" : funding <= FUNDING_SHORT_CROWDED ? "down" : null;
  if (!crowd || direction === "flat") return "neutral";
  return direction === crowd ? "with" : "against";
}

/** Was the forecast with or against the big speculators, when they are at an extreme? */
export function cotRelation(direction: "up" | "down" | "flat", percentile: number): Relation {
  const crowd = percentile >= COT_EXTREME_HIGH ? "up" : percentile <= COT_EXTREME_LOW ? "down" : null;
  if (!crowd || direction === "flat") return "neutral";
  return direction === crowd ? "with" : "against";
}
