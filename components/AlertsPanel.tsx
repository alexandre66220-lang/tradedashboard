"use client";

import { useEffect, useState } from "react";
import type { Instrument } from "@/config/instruments";
import type { AlertOp, PriceAlert } from "@/lib/alerts";

interface Props {
  alerts: PriceAlert[];
  configured: boolean | null;
  notify: boolean;
  error: string | null;
  instruments: Instrument[];
  selectedEpic: string;
  last: number | null;
  onAdd: (a: { epic: string; op: AlertOp; price: number; note?: string }) => Promise<string | null>;
  onRemove: (id: string) => Promise<string | null>;
  onTest: () => Promise<string | null>;
}

const when = (ms: number) => new Date(ms).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function AlertsPanel(p: Props) {
  const [epic, setEpic] = useState(p.selectedEpic);
  const [op, setOp] = useState<AlertOp>("above");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [testMsg, setTestMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const nameOf = (e: string) => p.instruments.find((i) => i.epic === e)?.name ?? e;
  const active = p.alerts.filter((a) => a.firedAt === undefined);
  const fired = p.alerts.filter((a) => a.firedAt !== undefined).sort((a, b) => b.firedAt! - a.firedAt!).slice(0, 5);
  // Known only in the browser: set after mount so the server and first client render match
  const [origin, setOrigin] = useState("https://votre-site.vercel.app");
  useEffect(() => setOrigin(window.location.origin), []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const err = await p.onAdd({ epic, op, price: Number(price.replace(",", ".")), ...(note.trim() ? { note: note.trim() } : {}) });
    setBusy(false);
    setMsg(err ? { text: err, ok: false } : { text: "Alerte créée.", ok: true });
    if (!err) {
      setPrice("");
      setNote("");
    }
  }

  return (
    <section className="panel journal">
      <div className="panel-head">
        <span>Alertes sur téléphone</span>
        <span className="tag">{p.notify ? "actives" : "à configurer"}</span>
      </div>

      {p.configured === false && <p className="muted small">Alertes non configurées : aucun stockage Blob n’est relié à ce projet.</p>}
      {p.error && <p className="rc-warn">{p.error}</p>}

      <p className="muted small">
        Vous êtes prévenu automatiquement : <strong>35 minutes avant une annonce majeure</strong>, quand <strong>le stop ou l’objectif d’un de vos trades
        ouverts est touché</strong> (notés dans « Mes trades »), et quand un <strong>prix que vous fixez ci-dessous</strong> est atteint.
      </p>

      {p.configured && (
        <>
          <form className="trade-form" onSubmit={add}>
            <div className="rc-grid one">
              <label className="rc-field">
                <span>Instrument</span>
                <span className="rc-input">
                  <select value={epic} onChange={(e) => setEpic(e.target.value)}>
                    {p.instruments.map((i) => (
                      <option key={i.epic} value={i.epic}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              <div className="rc-field">
                <span>Me prévenir quand le prix passe…</span>
                <div className="seg" role="group" aria-label="Condition">
                  <button type="button" className={op === "above" ? "on" : ""} onClick={() => setOp("above")}>
                    au-dessus
                  </button>
                  <button type="button" className={op === "below" ? "on" : ""} onClick={() => setOp("below")}>
                    en dessous
                  </button>
                </div>
              </div>
              <label className="rc-field">
                <span>Prix</span>
                <span className="rc-input">
                  <input inputMode="decimal" required value={price} placeholder={epic === p.selectedEpic && p.last ? String(p.last) : ""} onChange={(e) => setPrice(e.target.value)} />
                </span>
              </label>
              <label className="rc-field">
                <span>Note (facultatif)</span>
                <span className="rc-input">
                  <input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
                </span>
              </label>
            </div>
            {msg && <p className={msg.ok ? "muted small" : "rc-warn"}>{msg.text}</p>}
            <button className="sl-apply" type="submit" disabled={busy}>
              Créer l’alerte
            </button>
          </form>

          {active.length > 0 && (
            <>
              <h3 className="sub">Alertes actives</h3>
              <ul className="tlist">
                {active.map((a) => (
                  <li key={a.id}>
                    <div className="trow">
                      <span>
                        {nameOf(a.epic)} {a.op === "above" ? "≥" : "≤"} {a.price}
                      </span>
                      <button type="button" className="ghost mini" onClick={() => p.onRemove(a.id)}>
                        supprimer
                      </button>
                    </div>
                    {a.note && <div className="muted small">{a.note}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {fired.length > 0 && (
            <details className="bt">
              <summary>Dernières alertes déclenchées</summary>
              <ul className="tlist">
                {fired.map((a) => (
                  <li key={a.id} className="muted small">
                    {nameOf(a.epic)} {a.op === "above" ? "≥" : "≤"} {a.price} · déclenchée le {when(a.firedAt!)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <details className="bt" open={!p.notify}>
        <summary>Mise en place sur le téléphone (5 minutes)</summary>
        <ol className="steps">
          <li>Installez l’application gratuite <strong>ntfy</strong> (App Store ou Google Play) et abonnez-vous à un sujet dont le nom est <strong>long et aléatoire</strong> (par exemple 30 caractères) : ce nom sert de mot de passe.</li>
          <li>Dans le projet Vercel du dashboard, ajoutez la variable <code>NTFY_TOPIC</code> avec <strong>exactement ce nom</strong> (et <code>CRON_SECRET</code> si ce n’est pas déjà fait), puis redéployez.</li>
          <li>
            Sur <strong>cron-job.org</strong> (gratuit), créez une tâche toutes les 5 minutes qui appelle <code>{origin}/api/alerts/check</code> avec l’en-tête{" "}
            <code>Authorization: Bearer</code> suivi de votre <code>CRON_SECRET</code>. Vercel gratuit ne sait lancer une tâche qu’une fois par jour, d’où ce service.
          </li>
          <li>Appuyez sur « Envoyer une notification de test » : elle doit arriver sur votre téléphone.</li>
        </ol>
        <button
          type="button"
          className="sl-apply"
          onClick={async () => {
            const err = await p.onTest();
            setTestMsg(err ? { text: err, ok: false } : { text: "Notification de test envoyée.", ok: true });
          }}
        >
          Envoyer une notification de test
        </button>
        {testMsg && <p className={testMsg.ok ? "muted small" : "rc-warn"}>{testMsg.text}</p>}
      </details>

      <p className="disclaimer">
        Les alertes arrivent avec quelques minutes de décalage au plus (selon la fréquence de la tâche planifiée) : ne remplacez pas un vrai stop chez
        votre courtier par une alerte. Ce n’est pas un conseil d’investissement.
      </p>
    </section>
  );
}
