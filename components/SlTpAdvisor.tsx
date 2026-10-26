"use client";

import { useEffect, useMemo, useState } from "react";
import { adviseSlTp, significance, type Advice, type Candidate, type ExitStats, type Side } from "@/lib/sltp";
import type { Candle, ForecastResponse } from "@/lib/types";
import Disclaimer from "./Disclaimer";

export interface AppliedLevels {
  distance: number;
  ratio: number;
  side: Side;
  nonce: number;
}

interface Props {
  epic: string;
  candles: Candle[];
  forecast: ForecastResponse | null;
  decimals: number;
  resMinutes: number;
  horizon: number;
  spreadBps: number;
  onApply: (a: Omit<AppliedLevels, "nonce">) => void;
}

const pct = (v: number) => `${Math.round(v * 100)} %`;
const r2 = (v: number) => v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number) => `${v > 0 ? "+" : ""}${r2(v)}`;

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m ? `${h} h ${m}` : `${h} h`;
}

const SIG_TEXT = {
  edge: "Sur cet historique, ce réglage a une espérance positive même en tenant compte de la marge d’erreur. À confirmer sur d’autres périodes : cela ne prouve rien pour l’avenir.",
  none: "Aucun avantage mesurable : ce réglage sert à contrôler votre risque, pas à gagner plus.",
  against: "Sur cet historique, ce réglage perd de l’argent après le spread.",
} as const;

function Expect({ s }: { s: ExitStats | null }) {
  if (!s) return <span className="muted">—</span>;
  const sig = significance(s);
  return (
    <span className={sig === "edge" ? "pos" : sig === "against" ? "neg" : ""}>
      {signed(s.netR)} R
    </span>
  );
}

export default function SlTpAdvisor({ epic, candles, forecast, decimals, resMinutes, horizon, spreadBps, onApply }: Props) {
  const [side, setSide] = useState<Side>("long");
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    if (forecast?.direction === "up") setSide("long");
    if (forecast?.direction === "down") setSide("short");
  }, [forecast?.direction, epic]);
  useEffect(() => setChosen(null), [epic, side]);

  const last = candles.at(-1)?.close ?? null;
  const holdBars = Math.max(12, Math.round(horizon / resMinutes) * 3);
  const target = forecast?.points.at(-1)?.value;
  const advice = useMemo<Advice | { error: string } | null>(() => {
    if (last === null || candles.length < 60) return null;
    return adviseSlTp({
      candles,
      side,
      entry: last,
      spreadBps,
      holdBars,
      forecast: forecast && target !== undefined ? { direction: forecast.direction, target } : null,
    });
  }, [candles, last, side, spreadBps, holdBars, forecast, target]);

  const ok = advice && !("error" in advice) ? advice : null;
  const selected: Candidate | undefined = ok ? (ok.targets.find((t) => t.key === (chosen ?? ok.recommended)) ?? ok.targets[0]) : undefined;
  const fmt = (v: number) => v.toFixed(decimals);

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Conseil SL / TP</span>
        <span className="tag">à tester</span>
      </div>
      <div className="seg rc-side" role="group" aria-label="Sens du trade">
        <button className={side === "long" ? "on" : ""} onClick={() => setSide("long")}>
          Achat
        </button>
        <button className={side === "short" ? "on" : ""} onClick={() => setSide("short")}>
          Vente
        </button>
      </div>

      {advice === null && <p className="muted small">En attente de l’historique…</p>}
      {advice && "error" in advice && <p className="muted small">{advice.error}</p>}

      {ok && selected && (
        <>
          <dl className="stats sl-top">
            <div>
              <dt>Entrée (prix actuel)</dt>
              <dd>{fmt(ok.entry)}</dd>
            </div>
            <div>
              <dt>Stop conseillé</dt>
              <dd className="neg">{fmt(ok.stop.price)}</dd>
            </div>
            <div>
              <dt>Objectif</dt>
              <dd className="pos">{fmt(selected.price)}</dd>
            </div>
          </dl>
          <p className="muted small sl-why">
            <strong>Stop</strong> : {ok.stop.reason}. Distance {fmt(ok.stop.distance)} ({ok.stop.atrMultiple.toFixed(1).replace(".", ",")} ATR).
            <br />
            <strong>Objectif « {selected.label} »</strong> : {selected.reason}. Rapport gain/risque {r2(selected.rr)}.
          </p>

          {ok.warnings.map((w) => (
            <p key={w} className="rc-warn">
              {w}
            </p>
          ))}

          <table className="sl-table">
            <thead>
              <tr>
                <th>Objectif</th>
                <th>R:R</th>
                <th>Touché avant le stop</th>
                <th>Espérance</th>
              </tr>
            </thead>
            <tbody>
              {ok.targets.map((t) => (
                <tr key={t.key} className={t.key === selected.key ? "cur" : ""} onClick={() => setChosen(t.key)} aria-selected={t.key === selected.key}>
                  <th scope="row">
                    {t.label}
                    {t.key === ok.recommended && <span className="sl-rec" title="Réglage conseillé"> ★</span>}
                    <span className="muted small block">{fmt(t.price)}</span>
                  </th>
                  <td>{r2(t.rr)}</td>
                  <td>{t.stats ? pct(t.stats.pTp) : "—"}</td>
                  <td>
                    <Expect s={t.stats} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {selected.stats && (
            <div className="sl-sum">
              <p>
                Sur {selected.stats.samples.toLocaleString("fr-FR")} entrées de l’historique chargé, tenues au plus {duration(ok.holdBars * resMinutes)} :{" "}
                <strong>{pct(selected.stats.pTp)}</strong> touchent l’objectif avant le stop, <strong>{pct(selected.stats.pSl)}</strong> le stop avant
                l’objectif, {pct(selected.stats.pTimeout)} ni l’un ni l’autre. Espérance après spread :{" "}
                <strong>
                  {signed(selected.stats.netR)} R ± {r2(2 * selected.stats.se)}
                </strong>{" "}
                (1 R = le risque pris).
              </p>
              <p className="muted small">
                Seuil d’équilibre : il faudrait toucher l’objectif {pct(1 / (1 + selected.rr))} du temps, sans compter le spread. Même test à l’envers (
                {side === "long" ? "vente" : "achat"}) : <Expect s={selected.otherSide} />. Un écart entre les deux vient surtout de la tendance
                récente.
              </p>
              <p className={`sl-verdict ${significance(selected.stats)}`}>{SIG_TEXT[significance(selected.stats)]}</p>
            </div>
          )}

          <button className="sl-apply" onClick={() => onApply({ distance: ok.stop.distance, ratio: selected.rr, side })}>
            Utiliser dans le calculateur de risque
          </button>
        </>
      )}

      <Disclaimer>
        Le stop est placé au-delà du dernier creux (achat) ou sommet (vente), avec une marge, sinon à 1,5 ATR ; les objectifs viennent du prochain
        niveau, de la prévision du modèle ou d’un multiple du risque. Le test rejoue chaque réglage à partir de chaque bougie de l’historique
        chargé ; si une bougie touche le stop et l’objectif, le stop est supposé touché en premier. La marge d’erreur compte une seule fois les
        entrées qui se chevauchent. Comparer plusieurs objectifs sur le même historique peut flatter l’un d’eux : méfiez-vous d’un seul bon
        résultat. Ce n’est pas un conseil d’investissement.
      </Disclaimer>
    </section>
  );
}
