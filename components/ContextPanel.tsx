import { cotRelation, fundingRelation, type ContextResponse } from "@/lib/context/types";
import Disclaimer from "./Disclaimer";

interface Props {
  data: ContextResponse | null;
  direction: "up" | "down" | "flat" | undefined;
}

const pct = (v: number, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d).replace(".", ",")} %`;

function fundingMood(f: number): string {
  if (f >= 0.0002) return "longs surchargés (ils paient les vendeurs)";
  if (f <= -0.00005) return "vendeurs surchargés (ils paient les acheteurs)";
  return "équilibré";
}

function cotMood(p: number): string {
  if (p >= 80) return "très acheteurs, près du haut de leur fourchette";
  if (p >= 60) return "plutôt acheteurs";
  if (p > 40) return "partagés";
  if (p > 20) return "plutôt vendeurs";
  return "très vendeurs, près du bas de leur fourchette";
}

const SAME: Record<string, string> = { with: "La prévision va dans le sens de cette foule.", against: "La prévision va à contre-courant de cette foule." };

/** Positioning around the instrument: Bitcoin perpetual futures (OKX) and the big speculators (CFTC). Shown for context only. */
export default function ContextPanel({ data, direction }: Props) {
  if (!data) return null;
  const { derivs, cot, sources } = data;
  if (sources.derivs === "none" && sources.cot === "none") return null;
  const f = derivs && direction ? fundingRelation(direction, derivs.funding) : null;
  const c = cot && direction ? cotRelation(direction, cot.percentile) : null;
  return (
    <section className="panel">
      <div className="panel-head">
        <span>Positionnement du marché</span>
        <span className="tag">contexte</span>
      </div>
      {sources.derivs !== "none" &&
        (derivs ? (
          <div className="ctx-block">
            <strong>Dérivés Bitcoin (OKX)</strong>
            <dl className="stats">
              <div>
                <dt>Funding / 8 h</dt>
                <dd>{pct(derivs.funding * 100, 4)}</dd>
              </div>
              {derivs.longPct !== null && (
                <div>
                  <dt>Comptes acheteurs</dt>
                  <dd>{derivs.longPct.toFixed(0)} %</dd>
                </div>
              )}
              {derivs.oi1hPct !== null && (
                <div>
                  <dt>Positions ouvertes, 1 h</dt>
                  <dd className={derivs.oi1hPct >= 0 ? "pos" : "neg"}>{pct(derivs.oi1hPct, 2)}</dd>
                </div>
              )}
            </dl>
            <p className="small sent-read">
              Funding : <strong>{fundingMood(derivs.funding)}</strong>. {f && SAME[f]}
            </p>
          </div>
        ) : (
          <p className="muted small">Dérivés Bitcoin : source non disponible pour l’instant.</p>
        ))}
      {sources.cot !== "none" &&
        (cot ? (
          <div className="ctx-block">
            <strong>Grands spéculateurs (CFTC, hebdomadaire)</strong>
            <dl className="stats">
              <div>
                <dt>Position nette</dt>
                <dd>{pct(cot.netPct)} des positions ouvertes</dd>
              </div>
              <div>
                <dt>Rang sur {Math.round(cot.weeks / 52)} an{cot.weeks >= 104 ? "s" : ""}</dt>
                <dd>{cot.percentile} / 100</dd>
              </div>
              {cot.weekChange !== null && (
                <div>
                  <dt>Depuis la semaine passée</dt>
                  <dd className={cot.weekChange >= 0 ? "pos" : "neg"}>{pct(cot.weekChange)} </dd>
                </div>
              )}
            </dl>
            <p className="small sent-read">
              Ils sont <strong>{cotMood(cot.percentile)}</strong>. {c && SAME[c]}
            </p>
            <p className="muted small">
              {cot.label} · positions au {new Date(cot.reportDate).toLocaleDateString("fr-FR")}, publiées le vendredi suivant.
            </p>
          </div>
        ) : (
          <p className="muted small">Grands spéculateurs (CFTC) : source non disponible pour l’instant.</p>
        ))}
      <Disclaimer>
        Informations de contexte, pas des signaux. Le funding est ce que les acheteurs paient aux vendeurs (ou l’inverse) pour garder leurs positions sur le
        contrat perpétuel du Bitcoin : très positif, les acheteurs sont nombreux. Le rapport CFTC donne chaque semaine la position des grands acteurs sur les
        contrats à terme (c’est du retard : positions du mardi, publiées le vendredi, donc utile pour le tableau d’ensemble, pas pour la minute). Rien ne dit
        qu’aller avec ou contre ces foules rapporte : le journal des prévisions enregistre ces valeurs avec chaque prévision et mesure si la prévision
        réussit mieux dans un cas ou dans l’autre. Les sources sont facultatives : si l’une ne répond pas, le reste fonctionne.
      </Disclaimer>
    </section>
  );
}
