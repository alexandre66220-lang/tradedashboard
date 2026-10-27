import type { BacktestStats, HitStat } from "@/lib/types";
import { verdict } from "@/lib/verdict";
import ModelCompare from "./ModelCompare";

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
export default function BacktestDetails({
  bt,
  confidence,
  features,
  compareQuery,
}: {
  bt: BacktestStats;
  confidence: number;
  /** What the external model looked at */
  features?: string[];
  /** Query string (epic, resolution, horizon) to compare model versions; only for the external model */
  compareQuery?: string;
}) {
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
      {(bt.coverage != null || bt.avgNetBps != null) && (
        <p className="muted small">
          {bt.coverage != null ? `Le modèle prend position sur ${Math.round(bt.coverage * 100)} % des bougies testées (le reste : neutre). ` : ""}
          {bt.avgNetBps != null
            ? `Résultat moyen d’un pari après spread : ${bt.avgNetBps > 0 ? "+" : ""}${bt.avgNetBps.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} pt (1 pt = 0,01 % du prix).`
            : ""}
        </p>
      )}
      {features && features.length > 0 && <p className="muted small">Le modèle regarde : {features.join(", ")}.</p>}
      {compareQuery && <ModelCompare query={compareQuery} />}
      <p className="muted small">
        « ± » : marge d’erreur à ~95 %. Si la réussite moins cette marge ne dépasse pas 50 %, le résultat peut s’expliquer
        par le hasard. Les stratégies naïves sont testées sur les mêmes cas : un modèle utile doit faire mieux qu’elles.
        Les lignes « confiance ≥ » ne gardent que les prédictions les plus franches.
      </p>
    </details>
  );
}
