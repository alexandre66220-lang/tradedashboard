import type { NewsProfile } from "@/lib/calendar";

export interface Instrument extends NewsProfile {
  /** Display name in the UI */
  name: string;
  /** Capital.com market identifier (check with /api/v1/markets?searchTerm=...) */
  epic: string;
  /** Default forecast horizon, in minutes */
  defaultHorizon: number;
  /** Assumed round-trip cost in basis points (1 bp = 0.01 %), used by the simulated gains of the journal. Adjust to your real spread. */
  spreadBps?: number;
  /**
   * Assumed overnight financing of a CFD position, in basis points per night held. ONLY AN ASSUMPTION: check your
   * broker's real rates (they differ by instrument, direction and the weekend) and adjust.
   */
  financingBpsPerDay?: number;
  /**
   * Epics whose prices the ML model also looks at (at most 4: the service refuses more). Default: the first four other
   * instruments. Closely related markets help (e.g. the dollar for gold, the S&P 500 for the Nasdaq).
   */
  related?: string[];
  // newsCurrencies / newsKeywords (from NewsProfile): which economic announcements matter for this instrument
}

// Add one line per instrument. The selector appears in the UI as soon as there are 2+.
export const INSTRUMENTS: Instrument[] = [
  { name: "Or (XAU/USD)", epic: "GOLD", defaultHorizon: 30, spreadBps: 2, financingBpsPerDay: 2, newsCurrencies: ["USD"], related: ["EURUSD", "US500", "OIL_CRUDE", "BTCUSD"] },
  { name: "Pétrole (WTI)", epic: "OIL_CRUDE", defaultHorizon: 30, spreadBps: 5, financingBpsPerDay: 3, newsCurrencies: ["USD"], newsKeywords: ["crude", "opec"], related: ["GOLD", "US500", "EURUSD", "BTCUSD"] },
  { name: "Bitcoin (BTC/USD)", epic: "BTCUSD", defaultHorizon: 30, spreadBps: 8, financingBpsPerDay: 5, newsCurrencies: ["USD"], related: ["US100", "US500", "GOLD", "EURUSD"] },
  // Epics as named by Capital.com (check them with /api/v1/markets?searchTerm=...). Costs are assumptions: adjust to your real spread.
  { name: "Nasdaq 100 (US100)", epic: "US100", defaultHorizon: 30, spreadBps: 1.5, financingBpsPerDay: 2, newsCurrencies: ["USD"], related: ["US500", "BTCUSD", "GOLD", "EURUSD"] },
  { name: "S&P 500 (US500)", epic: "US500", defaultHorizon: 30, spreadBps: 1, financingBpsPerDay: 2, newsCurrencies: ["USD"], related: ["US100", "OIL_CRUDE", "GOLD", "EURUSD"] },
  { name: "Euro / Dollar (EUR/USD)", epic: "EURUSD", defaultHorizon: 30, spreadBps: 0.8, financingBpsPerDay: 1, newsCurrencies: ["USD", "EUR"], related: ["GOLD", "US500", "OIL_CRUDE", "US100"] },
];

/** The instruments the ML model gets as context for `epic`: its `related` list, else the first others (never more than 4). */
export function relatedEpics(epic: string): string[] {
  const self = INSTRUMENTS.find((i) => i.epic === epic);
  const known = new Set(INSTRUMENTS.map((i) => i.epic));
  const chosen = (self?.related ?? []).filter((e) => e !== epic && known.has(e));
  const rest = INSTRUMENTS.map((i) => i.epic).filter((e) => e !== epic && !chosen.includes(e));
  return [...chosen, ...rest].slice(0, 4);
}

export const RESOLUTIONS = {
  "1": { api: "MINUTE", minutes: 1, label: "1m" },
  "5": { api: "MINUTE_5", minutes: 5, label: "5m" },
  "15": { api: "MINUTE_15", minutes: 15, label: "15m" },
} as const;

// Longer-term outlooks shown for every instrument (one step of daily / weekly candles).
export const OUTLOOKS = [
  { key: "day", label: "Jour", api: "DAY", minutes: 24 * 60 },
  { key: "week", label: "Semaine", api: "WEEK", minutes: 7 * 24 * 60 },
] as const;

export type OutlookKey = (typeof OUTLOOKS)[number]["key"];

export type ResolutionKey = keyof typeof RESOLUTIONS;
export const DEFAULT_RESOLUTION: ResolutionKey = "5";
export const HORIZON_CHOICES = [15, 30, 60, 120];

export function findInstrument(epic: string | null): Instrument | undefined {
  return INSTRUMENTS.find((i) => i.epic === epic);
}

export function isResolutionKey(v: string | null): v is ResolutionKey {
  return v !== null && Object.prototype.hasOwnProperty.call(RESOLUTIONS, v);
}

export const DEFAULT_SPREAD_BPS = 3;
export const spreadBpsFor = (epic: string) => INSTRUMENTS.find((i) => i.epic === epic)?.spreadBps ?? DEFAULT_SPREAD_BPS;

export const DEFAULT_FINANCING_BPS = 3;
export const financingBpsFor = (epic: string) => INSTRUMENTS.find((i) => i.epic === epic)?.financingBpsPerDay ?? DEFAULT_FINANCING_BPS;
