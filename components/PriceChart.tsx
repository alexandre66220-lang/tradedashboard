"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, ForecastResponse } from "@/lib/types";

const COLORS = {
  up: "#26a69a",
  down: "#ef5350",
  flat: "#9598a1",
};

interface Props {
  candles: Candle[];
  forecast: ForecastResponse | null;
  showBand: boolean;
  /** Changes when instrument/timeframe changes, to re-fit the view */
  viewKey: string;
}

const t = (s: number) => s as UTCTimestamp;

function formatTime(time: Time, withDate: boolean) {
  const d = new Date((time as number) * 1000);
  const hm = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return withDate ? `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${hm}` : hm;
}

export default function PriceChart({ candles, forecast, showBand, viewKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    candles: ISeriesApi<"Candlestick">;
    forecast: ISeriesApi<"Line">;
    high: ISeriesApi<"Line">;
    low: ISeriesApi<"Line">;
  } | null>(null);
  const fittedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0b0e14" },
        textColor: "#9598a1",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { color: "#161a23" }, horzLines: { color: "#161a23" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#232733" },
      timeScale: {
        borderColor: "#232733",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: (time: Time) => formatTime(time, false),
      },
      localization: { locale: "fr-FR", timeFormatter: (time: Time) => formatTime(time, true) },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });
    const bandOpts = {
      lineWidth: 1 as const,
      lineStyle: LineStyle.Dotted,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    };
    const high = chart.addSeries(LineSeries, { ...bandOpts, color: "rgba(149,152,161,0.45)", title: "" });
    const low = chart.addSeries(LineSeries, { ...bandOpts, color: "rgba(149,152,161,0.45)", title: "" });
    const fc = chart.addSeries(LineSeries, {
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "prévision",
    });
    chartRef.current = chart;
    seriesRef.current = { candles: candleSeries, forecast: fc, high, low };
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      fittedKey.current = null;
    };
  }, []);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    s.candles.setData(candles.map((c) => ({ time: t(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));

    const last = candles.at(-1);
    const pts = forecast && last ? forecast.points.filter((p) => p.time > last.time) : [];
    if (last && pts.length) {
      const color = COLORS[forecast!.direction];
      s.forecast.applyOptions({ color });
      s.forecast.setData([{ time: t(last.time), value: last.close }, ...pts.map((p) => ({ time: t(p.time), value: p.value }))]);
      s.high.setData([{ time: t(last.time), value: last.close }, ...pts.map((p) => ({ time: t(p.time), value: p.high }))]);
      s.low.setData([{ time: t(last.time), value: last.close }, ...pts.map((p) => ({ time: t(p.time), value: p.low }))]);
    } else {
      s.forecast.setData([]);
      s.high.setData([]);
      s.low.setData([]);
    }

    if (candles.length && fittedKey.current !== viewKey) {
      fittedKey.current = viewKey;
      // Show the most recent ~120 candles plus the forecast area
      const total = candles.length + pts.length;
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - 120), to: total + 2 });
    }
  }, [candles, forecast, viewKey]);

  useEffect(() => {
    seriesRef.current?.high.applyOptions({ visible: showBand });
    seriesRef.current?.low.applyOptions({ visible: showBand });
  }, [showBand]);

  return <div ref={containerRef} className="chart" />;
}
