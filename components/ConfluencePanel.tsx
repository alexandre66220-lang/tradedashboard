"use client";

import { useMemo } from "react";
import { technicalVotes, type VoteValue } from "@/lib/indicators";
import type { Candle } from "@/lib/types";
import Disclaimer from "./Disclaimer";

const MARK: Record<VoteValue, string> = { 1: "▲", [-1]: "▼", 0: "–" };
const CLASS: Record<VoteValue, string> = { 1: "pos", [-1]: "neg", 0: "muted" };

/**
 * Five classic readings (moving averages, RSI, MACD, breakout, higher timeframe) and how many agree with the forecast.
 * The count is written to the journal with each forecast: whether agreement helps is measured there, not assumed.
 */
export default function ConfluencePanel({ candles, resMinutes, direction }: { candles: Candle[]; resMinutes: number; direction: "up" | "down" | "flat" | undefined }) {
  const votes = useMemo(() => (candles.length >= 60 ? technicalVotes(candles, resMinutes) : []), [candles, resMinutes]);
  const want = direction === "up" ? 1 : direction === "down" ? -1 : 0;
  const agree = want ? votes.filter((v) => v.vote === want).length : 0;
  const against = want ? votes.filter((v) => v.vote === -want).length : 0;

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Accord des indicateurs</span>
        <span className="tag">à tester</span>
      </div>
      {votes.length === 0 ? (
        <p className="muted small">Pas assez d’historique.</p>
      ) : (
        <>
          <p className="confl-sum">
            {want ? (
              <>
                <strong>{agree} sur {votes.length}</strong> vont dans le sens de la prévision{against ? `, ${against} à contre-sens` : ""}.
              </>
            ) : (
              <>Prévision neutre : pas d’accord à compter.</>
            )}
          </p>
          <ul className="votes">
            {votes.map((v) => (
              <li key={v.id}>
                <span className={`mark ${CLASS[v.vote]}`} aria-label={v.vote === 1 ? "hausse" : v.vote === -1 ? "baisse" : "neutre"}>
                  {MARK[v.vote]}
                </span>
                <div>
                  <strong>{v.label}</strong>
                  <p className="muted small explain">{v.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <Disclaimer>
        Ces indicateurs sont tous calculés à partir des mêmes prix passés : leur accord est moins informatif qu’il n’en a l’air, et le modèle de
        prévision en utilise déjà plusieurs. Le nombre d’accords est enregistré avec chaque prévision du journal ; l’onglet Journal montre, au fil des
        semaines, si 4 ou 5 accords réussissent vraiment mieux que 0 ou 1.
      </Disclaimer>
    </section>
  );
}
