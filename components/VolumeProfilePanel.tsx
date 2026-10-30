import { AUCTION_LABEL, positionVsValue, valueRelation, volumeProfile } from "@/lib/profile";
import type { Candle } from "@/lib/types";
import Disclaimer from "./Disclaimer";

interface Props {
  candles: Candle[];
  resMinutes: number;
  direction: "up" | "down" | "flat" | undefined;
  decimals: number;
}

const RELATION_TEXT = {
  inside: "",
  toward: " La prévision va vers la zone de valeur (retour à la valeur).",
  away: " La prévision continue loin de la zone de valeur (le marché accepte les nouveaux prix).",
};

/** The day's volume profile (Auction Market Theory): where the price spent its volume, the value area and where the price stands. */
export default function VolumeProfilePanel({ candles, resMinutes, direction, decimals }: Props) {
  const p = volumeProfile(candles, resMinutes);
  const last = candles.at(-1)?.close;
  if (!p || last === undefined) return null;
  const pos = positionVsValue(last, p);
  const rel = direction ? valueRelation(direction, pos) : null;
  const max = Math.max(...p.bins.map((b) => b.volume));
  const lo = p.bins[0].price - p.binSize / 2;
  const hi = p.bins[p.bins.length - 1].price + p.binSize / 2;
  const H = 150;
  const W = 220;
  const y = (price: number) => ((hi - price) / (hi - lo)) * H;
  const fmt = (v: number) => v.toFixed(decimals);
  return (
    <section className="panel">
      <div className="panel-head">
        <span>Profil de volume (AMT)</span>
        <span className="tag">{p.basis === "volume" ? "volume des CFD" : "temps passé"}</span>
      </div>
      <svg className="vp-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Profil de volume de la journée">
        <rect x={0} y={y(p.vah)} width={W} height={Math.max(1, y(p.val) - y(p.vah))} className="vp-va" />
        {p.bins.map((b) => (
          <rect key={b.price} x={0} y={y(b.price + p.binSize / 2) + 0.5} width={(b.volume / max) * (W - 4)} height={Math.max(1, (p.binSize / (hi - lo)) * H - 1)} className="vp-bar" />
        ))}
        <line x1={0} x2={W} y1={y(p.poc)} y2={y(p.poc)} className="vp-poc" />
        <line x1={0} x2={W} y1={y(last)} y2={y(last)} className="vp-last" />
      </svg>
      <dl className="stats">
        <div>
          <dt>POC (le plus échangé)</dt>
          <dd>{fmt(p.poc)}</dd>
        </div>
        <div>
          <dt>Zone de valeur (≈70 %)</dt>
          <dd>
            {fmt(p.val)} – {fmt(p.vah)}
          </dd>
        </div>
        <div>
          <dt>Prix actuel</dt>
          <dd>{fmt(last)}</dd>
        </div>
      </dl>
      <p className="small sent-read">
        <strong>{AUCTION_LABEL[pos]}</strong>.{rel && RELATION_TEXT[rel]}
      </p>
      <Disclaimer>
        Lecture inspirée de la théorie des enchères (Market Profile) : le marché passe son temps autour d’un prix « juste » (le POC et la zone de valeur autour,
        où a eu lieu environ 70 % de l’activité de la dernière journée), puis part vers une autre zone quand un camp domine. Un prix au-dessus ou en dessous
        de la zone de valeur est tantôt attiré de nouveau vers elle, tantôt il s’y installe : rien ne dit lequel arrive, et le journal des prévisions enregistre
        la position du prix avec chaque prévision pour mesurer si la prévision réussit mieux dans l’un ou l’autre cas. Le « volume » d’un CFD compte les mouvements
        du prix, pas les quantités réellement échangées : ce n’est pas du vrai flux d’ordres. Calculé sur la dernière journée de bougies, sans la bougie en cours.
      </Disclaimer>
    </section>
  );
}
