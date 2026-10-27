import { TREND_LABEL, VOL_LABEL, type Regime } from "@/lib/regime";
import type { SignalStatus } from "@/lib/signal";
import type { ForecastResponse } from "@/lib/types";
import { verdict } from "@/lib/verdict";

const ARROW = { up: "▲", down: "▼", flat: "▶" } as const;
const WORD = { up: "Hausse", down: "Baisse", flat: "Neutre" } as const;
const SIGNAL_CLASS = { none: "none", watching: "none", validated: "edge", unproven: "naive", avoid: "worse" } as const;

/** One line under the price: what the model says, whether it is proven, and what its backtest says. */
export default function StatusStrip({ horizon, forecast, signal, regime }: { horizon: number; forecast: ForecastResponse | null; signal: SignalStatus | null; regime?: Regime | null }) {
  if (!forecast) return null;
  const v = forecast.backtest ? verdict(forecast.backtest) : null;
  return (
    <section className="strip" aria-label="Résumé de la prévision">
      <span className={`chip dir ${forecast.direction}${signal && signal.level !== "validated" ? " unproven" : ""}`}>
        {ARROW[forecast.direction]} {WORD[forecast.direction]} {horizon} min · {Math.round(forecast.confidence * 100)} %
      </span>
      {signal && <span className={`verdict ${SIGNAL_CLASS[signal.level]}`}>{signal.label}</span>}
      {v && <span className="chip muted">Backtest : {v.label.toLowerCase()}</span>}
      {regime && <span className="chip muted">Marché {VOL_LABEL[regime.vol]}, {TREND_LABEL[regime.trend]}</span>}
    </section>
  );
}
