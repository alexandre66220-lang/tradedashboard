"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HealthReport, HealthStatus } from "@/lib/health";
import { readJson, unexpectedResponse } from "@/lib/readJson";
import type { ApiError } from "@/lib/types";
import Disclaimer from "./Disclaimer";

const DOT: Record<HealthStatus, string> = { ok: "ok", warn: "warn", error: "bad", off: "off" };
const WORD: Record<HealthStatus, string> = { ok: "OK", warn: "À surveiller", error: "Problème", off: "Inactif" };

/** Download of a backup, and restoration from a downloaded file. */
function BackupTools() {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function restore(file: File | undefined) {
    if (!file) return;
    if (!window.confirm("Remplacer le journal, les trades et les alertes actuels par le contenu de ce fichier ? L'état actuel est d'abord conservé dans le stockage.")) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
      const body = await readJson<{ files?: number } & Partial<ApiError>>(res);
      if (!res.ok || !body) throw new Error(body?.error?.message ?? unexpectedResponse(res).message);
      setMessage(`Sauvegarde restaurée (${body.files ?? 0} fichiers). Rechargez la page.`);
    } catch (e) {
      setMessage(`Restauration impossible : ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="backup">
      <summary>Sauvegarde</summary>
      <p className="muted small">Une copie du journal, des trades et des alertes est faite chaque nuit (14 jours gardés). Vous pouvez aussi en télécharger une.</p>
      <a className="ghost linkbtn" href="/api/backup" download>
        Télécharger une sauvegarde
      </a>
      <label className="ghost linkbtn">
        {busy ? "Restauration…" : "Restaurer depuis un fichier"}
        <input type="file" accept="application/json,.json" hidden disabled={busy} onChange={(e) => void restore(e.target.files?.[0])} />
      </label>
      {message && <p className="muted small">{message}</p>}
    </details>
  );
}

/** Is everything the site depends on working? Loaded once when the page opens, and on request. */
export default function HealthPanel() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ctrl = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    ctrl.current?.abort();
    const c = (ctrl.current = new AbortController());
    setLoading(true);
    try {
      const res = await fetch("/api/health", { signal: c.signal, cache: "no-store" });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const body = await readJson<HealthReport | ApiError>(res);
      if (!body) throw unexpectedResponse(res);
      if (!res.ok || "error" in body) throw new Error("error" in body ? body.error.message : `Erreur ${res.status}`);
      setReport(body);
      setError(null);
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message || "Serveur injoignable.");
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => ctrl.current?.abort();
  }, [load]);

  return (
    <section className="panel health">
      <div className="panel-head">
        <span>Santé du système</span>
        {report && <span className={`hdot ${DOT[report.overall]}`} title={WORD[report.overall]} aria-label={WORD[report.overall]} />}
      </div>
      {error && <p className="muted small">Vérification impossible : {error}</p>}
      {!report && !error && <p className="muted small">Vérification…</p>}
      {report && (
        <ul className="hlist">
          {report.checks.map((c) => (
            <li key={c.id}>
              <span className={`hdot ${DOT[c.status]}`} aria-hidden="true" />
              <div>
                <strong>{c.label}</strong> <span className="muted small">· {WORD[c.status]}</span>
                <p className="muted small">{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="ghost" onClick={load} disabled={loading}>
        {loading ? "Vérification…" : "Revérifier"}
      </button>
      <BackupTools />
      {report && <p className="muted small">Vérifié à {new Date(report.generatedAt).toLocaleTimeString("fr-FR")}.</p>}
      <Disclaimer>
        Chaque ligne teste une dépendance du site : le prix (Capital.com), le service de prévision, le stockage, le journal (dernier relevé), le
        calendrier et les réglages. Aucune valeur secrète n'est affichée : seulement si elle est définie.
      </Disclaimer>
    </section>
  );
}
