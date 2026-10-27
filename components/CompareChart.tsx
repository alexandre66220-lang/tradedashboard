"use client";

import { useEffect, useRef, useState } from "react";
import { ColorType, createChart, LineSeries, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from "lightweight-charts";
import { INSTRUMENTS } from "@/config/instruments";
import type { ApiError, CandlesResponse } from "@/lib/types";
import { readJson } from "@/lib/readJson";

const POLL_MS = 60_000;
const WINDOW_SEC = 24 * 3600;
const PALETTE = ["#f0b90b", "#29b6f6", "#ab47bc", "#66bb6a"];

type Points = Array<{ time: UTCTimestamp; value: number }>;

/** Last 24 hours of each instrument as a percentage change from the start of the window, to see which one moves. */
export default function CompareChart({ selected, onSelect }: { selected: string; onSelect: (epic: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const [moves, setMoves] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#12161f" }, textColor: "#9598a1", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "#161a23" }, horzLines: { color: "#1b202b" } },
      rightPriceScale: { borderColor: "#232733" },
      timeScale: {
        borderColor: "#232733",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: Time) => new Date((t as number) * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
      },
      localization: { locale: "fr-FR", priceFormatter: (p: number) => `${p > 0 ? "+" : ""}${p.toFixed(2)} %` },
      handleScroll: false,
      handleScale: false,
    });
    chart.current = c;
    INSTRUMENTS.forEach((inst, i) => {
      series.current.set(inst.epic, c.addSeries(LineSeries, { color: PALETTE[i % PALETTE.length], lineWidth: 2, priceLineVisible: false, lastValueVisible: false }));
    });
    return () => {
      c.remove();
      chart.current = null;
      series.current.clear();
    };
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      clearTimeout(timer);
      if (!document.hidden) {
        const results = await Promise.all(
          INSTRUMENTS.map(async (inst) => {
            try {
              const res = await fetch(`/api/candles?epic=${encodeURIComponent(inst.epic)}&resolution=15`, { signal: ctrl.signal, cache: "no-store" });
              if (res.status === 401) {
                window.location.href = "/login";
                return null;
              }
              const body = await readJson<CandlesResponse | ApiError>(res);
              return res.ok && body && "candles" in body ? { epic: inst.epic, candles: body.candles } : null;
            } catch {
              return null;
            }
          }),
        );
        if (ctrl.signal.aborted) return;
        const next: Record<string, number | null> = {};
        let failed = 0;
        for (const r of results) {
          if (!r) {
            failed++;
            continue;
          }
          const end = r.candles.at(-1)?.time ?? 0;
          const win = r.candles.filter((k) => k.time >= end - WINDOW_SEC);
          const base = win[0]?.close;
          if (!base) continue;
          const pts: Points = win.map((k) => ({ time: k.time as UTCTimestamp, value: (k.close / base - 1) * 100 }));
          series.current.get(r.epic)?.setData(pts);
          next[r.epic] = pts.at(-1)?.value ?? null;
        }
        setMoves((m) => ({ ...m, ...next }));
        setError(failed === INSTRUMENTS.length ? "Prix indisponibles pour le moment." : null);
        chart.current?.timeScale().fitContent();
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

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Les instruments sur 24 h</span>
      </div>
      <div className="cmpchart" ref={box} role="img" aria-label="Évolution en pourcentage des instruments sur 24 heures" />
      {error && <p className="muted small">{error}</p>}
      <ul className="legend">
        {INSTRUMENTS.map((inst, i) => {
          const v = moves[inst.epic];
          return (
            <li key={inst.epic}>
              <button type="button" className={`legend-btn${inst.epic === selected ? " on" : ""}`} onClick={() => onSelect(inst.epic)} aria-label={`Afficher ${inst.name}`}>
                <span className="swatch" style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden="true" />
                <span className="lname">{inst.name}</span>
                <span className={v == null ? "muted" : v >= 0 ? "pos" : "neg"}>{v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)} %`}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
