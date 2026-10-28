"use client";

import { useEffect, useState } from "react";
import { MARKETS, isOpen, nextChange, nextGapChange, parisNewYorkGap, sessionAt, type SessionKey } from "@/lib/sessions";
import Disclaimer from "./Disclaimer";

const SESSION_TEXT: Record<SessionKey, string> = {
  asia: "Seule Tokyo est ouverte : séance calme pour l’or et le pétrole.",
  europe: "Londres est ouverte, New York pas encore.",
  overlap: "Londres et New York sont ouvertes ensemble : les heures les plus actives.",
  us: "New York est ouverte, Londres est fermée.",
  night: "Aucune des trois grandes places n’est ouverte (nuit ou week-end) : peu de volume.",
};

const hm = (ms: number) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const day = (ms: number) => new Date(ms).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
function when(ms: number, now: number): string {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  return sameDay ? hm(ms) : `${day(ms)} ${hm(ms)}`;
}

/** Which big markets are open now, with times in the device's own time zone, and the Paris / New York clock gap. */
export default function MarketClock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return null;

  const gap = parisNewYorkGap(now);
  const change = nextGapChange(now);
  const session = sessionAt(now);
  return (
    <section className="panel">
      <div className="panel-head">
        <span>Horloge des marchés</span>
        <span className="tag">heure de votre appareil</span>
      </div>
      <ul className="clock-list">
        {MARKETS.map((m) => {
          const open = isOpen(m, now);
          const next = nextChange(m, now);
          return (
            <li key={m.key}>
              <span className={open ? "hdot ok" : "hdot off"} aria-hidden="true" />
              <strong>{m.label}</strong>
              <span className="muted small">
                {open ? "ouverte" : "fermée"}
                {next ? ` · ${next.opens ? "ouvre" : "ferme"} ${when(next.at, now)}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="small sent-read">{SESSION_TEXT[session]}</p>
      <p className="muted small">
        Décalage Paris / New York : <strong>{gap} h</strong>
        {change ? ` (passe à ${change.gap} h le ${day(change.at)})` : ""}
        {" "}
        {gap !== 6 && " Ce n’est pas l’écart habituel de 6 h : l’ouverture de Wall Street tombe une heure plus tôt (ou plus tard) qu’à l’ordinaire pour l’instant."}
      </p>
      <Disclaimer>
        Les heures d’ouverture suivent les horaires locaux de chaque place (Tokyo 9 h – 15 h 30, Londres 8 h – 16 h 30, New York 9 h 30 – 16 h) et le passage à
        l’heure d’été ou d’hiver, qui n’a pas lieu aux mêmes dates en Europe et aux États-Unis. Les jours fériés ne sont pas pris en compte : le statut du
        marché affiché en haut vient de Capital.com. Le journal des prévisions classe chaque prévision selon cette séance réelle.
      </Disclaimer>
    </section>
  );
}
