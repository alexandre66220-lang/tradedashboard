"use client";

import { useEffect, useState } from "react";
import type { Orders } from "@/lib/useOrders";
import type { DealResult, Recap } from "@/lib/useOrders";
import Disclaimer from "./Disclaimer";

export interface OrderDraft {
  nonce: number;
  epic: string;
  side: "long" | "short";
  size: number;
  stop: number;
  target: number | null;
}

interface Props {
  orders: Orders;
  epic: string;
  decimals: number;
  last: number | null;
  draft: OrderDraft | null;
  /** Sends a filled order to the trade log form */
  onLog?: (d: { side: "long" | "short"; entry: number; size: number; stop: number; target?: number }) => void;
}

const num = (s: string) => Number(s.replace(",", "."));
const money = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const time = (ms: number) => new Date(ms).toLocaleTimeString("fr-FR");

export default function OrderPanel({ orders, epic, decimals, last, draft, onLog }: Props) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [size, setSize] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [recap, setRecap] = useState<Recap | null>(null);
  const [result, setResult] = useState<(DealResult & { sentSide: "long" | "short"; sentSize: number; sentStop: number; sentTarget: number | null }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [armed, setArmed] = useState<string | null>(null);
  const [closeMsg, setCloseMsg] = useState<string | null>(null);

  // Levels belong to one instrument: start again when another one is shown
  useEffect(() => {
    setStop("");
    setTarget("");
    setRecap(null);
    setResult(null);
    setError(null);
  }, [epic]);

  useEffect(() => {
    if (!draft || draft.epic !== epic) return;
    setSide(draft.side);
    setSize(String(draft.size));
    setStop(String(draft.stop));
    setTarget(draft.target === null ? "" : String(draft.target));
    setRecap(null);
    setResult(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.nonce]);

  // Countdown of the confirmation window
  useEffect(() => {
    if (!recap) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recap]);

  // A second tap is required to close a position: the first one arms the button for a few seconds
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(null), 5000);
    return () => clearTimeout(id);
  }, [armed]);

  const state = orders.state;
  const head = (
    <div className="panel-head">
      <span>Ordre sur compte démo</span>
      <span className="badge demo">DÉMO</span>
    </div>
  );

  if (!state) {
    return (
      <section className="panel" id="order-panel">
        {head}
        <p className="muted small">{orders.error ?? "Chargement…"}</p>
      </section>
    );
  }
  if (!state.enabled) {
    return (
      <section className="panel" id="order-panel">
        {head}
        <p className="muted small">
          {state.reason === "live"
            ? "Ordres refusés : le serveur est réglé sur le compte réel. Seul le compte démo est autorisé."
            : "Les ordres sont désactivés. Pour les activer sur le compte démo, ajoutez la variable TRADING_ENABLED = true dans Netlify (Project configuration → Environment variables), puis redéployez."}
        </p>
        <Disclaimer>
          Les ordres ne partent que vers le compte démo de Capital.com, jamais vers le compte réel. Tant que cette variable n’est pas définie, aucun ordre ne peut
          être envoyé, même par erreur.
        </Disclaimer>
      </section>
    );
  }

  const expired = recap !== null && now >= recap.expiresAt;
  const positions = state.positions ?? [];

  async function verify() {
    setBusy(true);
    setError(null);
    setResult(null);
    const s = num(size), st = num(stop), tg = target.trim() === "" ? undefined : num(target);
    const r = await orders.preview({ epic, side, size: s, stop: st, ...(tg !== undefined ? { target: tg } : {}) });
    setBusy(false);
    if (!r.ok) {
      setRecap(null);
      return setError(r.error);
    }
    setNow(Date.now());
    setRecap(r.body);
  }

  async function send() {
    if (!recap) return;
    setBusy(true);
    setError(null);
    const sent = { sentSide: recap.order.side, sentSize: recap.order.size, sentStop: recap.order.stop, sentTarget: recap.order.target };
    const r = await orders.send(recap.token);
    setBusy(false);
    setRecap(null);
    if (!r.ok) return setError(r.error);
    setResult({ ...r.body, ...sent });
  }

  async function closeDeal(dealId: string) {
    if (armed !== dealId) return setArmed(dealId);
    setArmed(null);
    setBusy(true);
    setCloseMsg(null);
    const r = await orders.close(dealId);
    setBusy(false);
    setCloseMsg(!r.ok ? r.error : r.body.status === "accepted" ? "Position fermée." : r.body.status === "rejected" ? `Fermeture refusée (${r.body.reason}).` : "Demande envoyée : vérifiez la liste des positions.");
  }

  const fmt = (v: number) => v.toFixed(decimals);

  return (
    <section className="panel" id="order-panel">
      {head}
      <div className="seg rc-side" role="group" aria-label="Sens de l'ordre">
        <button className={side === "long" ? "on" : ""} onClick={() => { setSide("long"); setRecap(null); }}>
          Achat
        </button>
        <button className={side === "short" ? "on" : ""} onClick={() => { setSide("short"); setRecap(null); }}>
          Vente
        </button>
      </div>
      <div className="rc-grid">
        {([["Taille", size, setSize, "u."], ["Stop (niveau)", stop, setStop, ""], ["Objectif (niveau, facultatif)", target, setTarget, ""]] as const).map(([label, value, set, suffix]) => (
          <label className="rc-field" key={label}>
            <span>{label}</span>
            <span className="rc-input">
              <input
                inputMode="decimal"
                value={value}
                onChange={(e) => {
                  set(e.target.value);
                  setRecap(null);
                }}
              />
              {suffix && <em>{suffix}</em>}
            </span>
          </label>
        ))}
        <div className="rc-field">
          <span>Prix actuel</span>
          <span className="order-last">{last !== null ? fmt(last) : "…"}</span>
        </div>
      </div>

      {!recap && (
        <button className="sl-apply" disabled={busy} onClick={verify}>
          {busy ? "Vérification…" : "Vérifier l’ordre"}
        </button>
      )}
      {error && <p className="rc-warn">{error}</p>}

      {recap && (
        <div className="order-recap">
          <p className="small">
            <strong>{recap.order.side === "long" ? "Achat" : "Vente"}</strong> de {recap.order.size} u. · compte <strong>démo</strong>
          </p>
          <dl className="stats rc-out">
            <div><dt>Prix estimé</dt><dd>{fmt(recap.plan.entry)}</dd></div>
            <div><dt>Valeur</dt><dd>{money(recap.plan.notional)} $</dd></div>
            <div><dt>Stop</dt><dd className="neg">{fmt(recap.order.stop)}</dd></div>
            <div><dt>Perte max.</dt><dd>{money(recap.plan.risk)} $</dd></div>
            <div><dt>Objectif</dt><dd className="pos">{recap.order.target !== null ? fmt(recap.order.target) : "—"}</dd></div>
            <div><dt>Gain visé</dt><dd>{recap.plan.reward !== null ? `${money(recap.plan.reward)} $` : "—"}</dd></div>
          </dl>
          {recap.plan.warnings.map((w) => (
            <p key={w} className="rc-warn">{w}</p>
          ))}
          <p className="muted small">{expired ? "Vérification expirée : refaites-la." : `À confirmer avant ${time(recap.expiresAt)}.`}</p>
          <button className="sl-apply order-send" disabled={busy || expired} onClick={send}>
            {busy ? "Envoi…" : "Envoyer sur le compte démo"}
          </button>
          <button className="ghost order-cancel" disabled={busy} onClick={() => setRecap(null)}>
            Modifier
          </button>
        </div>
      )}

      {result && (
        <div className="order-result">
          {result.status === "accepted" && (
            <>
              <p className="pos">Ordre accepté{result.level !== null ? ` · exécuté à ${fmt(result.level)}` : ""}.</p>
              {onLog && result.level !== null && (
                <button
                  className="ghost"
                  onClick={() => onLog({ side: result.sentSide, entry: result.level as number, size: result.sentSize, stop: result.sentStop, ...(result.sentTarget !== null ? { target: result.sentTarget } : {}) })}
                >
                  Noter dans mon journal
                </button>
              )}
            </>
          )}
          {result.status === "rejected" && <p className="rc-warn">Refusé par Capital.com : {result.reason}.</p>}
          {result.status === "unknown" && <p className="rc-warn">{result.reason}</p>}
        </div>
      )}

      <div className="panel-head order-pos-head">
        <span>
          Positions ouvertes ({positions.length}/{state.limits.maxOpenPositions})
        </span>
        <button className="ghost mini" onClick={() => orders.reload()}>
          Actualiser
        </button>
      </div>
      {state.positionsError && <p className="rc-warn">{state.positionsError}</p>}
      {closeMsg && <p className="muted small">{closeMsg}</p>}
      {positions.length === 0 && !state.positionsError && <p className="muted small">Aucune position ouverte.</p>}
      <ul className="order-list">
        {positions.map((p) => (
          <li key={p.dealId}>
            <div>
              <strong>{p.name}</strong> · {p.direction === "BUY" ? "achat" : "vente"} {p.size} u. à {p.level}
              <div className="muted small">
                {p.stopLevel !== null ? `stop ${p.stopLevel}` : "sans stop"}
                {p.profitLevel !== null ? ` · objectif ${p.profitLevel}` : ""}
                {p.upl !== null && (
                  <>
                    {" · "}
                    <span className={p.upl >= 0 ? "pos" : "neg"}>
                      {p.upl >= 0 ? "+" : ""}
                      {money(p.upl)} {p.currency ?? ""}
                    </span>
                  </>
                )}
              </div>
            </div>
            <button className={armed === p.dealId ? "order-close armed" : "ghost order-close"} disabled={busy} onClick={() => closeDeal(p.dealId)}>
              {armed === p.dealId ? "Confirmer" : "Fermer"}
            </button>
          </li>
        ))}
      </ul>
      <Disclaimer>
        Les ordres ne partent que vers le compte démo de Capital.com (de l’argent fictif), jamais vers le compte réel, et seulement après votre confirmation : le
        serveur vérifie d’abord l’ordre (stop obligatoire du bon côté, taille et nombre de positions limités, pas de doublon, prix actuel) puis vous montre le
        récapitulatif. Le prix d’exécution peut différer un peu du prix estimé. Pour couper les ordres : retirez TRADING_ENABLED dans Netlify et redéployez. Ce n’est
        pas un conseil d’investissement.
      </Disclaimer>
    </section>
  );
}
