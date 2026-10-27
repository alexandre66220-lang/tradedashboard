"use client";

import { useEffect, useState } from "react";
import { OUTLOOKS } from "@/config/instruments";
import type { ApiError, OutlookCell, OutlookResponse } from "@/lib/types";
import { verdict } from "@/lib/verdict";
import { fmtHit } from "./BacktestDetails";
import Disclaimer from "./Disclaimer";

const POLL_MS = 5 * 60_000;
const ARROW = { up: "▲", down: "▼", flat: "▶" } as const;

const pct = (v: number, signed = false) =>
  `${signed && v > 0 ? "+" : ""}${(v * 100).toLocaleString("fr-FR", { maximumFractionDigits: v !== 0 && Math.abs(v) < 0.01 ? 2 : 1 })} %`;

const price = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: v < 10 ? 4 : 2 });

function Cell({ cell }: { cell: OutlookCell | { error: string } | undefined }) {
  if (!cell) return <td className="muted">…</td>;
  if ("error" in cell || !Number.isFinite(cell.change)) {
    return (
      <td className="muted small" title={"error" in cell ? cell.error : undefined}>
        indisponible
      </td>
    );
  }
  return (
    <td
      title={`Cible ${price(cell.target)} (fourchette ${price(cell.low)} – ${price(cell.high)}) · confiance ${pct(cell.confidence)}${
        cell.backtest ? ` · ${verdict(cell.backtest).label}` : ""
      }`}
    >
      <span className={`dir-${cell.direction}`}>
        {ARROW[cell.direction]} {pct(cell.change, true)}
      </span>
      <span className={`small block hit-${cell.backtest ? verdict(cell.backtest).level : "unknown"}`}>
        {cell.backtest ? fmtHit(cell.backtest) : cell.backtestHitRate == null ? "—" : `${Math.round(cell.backtestHitRate * 100)} %`}
      </span>
    </td>
  );
}

export default function OutlookPanel({ selected, onSelect }: { selected: string; onSelect: (epic: string) => void }) {
  const [data, setData] = useState<OutlookResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      clearTimeout(timer);
      if (!document.hidden) {
        try {
          const res = await fetch("/api/outlook", { signal: ctrl.signal, cache: "no-store" });
          if (res.status === 401) {
            window.location.href = "/login";
            return;
          }
          const body = (await res.json()) as OutlookResponse | ApiError;
          if (!res.ok || "error" in body) throw new Error("error" in body ? body.error.message : `Erreur ${res.status}`);
          setData(body);
          setError(null);
        } catch (e) {
          if (ctrl.signal.aborted) return;
          setError((e as Error).message || "Serveur injoignable.");
        }
      }
      if (!ctrl.signal.aborted) timer = setTimeout(run, POLL_MS);
    };
    const onVisible = () => !document.hidden && run();
    run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Prévisions jour / semaine</span>
        <span className="tag">expérimental</span>
      </div>
      {data ? (
        <table className="outlook">
          <thead>
            <tr>
              <th />
              {OUTLOOKS.map((o) => (
                <th key={o.key}>{o.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr
                key={item.epic}
                className={item.epic === selected ? "sel" : ""}
                onClick={() => onSelect(item.epic)}
                aria-selected={item.epic === selected}
              >
                <th scope="row">
                  {item.name}
                  {item.last != null && <span className="muted small block">{price(item.last)}</span>}
                </th>
                {OUTLOOKS.map((o) => (
                  <Cell key={o.key} cell={item.horizons[o.key]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">{error ?? "Calcul en cours…"}</p>
      )}
      {data && error && <p className="muted small">Mise à jour impossible : {error}</p>}
      <Disclaimer>
        Variation attendue sur la prochaine bougie journalière / hebdomadaire, même modèle
        {data?.source ? ` (${data.source})` : ""}. En petit : réussite du backtest (part de directions correctes) sur l’historique
        disponible, avec sa marge d’erreur (vert : mieux que le hasard, rouge : moins bon). Touchez une ligne pour afficher
        l’instrument.
      </Disclaimer>
    </section>
  );
}
