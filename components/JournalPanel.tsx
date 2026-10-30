"use client";

import { useEffect, useState } from "react";
import type { JournalOverview } from "@/lib/journal/service";
import { INSTRUMENTS } from "@/config/instruments";
import { MODEL_FAMILIES, SESSIONS, type CrowdFadeGroup, type CrowdFadeStats, type JournalHit, type JournalStats, type ModelFamily, type ResultCurve } from "@/lib/journal/types";
import { verdict } from "@/lib/verdict";
import ResultChart from "./ResultChart";
import type { ApiError } from "@/lib/types";
import Disclaimer from "./Disclaimer";
import { readJson, RETRY_AFTER_FAILURE_MS, unexpectedResponse } from "@/lib/readJson";

const POLL_MS = 5 * 60_000;
const MODEL_LABEL: Record<ModelFamily, string> = { ml2: "Modèle ML v2", ml: "Modèle ML v1", builtin: "Modèle intégré" };
const MODEL_SHORT: Record<ModelFamily, string> = { ml2: "ML v2", ml: "ML v1", builtin: "intégré" };

const fmtHit = (h: JournalHit) =>
  h.hitRate == null ? `${h.hits}/${h.samples}` : `${Math.round(h.hitRate * 100)} % ± ${Math.round((h.margin ?? 0) * 100)}`;
const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`;
const sign = (v: number) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

function verdictOf(st: JournalStats) {
  return verdict({ hitRate: st.model.hitRate, samples: st.model.samples, margin: st.model.margin, baselines: {
    alwaysUp: { hitRate: st.baselines.alwaysUp.hitRate, samples: st.baselines.alwaysUp.samples, margin: st.baselines.alwaysUp.margin },
    lastMove: { hitRate: st.baselines.lastMove.hitRate, samples: st.baselines.lastMove.samples, margin: st.baselines.lastMove.margin },
  } });
}

function ModelBlock({ family, st }: { family: ModelFamily; st: JournalStats }) {
  const v = verdictOf(st);
  return (
    <div className="jm">
      <div className="jm-head">
        <strong>{MODEL_LABEL[family]}</strong>
        <span className={`verdict ${v.level}`}>{v.label}</span>
      </div>
      <dl className="stats">
        <div>
          <dt>Prévisions jugées</dt>
          <dd>
            {st.evaluated}
            <span className="muted small"> ({st.pending} en attente)</span>
          </dd>
        </div>
        <div>
          <dt>Réussite</dt>
          <dd>{fmtHit(st.model)}</dd>
        </div>
        <div>
          <dt>Gain simulé net</dt>
          <dd className={sign(st.netReturnPct)}>{st.evaluated ? fmtPct(st.netReturnPct) : "—"}</dd>
        </div>
      </dl>
      <p className="muted small">
        Pour comparaison : « toujours hausse » {fmtHit(st.baselines.alwaysUp)} · « suit la dernière bougie » {fmtHit(st.baselines.lastMove)}. Avant
        spread : {st.evaluated ? fmtPct(st.grossReturnPct) : "—"}.
      </p>
      {st.bySentiment.with.samples + st.bySentiment.against.samples + st.bySentiment.neutral.samples > 0 && (
        <p className="muted small">
          Selon le sentiment des clients : prévision dans le sens de la foule {fmtHit(st.bySentiment.with)} · à contre-courant{" "}
          {fmtHit(st.bySentiment.against)} · foule partagée {fmtHit(st.bySentiment.neutral)}.
        </p>
      )}
      {st.byValue.inside.samples + st.byValue.toward.samples + st.byValue.away.samples > 0 && (
        <p className="muted small">
          Selon la position du prix par rapport à la zone de valeur du jour (théorie des enchères) : dans la zone {fmtHit(st.byValue.inside)} · prévision de
          retour vers la zone {fmtHit(st.byValue.toward)} · prévision qui s’en éloigne {fmtHit(st.byValue.away)}.
        </p>
      )}
      {st.byFunding.with.samples + st.byFunding.against.samples + st.byFunding.neutral.samples > 0 && (
        <p className="muted small">
          Selon le positionnement des dérivés Bitcoin (funding) : prévision dans le sens de la foule {fmtHit(st.byFunding.with)} · à contre-courant{" "}
          {fmtHit(st.byFunding.against)} · foule équilibrée {fmtHit(st.byFunding.neutral)}.
        </p>
      )}
      {st.byCot.with.samples + st.byCot.against.samples + st.byCot.neutral.samples > 0 && (
        <p className="muted small">
          Selon les grands spéculateurs (CFTC, quand ils sont à un extrême de leur fourchette) : dans leur sens {fmtHit(st.byCot.with)} · à contre-courant{" "}
          {fmtHit(st.byCot.against)} · pas d’extrême {fmtHit(st.byCot.neutral)}.
        </p>
      )}
      {SESSIONS.some((x) => st.bySession[x.key].hit.samples > 0) && (
        <p className="muted small">
          Selon la séance en cours (heures d’ouverture réelles de Tokyo, Londres et New York, heure d’été comprise) :{" "}
          {SESSIONS.filter((x) => st.bySession[x.key].hit.samples > 0)
            .map((x) => {
              const g = st.bySession[x.key];
              return `${x.label} : ${fmtHit(g.hit)}${g.hit.hitRate != null ? ` (${fmtPct(g.netReturnPct)} net)` : ""}`;
            })
            .join(" · ")}
          .
        </p>
      )}
      {st.strategy.trades > 0 && (
        <p className="muted small">
          Trade simulé (stop 1,5 ATR, objectif 2 fois le stop, sinon sortie au terme ; après spread réel et frais de nuit supposés) :{" "}
          {st.strategy.meanNetR === null ? (
            <>{st.strategy.trades} trades (moins de 20 : pas de moyenne)</>
          ) : (
            <>
              <strong className={sign(st.strategy.meanNetR)}>
                {st.strategy.meanNetR > 0 ? "+" : ""}
                {st.strategy.meanNetR.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} R
              </strong>{" "}
              par trade ± {(1.96 * (st.strategy.se ?? 0)).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} sur {st.strategy.trades} trades
            </>
          )}
          {" "}· objectif atteint {Math.round((st.strategy.target / st.strategy.trades) * 100)} % · stop {Math.round((st.strategy.stop / st.strategy.trades) * 100)} % · sortie au terme{" "}
          {Math.round((st.strategy.time / st.strategy.trades) * 100)} %.
        </p>
      )}
      {st.calibration.some((c) => c.hit.samples > 0) && (
        <p className="muted small">
          La confiance affichée est-elle juste ? Confiance → réussite observée :{" "}
          {st.calibration
            .filter((c) => c.hit.samples > 0)
            .map((c) => `${Math.round(c.from * 100)}–${Math.round(c.to * 100)} % → ${fmtHit(c.hit)}`)
            .join(" · ")}
          .
        </p>
      )}
      {st.byVol.calm.samples + st.byVol.normal.samples + st.byVol.wild.samples > 0 && (
        <p className="muted small">
          Selon l’état du marché : calme {fmtHit(st.byVol.calm)} · normal {fmtHit(st.byVol.normal)} · agité {fmtHit(st.byVol.wild)} · en tendance{" "}
          {fmtHit(st.byTrend.trend)} · sans tendance {fmtHit(st.byTrend.range)}.
        </p>
      )}
      {st.byConfluence.low.samples + st.byConfluence.mid.samples + st.byConfluence.high.samples > 0 && (
        <p className="muted small">
          Accord avec les indicateurs classiques (sur 5) : 0–1 accord {fmtHit(st.byConfluence.low)} · 2–3 accords {fmtHit(st.byConfluence.mid)} · 4–5 accords{" "}
          {fmtHit(st.byConfluence.high)}.
        </p>
      )}
      {st.byFib.near.samples + st.byFib.away.samples > 0 && (
        <p className="muted small">
          Prix sur un niveau de Fibonacci : oui {fmtHit(st.byFib.near)} · non {fmtHit(st.byFib.away)}.
        </p>
      )}
      {st.byNews.near.samples + st.byNews.calm.samples > 0 && (
        <p className="muted small">
          Autour des annonces importantes : fenêtre avec annonce {fmtHit(st.byNews.near)} · sans annonce {fmtHit(st.byNews.calm)}.
        </p>
      )}
    </div>
  );
}

function fadeVerdict(g: CrowdFadeGroup): { level: string; label: string } {
  const { hitRate, margin } = g.fade;
  if (hitRate == null || margin == null) return { level: "none", label: "Pas assez de données" };
  if (hitRate - margin > 0.5 && g.netReturnPct > 0) return { level: "edge", label: "Signal contrarien" };
  if (hitRate + margin < 0.5) return { level: "worse", label: "La foule a plutôt raison" };
  return { level: "none", label: "Pas distinguable du hasard" };
}

function CrowdBlock({ crowd }: { crowd: CrowdFadeStats }) {
  const rows: Array<[string, string, CrowdFadeGroup]> = [
    ["Foule très d’un côté", "≥ 70 % ou ≤ 30 % d’acheteurs", crowd.extreme],
    ["Foule plutôt d’un côté", "60–70 % ou 30–40 % d’acheteurs", crowd.moderate],
  ];
  return (
    <div className="jm">
      <div className="jm-head">
        <strong>Aller contre la foule ?</strong>
      </div>
      <p className="muted small explain">
        Test indépendant du modèle : à chaque fenêtre, on parie à l’inverse du côté où se trouve la majorité des clients Capital.com, puis on juge
        sur le vrai prix à l’échéance. {crowd.judged} fenêtres jugées avec un sentiment enregistré.
      </p>
      <div className="bt">
      <table>
        <thead>
          <tr>
            <th />
            <th>Jugées</th>
            <th>Réussite</th>
            <th>Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, hint, g]) => {
            const v = fadeVerdict(g);
            return (
              <tr key={name}>
                <th scope="row">
                  {name}
                  <span className="muted small"> · {hint}</span>
                  <br />
                  <span className={`verdict ${v.level}`}>{v.label}</span>
                </th>
                <td>{g.fade.samples}</td>
                <td>{fmtHit(g.fade)}</td>
                <td className={sign(g.netReturnPct)}>{g.fade.samples ? fmtPct(g.netReturnPct) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** Result curve of the judged forecasts, by model and by instrument. */
function ResultSection({ curves, families }: { curves: ResultCurve[]; families: ModelFamily[] }) {
  const [family, setFamily] = useState<ModelFamily | null>(null);
  const [epic, setEpic] = useState<string | null>(null);
  const model = family && families.includes(family) ? family : families[0];
  const available = curves.filter((c) => c.model === model);
  const curve = available.find((c) => c.epic === epic) ?? available.find((c) => c.epic === null);
  if (!model || !curve) return null;
  return (
    <div className="jm">
      <div className="jm-head">
        <strong>Courbe de résultat</strong>
      </div>
      {families.length > 1 && (
        <div className="overlays" role="group" aria-label="Modèle">
          {families.map((f) => (
            <button key={f} type="button" className={`chipbtn${f === model ? " on" : ""}`} aria-pressed={f === model} onClick={() => setFamily(f)}>
              {MODEL_SHORT[f]}
            </button>
          ))}
        </div>
      )}
      <div className="overlays" role="group" aria-label="Instrument">
        {available.map((c) => (
          <button key={c.epic ?? "all"} type="button" className={`chipbtn${c.epic === curve.epic ? " on" : ""}`} aria-pressed={c.epic === curve.epic} onClick={() => setEpic(c.epic)}>
            {c.epic === null ? "Tous" : (INSTRUMENTS.find((i) => i.epic === c.epic)?.name.split(" (")[0] ?? c.epic)}
          </button>
        ))}
      </div>
      <ResultChart curve={curve} />
      <p className="muted small explain">
        Une unité misée sur chaque prévision haussière ou baissière, spread et frais de nuit déduits. Les pointillés montrent jusqu’où le hasard seul
        pourrait porter le résultat (95 %) : tant que la courbe reste entre eux, le résultat n’est pas distinguable de la chance.
      </p>
    </div>
  );
}

export default function JournalPanel() {
  const [data, setData] = useState<JournalOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failed = false;
    const run = async () => {
      clearTimeout(timer);
      if (!document.hidden) {
        try {
          const res = await fetch("/api/journal", { signal: ctrl.signal, cache: "no-store" });
          if (res.status === 401) {
            window.location.href = "/login";
            return;
          }
          const body = await readJson<JournalOverview | ApiError>(res);
          if (!body) throw unexpectedResponse(res);
          if (!res.ok || "error" in body) throw new Error("error" in body ? body.error.message : `Erreur ${res.status}`);
          setData(body);
          setError(null);
          failed = false;
        } catch (e) {
          failed = true;
          if (!ctrl.signal.aborted) setError((e as Error).message || "Serveur injoignable.");
        }
      }
      if (!ctrl.signal.aborted) timer = setTimeout(run, failed ? RETRY_AFTER_FAILURE_MS : POLL_MS);
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

  const families = MODEL_FAMILIES.filter((f) => data?.models[f]);
  const since = families
    .map((f) => data!.models[f]!.firstRecordedAt)
    .filter((t): t is number => t != null)
    .reduce<number | null>((a, t) => (a === null ? t : Math.min(a, t)), null);

  return (
    <section className="panel journal">
      <div className="panel-head">
        <span>Journal des prévisions en direct</span>
        <span className="tag">test réel</span>
      </div>

      {!data && <p className="muted small">{error ?? "Chargement…"}</p>}
      {data && !data.configured && (
        <p className="muted small">Journal non configuré : aucun stockage Blob n’est relié à ce projet.</p>
      )}
      {data?.configured && families.length === 0 && (
        <p className="muted small">
          Aucune prévision enregistrée pour l’instant. Le journal note une prévision par fenêtre d’horizon (30 min, jour, semaine) dès que le
          graphique est ouvert ou lors du relevé quotidien, puis la compare au prix réel à l’échéance.
        </p>
      )}

      {data?.configured && families.length > 0 && (
        <>
          <p className="muted small explain">
            Chaque prévision est enregistrée à l’avance, puis jugée sur le vrai prix à l’échéance : aucun recul possible.
            {since ? ` Suivi depuis le ${new Date(since).toLocaleDateString("fr-FR")}.` : ""}
          </p>
          {families.map((f) => (
            <ModelBlock key={f} family={f} st={data.models[f]!} />
          ))}

          {data.curves && data.curves.length > 0 && <ResultSection curves={data.curves} families={families} />}

          {data.crowd && data.crowd.judged > 0 && <CrowdBlock crowd={data.crowd} />}

          <details className="bt">
            <summary>Détail par instrument et horizon</summary>
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Jugées</th>
                  <th>Réussite</th>
                  <th>Net</th>
                </tr>
              </thead>
              <tbody>
                {data.series.map((s) => (
                  <tr key={`${s.epic}|${s.resolution}|${s.horizon}|${s.model}`}>
                    <th scope="row">
                      {s.name} · {s.label}
                      {s.resolution.startsWith("MINUTE") ? ` · ${s.horizon} min` : ""}
                      {families.length > 1 ? ` · ${MODEL_SHORT[s.model]}` : ""}
                    </th>
                    <td>{s.stats.evaluated}</td>
                    <td>{fmtHit(s.stats.model)}</td>
                    <td className={sign(s.stats.netReturnPct)}>{s.stats.evaluated ? fmtPct(s.stats.netReturnPct) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}

      {error && data && <p className="muted small">Mise à jour impossible : {error}</p>}
      <Disclaimer>
        Gains simulés : une unité par prévision (haussière ou baissière, les « neutres » sont ignorées), après un spread supposé par instrument
        (réglable dans <code>config/instruments.ts</code>), sans frais de financement ni glissement. Tant qu’il y a moins de 20 prévisions
        jugées, aucun taux n’est affiché : trop peu pour conclure. Pour le test « contre la foule », les fenêtres voisines d’un même instrument se
        ressemblent (le sentiment change lentement) : la marge d’erreur affichée est donc plutôt optimiste. Ce n’est pas un conseil
        d’investissement.
      </Disclaimer>
    </section>
  );
}
