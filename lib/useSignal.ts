"use client";

import { useEffect, useState } from "react";
import type { SignalStatus } from "./signal";

const POLL_MS = 5 * 60_000;

/** Live status of the forecast series on screen (is it proven by the journal?), refreshed every 5 minutes while visible. */
export function useSignal(epic: string, resolution: string, horizon: number, source: string | undefined): SignalStatus | null {
  const [status, setStatus] = useState<SignalStatus | null>(null);

  useEffect(() => {
    if (!source) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      clearTimeout(timer);
      if (!document.hidden) {
        try {
          const q = new URLSearchParams({ epic, resolution, horizon: String(horizon), source });
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
  }, [epic, resolution, horizon, source]);

  return source ? status : null;
}
