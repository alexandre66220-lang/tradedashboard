"use client";

import { useCallback, useEffect, useState } from "react";
import type { Trade, TradePatch } from "./trades";

export interface NewTradeInput {
  epic: string;
  side: "long" | "short";
  entry: number;
  size: number;
  stop?: number;
  target?: number;
  note?: string;
  model?: Trade["model"];
}

async function call(url: string, init?: RequestInit): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (res.status === 401) {
    window.location.href = "/login";
    return { ok: false, body: {} };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, body };
}

const errorOf = (body: Record<string, unknown>, fallback: string) => ((body.error as { message?: string } | undefined)?.message ?? fallback);

/** Client-side access to the trade log (/api/trades). Each action returns an error message, or null on success. */
export function useTrades() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const { ok, body } = await call("/api/trades");
      if (!ok) throw new Error(errorOf(body, "Lecture impossible."));
      setTrades(body.trades as Trade[]);
      setConfigured(body.configured as boolean);
      setError(null);
    } catch (e) {
      setError((e as Error).message || "Serveur injoignable.");
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const mutate = useCallback(
    async (url: string, init: RequestInit, failure: string): Promise<string | null> => {
      try {
        const { ok, body } = await call(url, init);
        if (!ok) return errorOf(body, failure);
        await reload();
        return null;
      } catch {
        return "Serveur injoignable.";
      }
    },
    [reload],
  );

  return {
    trades,
    configured,
    error,
    reload,
    add: (t: NewTradeInput) => mutate("/api/trades", { method: "POST", body: JSON.stringify(t) }, "Enregistrement impossible."),
    patch: (id: string, p: TradePatch) => mutate(`/api/trades/${id}`, { method: "PATCH", body: JSON.stringify(p) }, "Modification impossible."),
    remove: (id: string) => mutate(`/api/trades/${id}`, { method: "DELETE" }, "Suppression impossible."),
  };
}
