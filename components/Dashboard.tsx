"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_RESOLUTION, HORIZON_CHOICES, RESOLUTIONS, type Instrument, type ResolutionKey } from "@/config/instruments";
import type { ApiError, Candle, CandlesResponse, ForecastResponse } from "@/lib/types";
import BacktestDetails, { fmtHit, VerdictBadge } from "./BacktestDetails";
import OutlookPanel from "./OutlookPanel";

const PriceChart = dynamic(() => import("./PriceChart"), { ssr: false });

const POLL_MS = 5_000;

interface ErrorState {
  code: string;
  message: string;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("unauthorized");
  }
  const body = (await res.json().catch(() => null)) as T | ApiError | null;
  if (!res.ok || !body) {
    const e = (body as ApiError | null)?.error;
    throw Object.assign(new Error(e?.message ?? `Erreur ${res.status}`), { code: e?.code ?? "HTTP_" + res.status });
  }
  return body as T;
}

function readPref<T extends string>(key: string, fallback: T, allowed: readonly string[]): T {
  try {
    const v = localStorage.getItem(key);
    return v !== null && allowed.includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)} %`);

export default function Dashboard({ instruments }: { instruments: Instrument[] }) {
  const [epic, setEpic] = useState(instruments[0].epic);
  const instrument = instruments.find((i) => i.epic === epic) ?? instruments[0];
  const [resolution, setResolution] = useState<ResolutionKey>(DEFAULT_RESOLUTION);
  const [horizon, setHorizon] = useState(instrument.defaultHorizon);
  const [showBand, setShowBand] = useState(true);

  const [candles, setCandles] = useState<Candle[]>([]);
  const [meta, setMeta] = useState<Pick<CandlesResponse, "marketStatus" | "env"> | null>(null);
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore per-device preferences
  useEffect(() => {
    setResolution(readPref("tf", DEFAULT_RESOLUTION, Object.keys(RESOLUTIONS)));
    setShowBand(readPref("band", "1", ["0", "1"]) === "1");
    const e = readPref("epic", instruments[0].epic, instruments.map((i) => i.epic));
    setEpic(e);
    const h = Number(readPref("h:" + e, "", HORIZON_CHOICES.map(String)));
    setHorizon(h || (instruments.find((i) => i.epic === e) ?? instruments[0]).defaultHorizon);
  }, [instruments]);

  const tick = useCallback(
    async (signal: AbortSignal) => {
      const q = `epic=${encodeURIComponent(epic)}&resolution=${resolution}`;
      try {
        const [c, f] = await Promise.allSettled([
          getJson<CandlesResponse>(`/api/candles?${q}`, signal),
          getJson<ForecastResponse>(`/api/forecast?${q}&horizon=${horizon}`, signal),
        ]);
        if (signal.aborted) return;
        if (c.status === "fulfilled") {
          setCandles(c.value.candles);
          setMeta({ marketStatus: c.value.marketStatus, env: c.value.env });
          setError(null);
          setUpdatedAt(new Date());
        } else {
          const e = c.reason as Error & { code?: string };
          setError({ code: e.code ?? "NETWORK", message: e.code ? e.message : "Serveur injoignable. Vérifiez votre connexion." });
        }
        if (f.status === "fulfilled") {
          setForecast(f.value);
          setForecastError(null);
        } else {
          setForecastError((f.reason as Error).message);
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [epic, resolution, horizon],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    setLoading(true);
    setCandles([]);
    setForecast(null);

    const run = async () => {
      clearTimeout(timer);
      if (!document.hidden && !running) {
        running = true;
        await tick(ctrl.signal).catch(() => {});
        running = false;
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
  }, [tick]);

  const selectEpic = (value: string) => {
    const next = instruments.find((i) => i.epic === value);
    if (!next || next.epic === epic) return;
    setEpic(next.epic);
    writePref("epic", next.epic);
    const h = Number(readPref("h:" + next.epic, "", HORIZON_CHOICES.map(String)));
    setHorizon(h || next.defaultHorizon);
  };

  const last = candles.at(-1);
  const prev = candles.at(-2);
  const change = last && prev ? last.close - prev.close : null;
  const closed = meta && meta.marketStatus !== "TRADEABLE" && meta.marketStatus !== "UNKNOWN";
  const dirLabel = { up: "Hausse", down: "Baisse", flat: "Neutre" } as const;
  const dirArrow = { up: "▲", down: "▼", flat: "▶" } as const;
  const decimals = last && last.close < 10 ? 5 : 2;

  return (
    <main className="wrap">
      <header className="top">
        <div className="title">
          {instruments.length > 1 ? (
            <select
              aria-label="Instrument"
              value={epic}
              onChange={(e) => selectEpic(e.target.value)}
            >
              {instruments.map((i) => (
                <option key={i.epic} value={i.epic}>
                  {i.name}
                </option>
              ))}
            </select>
          ) : (
            <h1>{instrument.name}</h1>
          )}
          {meta && <span className={`badge ${meta.env}`}>{meta.env === "live" ? "LIVE" : "DÉMO"}</span>}
        </div>
        <form action="/api/logout" method="post">
          <button className="ghost" type="submit">
            Déconnexion
          </button>
        </form>
      </header>

      <section className="quote">
        <span className="price">{last ? last.close.toFixed(decimals) : "—"}</span>
        {change !== null && (
          <span className={change >= 0 ? "pos" : "neg"}>
            {change >= 0 ? "+" : ""}
            {change.toFixed(decimals)}
          </span>
        )}
        <span className="muted small">
          {closed ? "Marché fermé" : meta ? "Marché ouvert" : ""}
          {updatedAt && ` · maj ${updatedAt.toLocaleTimeString("fr-FR")}`}
        </span>
      </section>

      <section className="controls">
        <div className="seg" role="group" aria-label="Unité de temps">
          {(Object.keys(RESOLUTIONS) as ResolutionKey[]).map((k) => (
            <button
              key={k}
              className={k === resolution ? "on" : ""}
              onClick={() => {
                setResolution(k);
                writePref("tf", k);
              }}
            >
              {RESOLUTIONS[k].label}
            </button>
          ))}
        </div>
        <label className="field">
          Horizon
          <select
            value={horizon}
            onChange={(e) => {
              setHorizon(Number(e.target.value));
              writePref("h:" + epic, e.target.value);
            }}
          >
            {Array.from(new Set([...HORIZON_CHOICES, instrument.defaultHorizon]))
              .sort((a, b) => a - b)
              .map((h) => (
                <option key={h} value={h}>
                  {h} min
                </option>
              ))}
          </select>
        </label>
        <label className="field check">
          <input
            type="checkbox"
            checked={showBand}
            onChange={(e) => {
              setShowBand(e.target.checked);
              writePref("band", e.target.checked ? "1" : "0");
            }}
          />
          Bande
        </label>
      </section>

      {error && (
        <div className="alert" role="alert">
          <strong>{error.message}</strong>
          {candles.length > 0 && <span className="small"> Dernières données affichées.</span>}
        </div>
      )}
      {closed && !error && (
        <div className="alert info">Marché fermé (week-end ou hors séance) : les dernières bougies disponibles sont affichées.</div>
      )}

      <div className="layout">
        <div className="chart-box">
          {loading && candles.length === 0 && !error && <div className="overlay">Chargement…</div>}
          <PriceChart candles={candles} forecast={forecast} showBand={showBand} viewKey={`${epic}|${resolution}|${horizon}`} />
        </div>

        <aside className="side">
          <section className="panel">
          <div className="panel-head">
            <span>Prévision {horizon} min</span>
            <span className="tag">expérimental</span>
          </div>
          {forecast ? (
            <>
              <div className={`dir ${forecast.direction}`}>
                {dirArrow[forecast.direction]} {dirLabel[forecast.direction]}
              </div>
              <dl className="stats">
                <div>
                  <dt>Cible</dt>
                  <dd>{forecast.points.at(-1)?.value.toFixed(decimals) ?? "—"}</dd>
                </div>
                <div>
                  <dt>Confiance</dt>
                  <dd>{fmtPct(forecast.confidence)}</dd>
                </div>
                <div>
                  <dt>Réussite backtest</dt>
                  <dd className={forecast.backtestHitRate != null && forecast.backtestHitRate < 0.5 ? "neg" : ""}>
                    {forecast.backtest ? fmtHit(forecast.backtest) : fmtPct(forecast.backtestHitRate)}
                    {forecast.backtestSamples ? <span className="muted small"> ({forecast.backtestSamples})</span> : null}
                  </dd>
                </div>
              </dl>
              {forecast.backtest && (
                <>
                  <VerdictBadge bt={forecast.backtest} />
                  <BacktestDetails bt={forecast.backtest} confidence={forecast.confidence} />
                </>
              )}
            </>
          ) : (
            <p className="muted small">{forecastError ?? "Calcul en cours…"}</p>
          )}
          {forecast && forecastError && <p className="muted small">Dernière prévision conservée : {forecastError}</p>}
          <p className="disclaimer">
            Prévision expérimentale issue d’un modèle statistique simple{forecast?.source ? ` (${forecast.source})` : ""}. Le taux de
            réussite indique la part de directions correctes sur l’historique chargé ; ce n’est ni une garantie ni un conseil
            d’investissement.
          </p>
          </section>
          <OutlookPanel
            selected={epic}
            onSelect={(e) => {
              selectEpic(e);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />
        </aside>
      </div>
    </main>
  );
}
