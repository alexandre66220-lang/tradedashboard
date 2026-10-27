"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError, ModelVariant } from "@/lib/types";

const fmtRate = (r: ModelVariant) =>
  r.hitRate == null ? "—" : `${Math.round(r.hitRate * 100)} %${r.margin != null ? ` ± ${Math.round(r.margin * 100)}` : ""}`;
const fmtBps = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} pt`);

/** Scores several versions of the ML model on the same history, on request (it takes a few seconds). */
export default function ModelCompare({ query }: { query: string }) {
  const [rows, setRows] = useState<ModelVariant[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // A new instrument / timeframe / horizon makes the previous comparison obsolete
  useEffect(() => {
    ctrl.current?.abort();
    setRows(null);
    setState("idle");
    return () => ctrl.current?.abort();
  }, [query]);

  async function run() {
    ctrl.current?.abort();
    const c = (ctrl.current = new AbortController());
    setState("loading");
    setError(null);
    try {
      const res = await fetch(`/api/forecast/compare?${query}`, { signal: c.signal, cache: "no-store" });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const body = (await res.json().catch(() => null)) as { variants: ModelVariant[] } | ApiError | null;
      if (!res.ok || !body || "error" in body) throw new Error(body && "error" in body ? body.error.message : `Erreur ${res.status}`);
      setRows(body.variants);
      setState("idle");
    } catch (e) {
      if (c.signal.aborted) return;
      setError((e as Error).message || "Serveur injoignable.");
      setState("error");
    }
  }

  return (
    <div className="cmp">
      <button type="button" className="ghost" onClick={run} disabled={state === "loading"}>
        {state === "loading" ? "Comparaison en cours…" : rows ? "Relancer la comparaison" : "Comparer les versions du modèle"}
      </button>
      {state === "error" && <p className="muted small">{error}</p>}
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
              {rows.map((r) => (
                <tr key={r.name} className={r.live ? "cur" : ""}>
                  <th scope="row">
                    {r.name}
                    {r.live ? " ← utilisé" : ""}
                  </th>
                  <td>{fmtRate(r)}</td>
                  <td className={r.avgNetBps == null ? "muted" : r.avgNetBps > 0 ? "pos" : "neg"}>{fmtBps(r.avgNetBps)}</td>
                  <td className="muted">{r.samples}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Même historique, même méthode pour chaque ligne (réentraînement régulier, sans données du futur). « Net / appel » : résultat moyen d’un
            pari après le spread, en points de base (1 pt = 0,01 % du prix). Attention : plus on compare de variantes, plus l’une d’elles paraît
            bonne par hasard. Une ligne n’est convaincante que si sa marge d’erreur exclut 50 % <em>et</em> que le net est positif ; sinon, ne
            changez rien. Un net moins négatif peut venir uniquement de moins de paris (donc moins de spread payé).
          </p>
        </>
      )}
    </div>
  );
}
