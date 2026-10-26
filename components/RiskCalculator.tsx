"use client";

import { useEffect, useState } from "react";
import { sizePosition } from "@/lib/risk";

interface Props {
  epic: string;
  last: number | null;
  atr: number | null;
  direction?: "up" | "down" | "flat";
  decimals: number;
}

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const num = (s: string) => Number(s.replace(",", "."));
const money = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 2 });

export default function RiskCalculator({ epic, last, atr, direction, decimals }: Props) {
  const [capital, setCapital] = useState("1000");
  const [riskPct, setRiskPct] = useState("1");
  const [ratio, setRatio] = useState("2");
  const [atrMult, setAtrMult] = useState("1.5");
  const [side, setSide] = useState<"long" | "short">("long");
  const [manualStop, setManualStop] = useState("");

  useEffect(() => {
    setCapital(load("rc:capital", "1000"));
    setRiskPct(load("rc:risk", "1"));
    setRatio(load("rc:ratio", "2"));
    setAtrMult(load("rc:atr", "1.5"));
  }, []);
  // Follow the forecast's direction when it has one
  useEffect(() => {
    if (direction === "up") setSide("long");
    if (direction === "down") setSide("short");
  }, [direction, epic]);
  useEffect(() => setManualStop(""), [epic]);

  const stopDistance = manualStop !== "" ? num(manualStop) : atr != null ? atr * num(atrMult) : NaN;
  const res =
    last != null
      ? sizePosition({ capital: num(capital), riskPct: num(riskPct), entry: last, stopDistance, side, rewardRatio: num(ratio) })
      : { error: "En attente du prix…" };

  const field = (label: string, value: string, set: (v: string) => void, key?: string, suffix?: string) => (
    <label className="rc-field">
      <span>{label}</span>
      <span className="rc-input">
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            set(e.target.value);
            if (key) save(key, e.target.value);
          }}
        />
        {suffix && <em>{suffix}</em>}
      </span>
    </label>
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Calculateur de risque</span>
      </div>
      <div className="seg rc-side" role="group" aria-label="Sens du trade">
        <button className={side === "long" ? "on" : ""} onClick={() => setSide("long")}>
          Achat
        </button>
        <button className={side === "short" ? "on" : ""} onClick={() => setSide("short")}>
          Vente
        </button>
      </div>
      <div className="rc-grid">
        {field("Capital", capital, setCapital, "rc:capital", "$")}
        {field("Risque par trade", riskPct, setRiskPct, "rc:risk", "%")}
        {field("Gain visé / risque", ratio, setRatio, "rc:ratio", "×")}
        {field("Stop = ATR ×", atrMult, setAtrMult, "rc:atr")}
      </div>
      <label className="rc-field rc-manual">
        <span>
          Stop manuel (distance){atr != null ? ` · ATR ${atr.toFixed(decimals)}` : ""}
        </span>
        <span className="rc-input">
          <input inputMode="decimal" placeholder="auto" value={manualStop} onChange={(e) => setManualStop(e.target.value)} />
        </span>
      </label>

      {"error" in res ? (
        <p className="muted small">{res.error}</p>
      ) : (
        <>
          <dl className="stats rc-out">
            <div>
              <dt>Taille</dt>
              <dd>{res.units.toLocaleString("fr-FR")} u.</dd>
            </div>
            <div>
              <dt>Stop</dt>
              <dd className="neg">{res.stop.toFixed(decimals)}</dd>
            </div>
            <div>
              <dt>Objectif</dt>
              <dd className="pos">{res.takeProfit.toFixed(decimals)}</dd>
            </div>
            <div>
              <dt>Perte max.</dt>
              <dd>{money(res.maxLoss)} $</dd>
            </div>
            <div>
              <dt>Gain visé</dt>
              <dd>{money(res.potentialGain)} $</dd>
            </div>
            <div>
              <dt>Levier effectif</dt>
              <dd>{res.leverage.toFixed(1)}×</dd>
            </div>
          </dl>
          {res.warnings.map((w) => (
            <p key={w} className="rc-warn">
              {w}
            </p>
          ))}
        </>
      )}
      <p className="disclaimer">
        Montants dans la devise de cotation (USD) : convertissez votre capital si votre compte est en euros. « u. » = unités du contrat : vérifiez la
        valeur d’une unité chez Capital.com. L’ATR (amplitude moyenne des 14 dernières bougies) sert à placer le stop hors du bruit normal. Le
        spread et le glissement ne sont pas inclus. Ce n’est pas un conseil d’investissement.
      </p>
    </section>
  );
}
