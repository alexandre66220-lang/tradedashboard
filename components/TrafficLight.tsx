import type { LightResult } from "@/lib/trafficlight";

const LABEL = { green: "Conditions normales", orange: "Prudence", red: "Pas de trade maintenant" } as const;

/** Compact status pill; tap to see why. Informational only: nothing is blocked. */
export default function TrafficLight({ result, assumedSpreadBps }: { result: LightResult; assumedSpreadBps: number }) {
  return (
    <details className={`light ${result.light}`}>
      <summary>
        <span className="dot" aria-hidden />
        <strong>{LABEL[result.light]}</strong>
        {result.reasons.length > 0 && <span className="muted small"> · {result.reasons.length} raison{result.reasons.length > 1 ? "s" : ""}</span>}
      </summary>
      <div className="light-body">
        {result.reasons.length === 0 && <p className="small">{`Marché ouvert, spread et volatilité dans la norme${result.newsChecked ? ", aucune annonce proche" : ""}, limite du jour respectée.`}</p>}
        <ul>
          {result.reasons.map((r) => (
            <li key={r.text} className={r.level}>
              {r.text}
            </li>
          ))}
        </ul>
        <p className="muted small">
          Spread actuel : {result.spreadBps === null ? "inconnu" : `${result.spreadBps.toFixed(1)} points de base`} (supposé : {assumedSpreadBps}).
          {result.atrPercentile !== null && ` Volatilité : ${Math.round(result.atrPercentile * 100)}ᵉ centile de l’historique chargé.`}
        </p>
        <p className="muted small">Ce feu n’empêche rien : il rappelle de vérifier avant de prendre une position.</p>
      </div>
    </details>
  );
}
