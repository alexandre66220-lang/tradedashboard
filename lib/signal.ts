import { TREND_LABEL, VOL_LABEL, type TrendRegime, type VolRegime } from "./regime";
import { verdict } from "./verdict";
import type { JournalStats } from "./journal/types";

/** Live forecasts that must have been judged before any verdict is given: below this the margin of error is too wide. */
export const MIN_JUDGED = 200;

export type SignalLevel = "none" | "watching" | "validated" | "unproven" | "avoid";

/** What the live journal observed in a situation like the current one (only given from 20 judged forecasts). */
export interface Observed {
  label: string;
  hitRate: number;
  margin: number;
  n: number;
}

export interface SignalContext {
  /** Confidence shown with the forecast (0.5-1) */
  confidence?: number;
  vol?: VolRegime;
  trend?: TrendRegime;
}

export interface SignalStatus {
  level: SignalLevel;
  evaluated: number;
  needed: number;
  hitRate: number | null;
  margin: number | null;
  netReturnPct: number | null;
  label: string;
  detail: string;
  /** Observed hit rates in situations like the current one: confidence level, volatility, trend */
  observed?: Observed[];
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

/**
 * Is a forecast series proven in real conditions? Based on the live journal only (forecasts recorded in advance, judged
 * on the real price), never on the backtest. "Validated" needs all of: at least MIN_JUDGED judged calls, a hit rate
 * above 50 % beyond its margin of error, better than the naive strategies, and a positive result after the spread.
 */
/** Does the displayed confidence hold? And how did the model do in a market like the current one? */
export function observedFrom(stats: JournalStats | undefined, ctx: SignalContext): Observed[] {
  if (!stats) return [];
  const out: Observed[] = [];
  const add = (label: string, h: { hitRate: number | null; margin: number | null; samples: number }) => {
    if (h.hitRate !== null && h.margin !== null) out.push({ label, hitRate: h.hitRate, margin: h.margin, n: h.samples });
  };
  if (ctx.confidence !== undefined) {
    const bin = stats.calibration.find((c) => ctx.confidence! >= c.from && ctx.confidence! < c.to + 1e-9);
    if (bin) add(`Confiance affichée de ${Math.round(bin.from * 100)} à ${Math.round(bin.to * 100)} %`, bin.hit);
  }
  if (ctx.vol) add(`Marché ${VOL_LABEL[ctx.vol]}`, stats.byVol[ctx.vol]);
  if (ctx.trend) add(`Marché ${TREND_LABEL[ctx.trend]}`, stats.byTrend[ctx.trend]);
  return out;
}

export function signalFrom(stats: JournalStats | undefined, ctx: SignalContext = {}): SignalStatus {
  const status = signalLevel(stats);
  const observed = observedFrom(stats, ctx);
  return observed.length ? { ...status, observed } : status;
}

function signalLevel(stats: JournalStats | undefined): SignalStatus {
  const evaluated = stats?.evaluated ?? 0;
  const base = { evaluated, needed: MIN_JUDGED, hitRate: null, margin: null, netReturnPct: null };
  if (!stats || evaluated === 0) {
    return { ...base, level: "none", label: "Pas encore jugé", detail: "Aucune prévision de cette série n'a encore été comparée au vrai prix." };
  }
  const withStats = { ...base, hitRate: stats.model.hitRate, margin: stats.model.margin, netReturnPct: stats.netReturnPct };
  if (evaluated < MIN_JUDGED) {
    return {
      ...withStats,
      level: "watching",
      label: `En observation ${evaluated} / ${MIN_JUDGED}`,
      detail: `${evaluated} prévisions jugées sur ${MIN_JUDGED} nécessaires avant tout verdict : avec moins, la marge d'erreur est trop large.`,
    };
  }
  const v = verdict({
    hitRate: stats.model.hitRate,
    samples: stats.model.samples,
    margin: stats.model.margin,
    baselines: { alwaysUp: stats.baselines.alwaysUp, lastMove: stats.baselines.lastMove },
  });
  const rate = stats.model.hitRate == null ? "" : `${pct(stats.model.hitRate)} ± ${Math.round((stats.model.margin ?? 0) * 100)}`;
  if (v.level === "edge" && stats.netReturnPct > 0) {
    return { ...withStats, level: "validated", label: "Signal validé", detail: `Réussite en direct ${rate} sur ${evaluated} prévisions, meilleure que le hasard et que les stratégies naïves, résultat positif après spread.` };
  }
  if (v.level === "worse") {
    return { ...withStats, level: "avoid", label: "À éviter", detail: `Réussite en direct ${rate} : moins bon que le hasard sur ${evaluated} prévisions.` };
  }
  return {
    ...withStats,
    level: "unproven",
    label: "Non validé",
    detail:
      v.level === "edge"
        ? `Réussite en direct ${rate}, mais le résultat est négatif après spread : le spread mange l'avantage.`
        : `Réussite en direct ${rate} sur ${evaluated} prévisions : ${v.label.toLowerCase()}.`,
  };
}
