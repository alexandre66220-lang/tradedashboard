"use client";

import { useEffect, useState } from "react";
import type { JournalOverview } from "@/lib/journal/service";
import type { JournalHit, JournalStats } from "@/lib/journal/types";
import { verdict } from "@/lib/verdict";
import type { ApiError } from "@/lib/types";

const POLL_MS = 60_000;
const MODEL_LABEL = { ml: "Modèle ML", builtin: "Modèle intégré" } as const;

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

/** Cumulative simulated net return (%) after each resolved call. */
function Curve({ points }: { points: JournalStats["curve"] }) {
  if (points.length < 2) return null;
  const W = 600, H = 120, P = 6;
  const vs = points.map((p) => p.v);
  const lo = Math.min(0, ...vs), hi = Math.max(0, ...vs);
  const span = hi - lo || 1;
  const x = (i: number) => P + (i / (points.length - 1)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const last = vs[vs.length - 1];
  return (
    <svg className="curve" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Gains simulés cumulés">
      <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} className="zero" />
      <path d={d} className={last >= 0 ? "up" : "down"} fill="none" />
    </svg>
  );
}

function ModelBlock({ family, st }: { family: "ml" | "builtin"; st: JournalStats }) {
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
      <Curve points={st.curve} />
    </div>
  );
}

export default function JournalPanel() {
  const [data, setData] = useState<JournalOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      clearTimeout(timer);
      if (!document.hidden) {
        try {
          const res = await fetch("/api/journal", { signal: ctrl.signal, cache: "no-store" });
          if (res.status === 401) {
            window.location.href = "/login";
            return;
          }
          const body = (await res.json()) as JournalOverview | ApiError;
          if (!res.ok || "error" in body) throw new Error("error" in body ? body.error.message : `Erreur ${res.status}`);
          setData(body);
          setError(null);
        } catch (e) {
          if (!ctrl.signal.aborted) setError((e as Error).message || "Serveur injoignable.");
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

  const families = (["ml", "builtin"] as const).filter((f) => data?.models[f]);
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
          <p className="muted small">
            Chaque prévision est enregistrée à l’avance, puis jugée sur le vrai prix à l’échéance : aucun recul possible.
            {since ? ` Suivi depuis le ${new Date(since).toLocaleDateString("fr-FR")}.` : ""}
          </p>
          {families.map((f) => (
            <ModelBlock key={f} family={f} st={data.models[f]!} />
          ))}

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
                      {families.length > 1 ? ` · ${s.model === "ml" ? "ML" : "intégré"}` : ""}
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
      <p className="disclaimer">
        Gains simulés : une unité par prévision (haussière ou baissière, les « neutres » sont ignorées), après un spread supposé par instrument
        (réglable dans <code>config/instruments.ts</code>), sans frais de financement ni glissement. Tant qu’il y a moins de 20 prévisions
        jugées, aucun taux n’est affiché : trop peu pour conclure. Ce n’est pas un conseil d’investissement.
      </p>
    </section>
  );
}
