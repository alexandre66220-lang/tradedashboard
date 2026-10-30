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
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { bollinger, ema, fibRetracement, rsi } from "@/lib/indicators";
import { volumeProfile } from "@/lib/profile";
import type { Candle, ForecastResponse } from "@/lib/types";

const COLORS = {
  up: "#26a69a",
  down: "#ef5350",
  flat: "#9598a1",
};

/** Reading aids drawn on the chart (display only: they are not part of the forecast). */
export interface Overlays {
  ma: boolean;
  boll: boolean;
  rsi: boolean;
  fib: boolean;
  /** Point of control and value area of the day's volume profile */
  profile: boolean;
}

interface Props {
  overlays?: Overlays;
  candles: Candle[];
  forecast: ForecastResponse | null;
  showBand: boolean;
  /** Changes when instrument/timeframe changes, to re-fit the view */
  viewKey: string;
  /** Minutes per candle, to size the day's volume profile */
  resMinutes: number;
}

const t = (s: number) => s as UTCTimestamp;

function formatTime(time: Time, withDate: boolean) {
  const d = new Date((time as number) * 1000);
  const hm = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return withDate ? `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${hm}` : hm;
}

const NO_OVERLAYS: Overlays = { ma: false, boll: false, rsi: false, fib: false, profile: false };

interface OverlayRefs {
  ema20?: ISeriesApi<"Line">;
  ema50?: ISeriesApi<"Line">;
  bbU?: ISeriesApi<"Line">;
  bbM?: ISeriesApi<"Line">;
  bbL?: ISeriesApi<"Line">;
  rsi?: ISeriesApi<"Line">;
  fibLines: IPriceLine[];
  profileLines: IPriceLine[];
}

export default function PriceChart({ candles, forecast, showBand, viewKey, resMinutes, overlays = NO_OVERLAYS }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    candles: ISeriesApi<"Candlestick">;
    forecast: ISeriesApi<"Line">;
    high: ISeriesApi<"Line">;
    low: ISeriesApi<"Line">;
  } | null>(null);
  const fittedKey = useRef<string | null>(null);
  const overlayRef = useRef<OverlayRefs>({ fibLines: [], profileLines: [] });

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
      overlayRef.current = { fibLines: [], profileLines: [] };
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

  // Reading aids: series are created when switched on and removed when switched off
  useEffect(() => {
    const chart = chartRef.current;
    const s = seriesRef.current;
    if (!chart || !s) return;
    const o = overlayRef.current;
    const line = (color: string, extra = {}) =>
      chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
    const drop = (k: "ema20" | "ema50" | "bbU" | "bbM" | "bbL" | "rsi") => {
      const series = o[k];
      if (series) chart.removeSeries(series);
      o[k] = undefined;
    };
    const closes = candles.map((c) => c.close);
    const points = <T,>(values: Array<T | null>, warm: number, pick: (v: T) => number) =>
      candles.flatMap((c, i) => (i >= warm && values[i] !== null ? [{ time: t(c.time), value: pick(values[i] as T) }] : []));

    if (overlays.ma) {
      o.ema20 ??= line("#f0b90b");
      o.ema50 ??= line("#29b6f6");
      o.ema20.setData(points(ema(closes, 20), 19, (v) => v));
      o.ema50.setData(points(ema(closes, 50), 49, (v) => v));
    } else {
      drop("ema20");
      drop("ema50");
    }

    if (overlays.boll) {
      o.bbU ??= line("rgba(171,71,188,0.7)");
      o.bbL ??= line("rgba(171,71,188,0.7)");
      o.bbM ??= line("rgba(171,71,188,0.35)", { lineStyle: LineStyle.Dotted });
      const b = bollinger(closes);
      o.bbU.setData(points(b, 19, (v) => v.upper));
      o.bbL.setData(points(b, 19, (v) => v.lower));
      o.bbM.setData(points(b, 19, (v) => v.mid));
    } else {
      drop("bbU");
      drop("bbL");
      drop("bbM");
    }

    if (overlays.rsi) {
      if (!o.rsi) {
        const r = chart.addSeries(LineSeries, { color: "#ab47bc", lineWidth: 1, priceLineVisible: false, lastValueVisible: true, priceFormat: { type: "price", precision: 0, minMove: 1 } }, 1);
        for (const price of [30, 70]) r.createPriceLine({ price, color: "rgba(149,152,161,0.5)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
        chart.panes()[1]?.setStretchFactor(0.3);
        o.rsi = r;
      }
      o.rsi.setData(points(rsi(closes), 14, (v) => v));
    } else {
      drop("rsi");
    }

    for (const l of o.fibLines) s.candles.removePriceLine(l);
    o.fibLines = [];
    if (overlays.fib) {
      const fib = fibRetracement(candles);
      if (fib) {
        o.fibLines = fib.levels.map((l) =>
          s.candles.createPriceLine({ price: l.price, color: "rgba(240,185,11,0.55)", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `${(l.ratio * 100).toFixed(1)} %` }),
        );
      }
    }

    for (const l of o.profileLines) s.candles.removePriceLine(l);
    o.profileLines = [];
    if (overlays.profile) {
      const p = volumeProfile(candles, resMinutes);
      if (p) {
        const line = (price: number, title: string, color: string, width: 1 | 2, style: LineStyle) =>
          s.candles.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title });
        o.profileLines = [
          line(p.poc, "POC", "rgba(255,167,38,0.95)", 2, LineStyle.Solid),
          line(p.vah, "VAH", "rgba(41,182,246,0.8)", 1, LineStyle.Dashed),
          line(p.val, "VAL", "rgba(41,182,246,0.8)", 1, LineStyle.Dashed),
        ];
      }
    }
  }, [candles, overlays, resMinutes]);

  useEffect(() => {
    seriesRef.current?.high.applyOptions({ visible: showBand });
    seriesRef.current?.low.applyOptions({ visible: showBand });
  }, [showBand]);

  return <div ref={containerRef} className="chart" />;
}
