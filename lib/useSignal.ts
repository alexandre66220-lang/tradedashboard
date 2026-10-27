"use client";

import { useEffect, useState } from "react";
import type { SignalStatus } from "./signal";
import type { Regime } from "./regime";

const POLL_MS = 5 * 60_000;

/** Live status of the forecast series on screen (is it proven by the journal?), refreshed every 5 minutes while visible. */
export function useSignal(epic: string, resolution: string, horizon: number, source: string | undefined, confidence?: number, regime?: Regime | null): SignalStatus | null {
  const [status, setStatus] = useState<SignalStatus | null>(null);
  const volKey = regime?.vol;
  const trendKey = regime?.trend;
  // the confidence moves by a point or two between polls: ask again when it crosses a 5-point band only
  const band = confidence === undefined ? undefined : Math.floor(confidence * 20) / 20;

  useEffect(() => {
    if (!source) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      clearTimeout(timer);
      if (!document.hidden) {
        try {
          const q = new URLSearchParams({ epic, resolution, horizon: String(horizon), source });
          if (band !== undefined) q.set("confidence", (band + 0.0001).toFixed(4));
          if (volKey) q.set("vol", volKey);
          if (trendKey) q.set("trend", trendKey);
          const res = await fetch(`/api/journal/signal?${q}`, { signal: ctrl.signal, cache: "no-store" });
          if (res.ok) setStatus((await res.json()) as SignalStatus);
        } catch {
          /* the badge simply stays as it was */
        }
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
  }, [epic, resolution, horizon, source, band, volKey, trendKey]);

  return source ? status : null;
}
