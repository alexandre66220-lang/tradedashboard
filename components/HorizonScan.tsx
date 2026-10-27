"use client";

import { useEffect, useRef, useState } from "react";
import { HORIZON_CHOICES } from "@/config/instruments";
import type { ApiError, ForecastResponse } from "@/lib/types";
import { verdict } from "@/lib/verdict";

interface Row {
  horizon: number;
  forecast?: ForecastResponse;
  error?: string;
}

const fmtRate = (f: ForecastResponse) => {
  const b = f.backtest;
  return !b || b.hitRate == null ? "—" : `${Math.round(b.hitRate * 100)} %${b.margin != null ? ` ± ${Math.round(b.margin * 100)}` : ""}`;
};

/**
 * Backtest of the same model at several horizons. If an edge exists it is rarely at the horizon chosen at random:
 * this shows where the backtest looks best, and where it does not. Read the margins: the more horizons are compared,
 * the likelier one of them looks good by chance.
 */
export default function HorizonScan({ epic, resolution }: { epic: string; resolution: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [running, setRunning] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  // another instrument or timeframe makes the previous table obsolete
  useEffect(() => {
    ctrl.current?.abort();
    setRows(null);
    setRunning(false);
    return () => ctrl.current?.abort();
  }, [epic, resolution]);

  async function run() {
    ctrl.current?.abort();
    const c = (ctrl.current = new AbortController());
    setRunning(true);
    setRows(HORIZON_CHOICES.map((horizon) => ({ horizon })));
    let next = 0;
    const worker = async () => {
      while (next < HORIZON_CHOICES.length && !c.signal.aborted) {
        const horizon = HORIZON_CHOICES[next++];
        let row: Row;
        try {
          const q = new URLSearchParams({ epic, resolution, horizon: String(horizon), norecord: "1" });
          const res = await fetch(`/api/forecast?${q}`, { signal: c.signal, cache: "no-store" });
          if (res.status === 401) {
            window.location.href = "/login";
            return;
          }
          const body = (await res.json().catch(() => null)) as ForecastResponse | ApiError | null;
          row = res.ok && body && "points" in body ? { horizon, forecast: body } : { horizon, error: (body && "error" in body && body.error.message) || `Erreur ${res.status}` };
        } catch (e) {
          if (c.signal.aborted) return;
          row = { horizon, error: (e as Error).message || "Serveur injoignable." };
        }
        setRows((cur) => cur?.map((r) => (r.horizon === horizon ? row : r)) ?? null);
      }
    };
    await Promise.all([worker(), worker()]);
    if (!c.signal.aborted) setRunning(false);
  }

  return (
    <div className="cmp">
      <button type="button" className="ghost" onClick={run} disabled={running}>
        {running ? "Comparaison en cours…" : rows ? "Relancer la comparaison des horizons" : "Comparer les horizons"}
      </button>
      {rows && (
        <>
          <table>
            <thead>
              <tr>
                <th />
                <th>Réussite</th>
                <th>Net / appel</th>
                <th>Cas</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const b = r.forecast?.backtest;
                const net = b?.avgNetBps;
                return (
                  <tr key={r.horizon}>
                    <th scope="row">
                      {r.horizon} min
                      {b && <span className={`verdict ${verdict(b).level}`}>{verdict(b).label}</span>}
                    </th>
                    <td>{r.forecast ? fmtRate(r.forecast) : r.error ? "indisponible" : "…"}</td>
                    <td className={net == null ? "muted" : net > 0 ? "pos" : "neg"}>
                      {net == null ? "—" : `${net > 0 ? "+" : ""}${net.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} pt`}
                    </td>
                    <td className="muted">{b?.samples ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted small explain">
            Même modèle, même méthode, seul l’horizon change (le calcul peut prendre une minute). Un horizon n’est intéressant que si sa marge
            d’erreur exclut 50 % <em>et</em> que le net est positif ; avec quatre horizons comparés, un résultat isolé peut être de la chance.
            Seul le journal en direct tranche.
          </p>
        </>
      )}
    </div>
  );
}
