import type { BacktestStats, HitStat } from "@/lib/types";
import { verdict } from "@/lib/verdict";

export const fmtHit = (s: Pick<HitStat, "hitRate" | "margin"> | null | undefined) =>
  s?.hitRate == null ? "—" : `${Math.round(s.hitRate * 100)} %${s.margin != null ? ` ± ${Math.round(s.margin * 100)}` : ""}`;

export function VerdictBadge({ bt }: { bt: BacktestStats }) {
  const v = verdict(bt);
  return <span className={`verdict ${v.level}`}>{v.label}</span>;
}

function Row({ label, stat, current }: { label: string; stat: HitStat; current?: boolean }) {
  return (
    <tr className={current ? "cur" : ""}>
      <th scope="row">{label}</th>
      <td>{fmtHit(stat)}</td>
      <td className="muted">{stat.samples}</td>
    </tr>
  );
}

/** Detail of the backtest: naive baselines and hit rate by confidence level. */
export default function BacktestDetails({ bt, confidence }: { bt: BacktestStats; confidence: number }) {
  // Strongest threshold the current prediction reaches
  const current = [...bt.byConfidence].reverse().find((c) => confidence >= c.minConfidence)?.minConfidence;
  return (
    <details className="bt">
      <summary>Détail du backtest</summary>
      <table>
        <thead>
          <tr>
            <th />
            <th>Réussite</th>
            <th>Cas</th>
          </tr>
        </thead>
        <tbody>
          <Row label="Ce modèle" stat={bt} />
          <Row label="Toujours « hausse »" stat={bt.baselines.alwaysUp} />
          <Row label="Suit la dernière bougie" stat={bt.baselines.lastMove} />
        </tbody>
        <tbody>
          {bt.byConfidence.map((c) => (
            <Row
              key={c.minConfidence}
              label={`Confiance ≥ ${Math.round(c.minConfidence * 100)} %${c.minConfidence === current ? " ← actuel" : ""}`}
              stat={c}
              current={c.minConfidence === current}
            />
          ))}
        </tbody>
      </table>
      <p className="muted small">
        « ± » : marge d’erreur à ~95 %. Si la réussite moins cette marge ne dépasse pas 50 %, le résultat peut s’expliquer
        par le hasard. Les stratégies naïves sont testées sur les mêmes cas : un modèle utile doit faire mieux qu’elles.
        Les lignes « confiance ≥ » ne gardent que les prédictions les plus franches.
      </p>
    </details>
  );
}
