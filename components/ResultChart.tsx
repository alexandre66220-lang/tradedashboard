"use client";

import { useEffect, useRef } from "react";
import { ColorType, createChart, LineSeries, LineStyle, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from "lightweight-charts";
import type { ResultCurve } from "@/lib/journal/types";

const t = (s: number) => s as UTCTimestamp;

/**
 * Cumulative simulated result of the judged forecasts, inside the zone that chance alone would keep it in (dotted lines).
 * A curve that stays inside proves nothing; one that leaves it for good is unlikely to be luck.
 */
export default function ResultChart({ curve }: { curve: ResultCurve }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const lines = useRef<{ v: ISeriesApi<"Line">; hi: ISeriesApi<"Line">; lo: ISeriesApi<"Line"> } | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#12161f" }, textColor: "#9598a1", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "#161a23" }, horzLines: { color: "#1b202b" } },
      rightPriceScale: { borderColor: "#232733" },
      timeScale: {
        borderColor: "#232733",
        timeVisible: false,
        tickMarkFormatter: (x: Time) => new Date((x as number) * 1000).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }),
      },
      localization: {
        locale: "fr-FR",
        priceFormatter: (p: number) => `${p > 0 ? "+" : ""}${p.toFixed(2)} %`,
        timeFormatter: (x: Time) => new Date((x as number) * 1000).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
      },
      handleScroll: false,
      handleScale: false,
    });
    const band = { color: "rgba(149,152,161,0.7)", lineWidth: 1 as const, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    lines.current = {
      hi: c.addSeries(LineSeries, band),
      lo: c.addSeries(LineSeries, band),
      v: c.addSeries(LineSeries, { color: "#26a69a", lineWidth: 2, priceLineVisible: false, lastValueVisible: true }),
    };
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      lines.current = null;
    };
  }, []);

  useEffect(() => {
    const l = lines.current;
    if (!l) return;
    l.v.setData(curve.points.map((p) => ({ time: t(p.t), value: p.v })));
    l.hi.setData(curve.points.map((p) => ({ time: t(p.t), value: p.b })));
    l.lo.setData(curve.points.map((p) => ({ time: t(p.t), value: -p.b })));
    const last = curve.points.at(-1);
    l.v.applyOptions({ color: last && last.v >= 0 ? "#26a69a" : "#ef5350" });
    chart.current?.timeScale().fitContent();
  }, [curve]);

  const last = curve.points.at(-1);
  const where = !last ? "" : last.v > last.b ? "au-dessus" : last.v < -last.b ? "en dessous" : "dans";
  return (
    <>
      <div className="cmpchart" ref={box} role="img" aria-label="Résultat cumulé simulé du journal" />
      {last && (
        <p className="muted small">
          {curve.n} prévisions jugées · résultat cumulé{" "}
          <strong className={last.v >= 0 ? "pos" : "neg"}>
            {last.v > 0 ? "+" : ""}
            {last.v.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %
          </strong>{" "}
          · {where === "dans" ? "dans la zone que le hasard seul pourrait produire (pointillés) : rien n’est prouvé" : `${where} de la zone du hasard (pointillés)`}.
        </p>
      )}
    </>
  );
}
