import type { BacktestStats, HitStat } from "./types";

export type VerdictLevel = "edge" | "naive" | "none" | "worse" | "unknown";

/** Turns a backtest into a plain-language verdict, taking the error margin into account. */
export function verdict(bt: HitStat & Partial<Pick<BacktestStats, "baselines">>): { level: VerdictLevel; label: string } {
  if (bt.hitRate == null || bt.margin == null) return { level: "unknown", label: "Pas assez de données" };
  if (bt.hitRate + bt.margin < 0.5) return { level: "worse", label: "Moins bon que le hasard" };
  if (bt.hitRate - bt.margin <= 0.5) return { level: "none", label: "Pas distinguable du hasard" };
  const best = Math.max(bt.baselines?.alwaysUp.hitRate ?? 0, bt.baselines?.lastMove.hitRate ?? 0);
  if (best >= bt.hitRate) return { level: "naive", label: "Ne bat pas une stratégie naïve" };
  return { level: "edge", label: "Mieux que le hasard" };
}
