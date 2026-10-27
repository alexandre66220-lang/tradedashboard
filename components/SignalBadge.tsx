import type { SignalStatus } from "@/lib/signal";

const CLASS = { none: "none", watching: "none", validated: "edge", unproven: "naive", avoid: "worse" } as const;

/**
 * Is this forecast proven in real conditions? The answer comes from the live journal, not from the backtest.
 * Until it is validated the forecast is shown dimmed: it is information, not a signal to act on.
 */
export default function SignalBadge({ status }: { status: SignalStatus }) {
  return (
    <details className="signal">
      <summary>
        <span className={`verdict ${CLASS[status.level]}`}>{status.label}</span>
      </summary>
      <p className="muted small">{status.detail}</p>
      {status.observed && (
        <ul className="muted small observed">
          {status.observed.map((o) => (
            <li key={o.label}>
              {o.label} : réussite observée {Math.round(o.hitRate * 100)} % ± {Math.round(o.margin * 100)} ({o.n} prévisions)
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
