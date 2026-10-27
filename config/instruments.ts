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
  // newsCurrencies / newsKeywords (from NewsProfile): which economic announcements matter for this instrument
}

// Add one line per instrument. The selector appears in the UI as soon as there are 2+.
export const INSTRUMENTS: Instrument[] = [
  { name: "Or (XAU/USD)", epic: "GOLD", defaultHorizon: 30, spreadBps: 2, financingBpsPerDay: 2, newsCurrencies: ["USD"] },
  { name: "Pétrole (WTI)", epic: "OIL_CRUDE", defaultHorizon: 30, spreadBps: 5, financingBpsPerDay: 3, newsCurrencies: ["USD"], newsKeywords: ["crude", "opec"] },
  { name: "Bitcoin (BTC/USD)", epic: "BTCUSD", defaultHorizon: 30, spreadBps: 8, financingBpsPerDay: 5, newsCurrencies: ["USD"] },
];

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
