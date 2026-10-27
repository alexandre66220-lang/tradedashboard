"use client";

import { useEffect, useState } from "react";
import { OUTLOOKS } from "@/config/instruments";
import { OUTLOOK_PENDING, type ApiError, type OutlookCell, type OutlookResponse } from "@/lib/types";
import { verdict } from "@/lib/verdict";
import { fmtHit } from "./BacktestDetails";
import { readJson, RETRY_AFTER_FAILURE_MS, unexpectedResponse } from "@/lib/readJson";
import Disclaimer from "./Disclaimer";

const POLL_MS = 5 * 60_000;
const PENDING_RETRY_MS = 15_000; // some forecasts were still being computed
const ARROW = { up: "▲", down: "▼", flat: "▶" } as const;

const pct = (v: number, signed = false) =>
  `${signed && v > 0 ? "+" : ""}${(v * 100).toLocaleString("fr-FR", { maximumFractionDigits: v !== 0 && Math.abs(v) < 0.01 ? 2 : 1 })} %`;

const price = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: v < 10 ? 4 : 2 });

function Cell({ cell }: { cell: OutlookCell | { error: string } | undefined }) {
  if (!cell) return <td className="muted">…</td>;
  if ("error" in cell && cell.error === OUTLOOK_PENDING) return <td className="muted small">calcul…</td>;
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
    let failed = false;
    let pending = false;
    // What this page has been given for the forecasts that were missing from the store: the forecast itself, or why the
    // server could not make it. Used even if the store does not return it (the answer of the request is enough).
    const given = new Map<string, OutlookCell | { error: string }>();
    const lastPrice = new Map<string, number>();

    const withGiven = (body: OutlookResponse): OutlookResponse => {
      if (given.size === 0) return body;
      let stillPending = false;
      const items = body.items.map((item) => ({
        ...item,
        last: item.last ?? lastPrice.get(item.epic) ?? null,
        horizons: Object.fromEntries(
          Object.entries(item.horizons).map(([key, cell]) => {
            const isPending = "error" in cell && cell.error === OUTLOOK_PENDING;
            const mine = given.get(`${item.epic}|${key}`);
            if (isPending && mine) return [key, mine];
            if (isPending) stillPending = true;
            return [key, cell];
          }),
        ),
      }));
      return { ...body, items, pending: stillPending };
    };

    const load = async (): Promise<OutlookResponse | null> => {
      const res = await fetch("/api/outlook", { signal: ctrl.signal, cache: "no-store" });
      if (res.status === 401) {
        window.location.href = "/login";
        return null;
      }
      const body = await readJson<OutlookResponse | ApiError>(res);
      if (!body) throw unexpectedResponse(res);
      if (!res.ok || "error" in body) throw new Error("error" in body ? body.error.message : `Erreur ${res.status}`);
      return withGiven(body);
    };

    // A forecast that is not stored yet is asked for in a request of its own, which waits for the model (two at a time).
    const fillIn = async (first: OutlookResponse) => {
      const todo: Array<[string, string]> = [];
      for (const item of first.items)
        for (const [key, cell] of Object.entries(item.horizons)) if ("error" in cell && cell.error === OUTLOOK_PENDING) todo.push([item.epic, key]);
      let next = 0;
      const worker = async () => {
        while (next < todo.length && !ctrl.signal.aborted) {
          const [epic, key] = todo[next++];
          try {
            const res = await fetch(`/api/outlook/cell?epic=${encodeURIComponent(epic)}&key=${key}`, { signal: ctrl.signal, cache: "no-store" });
            if (res.status === 401) {
              window.location.href = "/login";
              return;
            }
            const body = await readJson<{ cell?: OutlookCell; last?: number | null } & Partial<ApiError>>(res);
            if (res.ok && body?.cell) {
              given.set(`${epic}|${key}`, body.cell);
              if (key === "day" && typeof body.last === "number") lastPrice.set(epic, body.last);
            } else {
              given.set(`${epic}|${key}`, { error: body?.error?.message ?? unexpectedResponse(res).message });
            }
          } catch (e) {
            if (ctrl.signal.aborted) return;
            given.set(`${epic}|${key}`, { error: (e as Error).message || "Serveur injoignable." });
          }
          const body = await load().catch(() => null);
          if (body && !ctrl.signal.aborted) {
            setData(body);
            pending = Boolean(body.pending);
          }
        }
      };
      await Promise.all([worker(), worker()]);
    };

    const run = async () => {
      clearTimeout(timer);
      if (!document.hidden) {
        try {
          given.clear();
          lastPrice.clear();
          const body = await load();
          if (body) {
            setData(body);
            setError(null);
            failed = false;
            pending = Boolean(body.pending);
            if (body.pending) await fillIn(body);
          }
        } catch (e) {
          if (ctrl.signal.aborted) return;
          failed = true;
          setError((e as Error).message || "Serveur injoignable.");
        }
      }
      if (!ctrl.signal.aborted) timer = setTimeout(run, failed ? RETRY_AFTER_FAILURE_MS : pending ? PENDING_RETRY_MS : POLL_MS);
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
