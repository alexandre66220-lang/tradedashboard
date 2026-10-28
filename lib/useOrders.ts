"use client";

import { useCallback, useEffect, useState } from "react";
import { readJson, unexpectedResponse } from "./readJson";
import type { DealResult, OrdersState, Recap } from "./orders";

export type { DealResult, OrdersState, Recap };

type ApiError = { error?: { message?: string } };
const messageOf = (body: unknown, fallback: string) => (body as ApiError | null)?.error?.message ?? fallback;

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    if (res.status === 401) {
      window.location.href = "/login";
      return { ok: false, error: "Session expirée." };
    }
    const body = await readJson<T>(res);
    if (body === null) return { ok: false, error: unexpectedResponse(res).message };
    return res.ok ? { ok: true, body } : { ok: false, error: messageOf(body, `Erreur (HTTP ${res.status}).`) };
  } catch {
    return { ok: false, error: "Serveur injoignable." };
  }
}

/** Orders on the demo account: whether they are switched on, the open positions, and the three actions. Nothing is sent without the signed recap. */
export function useOrders() {
  const [state, setState] = useState<OrdersState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await call<OrdersState>("/api/orders");
    if (r.ok) {
      setState(r.body);
      setError(null);
    } else setError(r.error);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const preview = useCallback((order: { epic: string; side: "long" | "short"; size: number; stop: number; target?: number }) => call<Recap>("/api/orders/preview", { method: "POST", body: JSON.stringify(order) }), []);
  const send = useCallback(
    async (token: string) => {
      const r = await call<DealResult & { order: unknown }>("/api/orders", { method: "POST", body: JSON.stringify({ token }) });
      await reload();
      return r;
    },
    [reload],
  );
  const close = useCallback(
    async (dealId: string) => {
      const r = await call<DealResult>(`/api/orders/${encodeURIComponent(dealId)}`, { method: "DELETE" });
      await reload();
      return r;
    },
    [reload],
  );

  return { state, error, reload, preview, send, close };
}

export type Orders = ReturnType<typeof useOrders>;
