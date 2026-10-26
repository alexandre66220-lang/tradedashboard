export interface Instrument {
  /** Display name in the UI */
  name: string;
  /** Capital.com market identifier (check with /api/v1/markets?searchTerm=...) */
  epic: string;
  /** Default forecast horizon, in minutes */
  defaultHorizon: number;
}

// Add one line per instrument. The selector appears in the UI as soon as there are 2+.
export const INSTRUMENTS: Instrument[] = [
  { name: "Or (XAU/USD)", epic: "GOLD", defaultHorizon: 30 },
  { name: "Pétrole (WTI)", epic: "OIL_CRUDE", defaultHorizon: 30 },
  { name: "Bitcoin (BTC/USD)", epic: "BTCUSD", defaultHorizon: 30 },
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
