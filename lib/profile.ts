import type { Candle } from "./types";

// Volume profile in the sense of Auction Market Theory (Market Profile): where, in price, the market spent its time and
// volume over the last day. POC = price with the most volume; value area = the band around it holding ~70 % of it.
// CFD volume is tick volume (how often the price moved), not exchanged quantity: a reading aid, not true order flow.
// Without any volume, each candle counts once ("time at price", the classic Market Profile).

export interface ProfileBin {
  /** Centre of the bin */
  price: number;
  volume: number;
}

export interface VolumeProfile {
  bins: ProfileBin[];
  binSize: number;
  poc: number;
  /** Value area: top and bottom edges */
  vah: number;
  val: number;
  /** What the bars are made of */
  basis: "volume" | "temps";
  /** Candles the profile covers */
  candles: number;
}

export const VALUE_AREA_SHARE = 0.7;
export const PROFILE_BINS = 40;
const MIN_CANDLES = 30;

/** About one trading day of candles, whatever the timeframe. */
export const profileWindow = (resMinutes: number) => Math.max(MIN_CANDLES, Math.round(1440 / resMinutes));

export function volumeProfile(candles: Candle[], resMinutes: number, bins = PROFILE_BINS): VolumeProfile | null {
  // the candle still forming has a partial volume: it is left out
  const done = candles.slice(0, -1).slice(-profileWindow(resMinutes));
  if (done.length < MIN_CANDLES) return null;
  let lo = Infinity, hi = -Infinity;
  for (const c of done) {
    if (!(c.high >= c.low) || !(c.low > 0)) return null;
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
  }
  if (!(hi > lo)) return null;
  const binSize = (hi - lo) / bins;
  const hasVolume = done.some((c) => (c.volume ?? 0) > 0);
  const vol = new Array<number>(bins).fill(0);
  for (const c of done) {
    const weight = hasVolume ? Math.max(0, c.volume ?? 0) : 1;
    if (weight === 0) continue;
    const a = Math.min(bins - 1, Math.floor((c.low - lo) / binSize));
    const b = Math.min(bins - 1, Math.floor((c.high - lo) / binSize));
    if (a === b || c.high === c.low) {
      vol[a] += weight;
      continue;
    }
    // spread over the bins the candle crosses, in proportion to the part of its range inside each
    const range = c.high - c.low;
    for (let i = a; i <= b; i++) {
      const from = Math.max(c.low, lo + i * binSize);
      const to = Math.min(c.high, lo + (i + 1) * binSize);
      if (to > from) vol[i] += (weight * (to - from)) / range;
    }
  }
  const total = vol.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;

  // POC: the busiest bin (the one closest to the middle of the range on a tie, so that a flat profile is not biased to an edge)
  let poc = 0;
  const mid = (bins - 1) / 2;
  for (let i = 1; i < bins; i++) if (vol[i] > vol[poc] || (vol[i] === vol[poc] && Math.abs(i - mid) < Math.abs(poc - mid))) poc = i;

  // Value area: from the POC, take the busier of the next two bins above or below until 70 % of the volume is inside
  let up = poc, down = poc, inside = vol[poc];
  while (inside < VALUE_AREA_SHARE * total && (up < bins - 1 || down > 0)) {
    const nextUp = up < bins - 1 ? vol[up + 1] + (up + 2 < bins ? vol[up + 2] : 0) : -1;
    const nextDown = down > 0 ? vol[down - 1] + (down - 2 >= 0 ? vol[down - 2] : 0) : -1;
    if (nextUp >= nextDown) {
      up++;
      inside += vol[up];
      if (inside < VALUE_AREA_SHARE * total && up < bins - 1) {
        up++;
        inside += vol[up];
      }
    } else {
      down--;
      inside += vol[down];
      if (inside < VALUE_AREA_SHARE * total && down > 0) {
        down--;
        inside += vol[down];
      }
    }
  }
  return {
    bins: vol.map((volume, i) => ({ price: lo + (i + 0.5) * binSize, volume })),
    binSize,
    poc: lo + (poc + 0.5) * binSize,
    vah: lo + (up + 1) * binSize,
    val: lo + down * binSize,
    basis: hasVolume ? "volume" : "temps",
    candles: done.length,
  };
}

export type ValuePosition = "in" | "above" | "below";

export const positionVsValue = (price: number, p: VolumeProfile): ValuePosition => (price > p.vah ? "above" : price < p.val ? "below" : "in");

/** Balance (price accepted inside the value area) or imbalance (it left it), as Auction Market Theory puts it. */
export const AUCTION_LABEL: Record<ValuePosition, string> = {
  in: "équilibre : le prix reste dans la zone de valeur",
  above: "déséquilibre haussier : le prix est au-dessus de la zone de valeur",
  below: "déséquilibre baissier : le prix est sous la zone de valeur",
};

export type ValueRelation = "inside" | "toward" | "away";

/**
 * A forecast against the value area: inside it, toward it (price above and forecast down, or below and up: the classic "return
 * to value"), or away from it (the move continues outside: the market accepts the new prices). Flat forecasts count as inside.
 */
export function valueRelation(direction: "up" | "down" | "flat", position: ValuePosition): ValueRelation {
  if (position === "in" || direction === "flat") return "inside";
  const towardDir = position === "above" ? "down" : "up";
  return direction === towardDir ? "toward" : "away";
}
