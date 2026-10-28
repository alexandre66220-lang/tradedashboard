"use client";

import { useEffect, useState } from "react";
import type { ContextResponse } from "./context/types";
import { readJson } from "./readJson";

const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 60_000;

/** Positioning data around an instrument (see /api/context). null while loading or when the call itself failed. */
export function useMarketContext(epic: string): ContextResponse | null {
  const [data, setData] = useState<{ epic: string; value: ContextResponse } | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let next = REFRESH_MS;
      try {
        const res = await fetch(`/api/context?epic=${encodeURIComponent(epic)}`, { cache: "no-store" });
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        const body = await readJson<ContextResponse>(res);
        if (res.ok && body && !stop) setData({ epic, value: body });
        else next = RETRY_MS;
      } catch {
        next = RETRY_MS;
      }
      if (!stop) timer = setTimeout(load, next);
    };
    load();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [epic]);

  return data && data.epic === epic ? data.value : null;
}
