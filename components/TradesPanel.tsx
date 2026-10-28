"use client";

import { useEffect, useState } from "react";
import type { Instrument } from "@/config/instruments";
import type { NewTradeInput } from "@/lib/useTrades";
import { isClosed, tradePnl, tradeR, tradeStats, type Trade, type TradePatch, type TradeSide } from "@/lib/trades";
import Curve from "./Curve";
import Disclaimer from "./Disclaimer";

export interface TradeDraft {
  epic: string;
  side: TradeSide;
  entry: number;
  size: number;
  stop?: number;
  target?: number;
  nonce: number;
}

interface Props {
  trades: Trade[];
  configured: boolean | null;
  error: string | null;
  instruments: Instrument[];
  selectedEpic: string;
  /** Latest price of the selected instrument */
  last: number | null;
  decimals: number;
  /** Forecast shown on screen for the selected instrument, saved with the trade */
  model: NewTradeInput["model"];
  draft: TradeDraft | null;
  dailyLimit: number | null;
  onDailyLimit: (v: number | null) => void;
  onAdd: (t: NewTradeInput) => Promise<string | null>;
  onPatch: (id: string, p: TradePatch) => Promise<string | null>;
  onRemove: (id: string) => Promise<string | null>;
}

const num = (s: string) => Number(s.replace(",", "."));
const money = (v: number) => `${v > 0 ? "+" : ""}${v.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} $`;
const sign = (v: number) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
const when = (ms: number) => new Date(ms).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function TradesPanel(p: Props) {
  const [open, setOpen] = useState(false);
  const [epic, setEpic] = useState(p.selectedEpic);
  const [side, setSide] = useState<TradeSide>("long");
  const [entry, setEntry] = useState("");
  const [size, setSize] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exits, setExits] = useState<Record<string, string>>({});
  const [limitText, setLimitText] = useState("");

  useEffect(() => {
    setLimitText(p.dailyLimit ? String(p.dailyLimit) : "");
  }, [p.dailyLimit]);

  // Prefill from the risk calculator
  useEffect(() => {
    const d = p.draft;
    if (!d) return;
    setOpen(true);
    setEpic(d.epic);
    setSide(d.side);
    setEntry(String(d.entry));
    setSize(String(d.size));
    setStop(d.stop !== undefined ? String(d.stop) : "");
    setTarget(d.target !== undefined ? String(d.target) : "");
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.draft?.nonce]);

  const dayStart = new Date().setHours(0, 0, 0, 0);
  const stats = tradeStats(p.trades, dayStart);
  const nameOf = (e: string) => p.instruments.find((i) => i.epic === e)?.name ?? e;
  const openTrades = p.trades.filter((t) => !isClosed(t)).sort((a, b) => b.openedAt - a.openedAt);
  const closedTrades = p.trades.filter(isClosed).sort((a, b) => b.closedAt - a.closedAt);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    const body: NewTradeInput = {
      epic,
      side,
      entry: num(entry),
      size: num(size),
      ...(stop ? { stop: num(stop) } : {}),
      ...(target ? { target: num(target) } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      model: epic === p.selectedEpic ? p.model : null,
    };
    const err = await p.onAdd(body);
    setBusy(false);
    if (err) return setFormError(err);
    setOpen(false);
    setStop("");
    setTarget("");
    setNote("");
  }

  const hit = stats.winRate === null ? `${stats.wins}/${stats.closed}` : `${Math.round(stats.winRate * 100)} % ± ${Math.round((stats.margin ?? 0) * 100)}`;
  const fmtPrice = (v: number) => v.toFixed(p.decimals);

  return (
    <section className="panel journal" id="trades">
      <div className="panel-head">
        <span>Mes trades</span>
        <span className="tag">réel</span>
      </div>

      {p.configured === false && <p className="muted small">Journal de trades non configuré : aucun stockage Blob n’est relié à ce projet.</p>}
      {p.error && <p className="rc-warn">{p.error}</p>}

      {p.configured && (
        <>
          <dl className="stats trade-stats">
            <div>
              <dt>Clôturés</dt>
              <dd>
                {stats.closed}
                <span className="muted small"> ({stats.open} ouverts)</span>
              </dd>
            </div>
            <div>
              <dt>Résultat total</dt>
              <dd className={sign(stats.totalPnl)}>{stats.closed ? money(stats.totalPnl) : "—"}</dd>
            </div>
            <div>
              <dt>Réussite</dt>
              <dd>{stats.closed ? hit : "—"}</dd>
            </div>
            <div>
              <dt>Espérance</dt>
              <dd className={sign(stats.expectancyR ?? 0)}>{stats.expectancyR === null ? "—" : `${stats.expectancyR > 0 ? "+" : ""}${stats.expectancyR.toFixed(2)} R`}</dd>
            </div>
            <div>
              <dt>Pire creux</dt>
              <dd>{stats.closed ? `${stats.maxDrawdown > 0 ? "-" : ""}${stats.maxDrawdown.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} $` : "—"}</dd>
            </div>
            <div>
              <dt>Aujourd’hui</dt>
              <dd className={sign(stats.todayPnl)}>{money(stats.todayPnl)}</dd>
            </div>
          </dl>

          <label className="rc-field limit">
            <span>Perte maximale du jour (arrête le feu au rouge)</span>
            <span className="rc-input">
              <input
                inputMode="decimal"
                placeholder="désactivée"
                value={limitText}
                onChange={(e) => {
                  setLimitText(e.target.value);
                  const v = num(e.target.value);
                  p.onDailyLimit(e.target.value && Number.isFinite(v) && v > 0 ? v : null);
                }}
              />
              <em>$</em>
            </span>
          </label>

          {stats.closed >= 5 && (
            <p className="muted small">
              Discipline : {stats.withStop}/{stats.closed} trades avec un stop
              {stats.noStop > 0 ? ` (${stats.noStop} sans stop : le risque n’était pas borné)` : ""}.
              {stats.withModel.trades + stats.againstModel.trades > 0 &&
                ` Dans le sens du modèle : ${stats.withModel.wins}/${stats.withModel.trades} gagnants (${money(stats.withModel.pnl)}) ; à contre-sens : ${stats.againstModel.wins}/${stats.againstModel.trades} (${money(stats.againstModel.pnl)}).`}
            </p>
          )}
          <Curve points={stats.curve} label="Résultat cumulé de vos trades" />

          <details className="bt" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
            <summary>Noter un trade</summary>
            <form className="trade-form" onSubmit={submit}>
              <div className="rc-grid">
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
                  <span>Sens</span>
                  <div className="seg" role="group" aria-label="Sens">
                    <button type="button" className={side === "long" ? "on" : ""} onClick={() => setSide("long")}>
                      Achat
                    </button>
                    <button type="button" className={side === "short" ? "on" : ""} onClick={() => setSide("short")}>
                      Vente
                    </button>
                  </div>
                </div>
                {([["Prix d’entrée", entry, setEntry, "entry"], ["Taille (unités)", size, setSize, "size"], ["Stop", stop, setStop, "stop"], ["Objectif", target, setTarget, "target"]] as const).map(
                  ([label, value, set, key]) => (
                    <label className="rc-field" key={key}>
                      <span>{label}</span>
                      <span className="rc-input">
                        <input
                          inputMode="decimal"
                          value={value}
                          required={key === "entry" || key === "size"}
                          placeholder={key === "stop" || key === "target" ? "facultatif" : key === "entry" && p.last ? fmtPrice(p.last) : ""}
                          onChange={(e) => set(e.target.value)}
                        />
                      </span>
                    </label>
                  ),
                )}
              </div>
              <label className="rc-field rc-manual">
                <span>Note (pourquoi ce trade ?)</span>
                <span className="rc-input">
                  <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
                </span>
              </label>
              {formError && <p className="rc-warn">{formError}</p>}
              <button className="sl-apply" type="submit" disabled={busy}>
                {busy ? "Enregistrement…" : "Enregistrer le trade"}
              </button>
              <p className="muted small explain">
                La prévision affichée à ce moment-là est conservée avec le trade, pour comparer plus tard vos décisions et celles du modèle.
              </p>
            </form>
          </details>

          {openTrades.length > 0 && (
            <>
              <h3 className="sub">Ouverts</h3>
              <ul className="tlist">
                {openTrades.map((t) => {
                  const live = p.last !== null && t.epic === p.selectedEpic ? (t.side === "long" ? 1 : -1) * (p.last - t.entry) * t.size : null;
                  return (
                    <li key={t.id}>
                      <div className="trow">
                        <strong>
                          {nameOf(t.epic)} · {t.side === "long" ? "achat" : "vente"} {t.size}
                        </strong>
                        <span className={sign(live ?? 0)}>{live === null ? "—" : money(live)}</span>
                      </div>
                      <div className="muted small">
                        Entrée {t.entry} · {t.stop ? `stop ${t.stop}` : "sans stop"}
                        {t.target ? ` · objectif ${t.target}` : ""} · {when(t.openedAt)}
                      </div>
                      <div className="tclose">
                        <input
                          inputMode="decimal"
                          aria-label="Prix de sortie"
                          placeholder={t.epic === p.selectedEpic && p.last ? `sortie ${fmtPrice(p.last)}` : "prix de sortie"}
                          value={exits[t.id] ?? ""}
                          onChange={(e) => setExits({ ...exits, [t.id]: e.target.value })}
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            const typed = exits[t.id] ? num(exits[t.id]) : t.epic === p.selectedEpic ? p.last : null;
                            if (typed === null || !Number.isFinite(typed) || typed <= 0) return setFormError("Indiquez le prix de sortie.");
                            const err = await p.onPatch(t.id, { exit: typed });
                            setFormError(err);
                          }}
                        >
                          Clôturer
                        </button>
                        <button type="button" className="ghost" onClick={() => confirm("Supprimer ce trade ?") && p.onRemove(t.id)}>
                          ✕
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {closedTrades.length > 0 && (
            <details className="bt">
              <summary>Derniers trades clôturés ({closedTrades.length})</summary>
              <ul className="tlist">
                {closedTrades.slice(0, 20).map((t) => {
                  const pnl = tradePnl(t)!;
                  const r = tradeR(t);
                  return (
                    <li key={t.id}>
                      <div className="trow">
                        <span>
                          {nameOf(t.epic)} · {t.side === "long" ? "achat" : "vente"} {t.size} · {t.entry} → {t.exit}
                        </span>
                        <span className={sign(pnl)}>
                          {money(pnl)}
                          {r !== null ? ` (${r > 0 ? "+" : ""}${r.toFixed(1)} R)` : ""}
                        </span>
                      </div>
                      <div className="muted small">
                        {when(t.closedAt)}
                        {t.note ? ` · ${t.note}` : ""}
                        <button type="button" className="ghost mini" onClick={() => confirm("Supprimer ce trade ?") && p.onRemove(t.id)}>
                          supprimer
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </>
      )}

      <Disclaimer>
        Journal personnel, saisi à la main (ou depuis un ordre démo). Résultats en devise de cotation (USD), avant frais de financement.
        Aucun taux n’est affiché sous 20 trades clôturés. Ce n’est pas un conseil d’investissement.
      </Disclaimer>
    </section>
  );
}
