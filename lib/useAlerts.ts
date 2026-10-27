"use client";

import { useCallback, useEffect, useState } from "react";
import type { AlertOp, PriceAlert } from "./alerts";

async function call(url: string, init?: RequestInit): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (res.status === 401) {
    window.location.href = "/login";
    return { ok: false, body: {} };
  }
  return { ok: res.ok, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const errorOf = (b: Record<string, unknown>, fallback: string) => (b.error as { message?: string } | undefined)?.message ?? fallback;

/** Price alerts (/api/alerts). Actions return an error message, or null on success. */
export function useAlerts() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [notify, setNotify] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const { ok, body } = await call("/api/alerts");
      if (!ok) throw new Error(errorOf(body, "Lecture impossible."));
      setAlerts(body.alerts as PriceAlert[]);
      setConfigured(body.configured as boolean);
      setNotify(body.notify as boolean);
      setError(null);
    } catch (e) {
      setError((e as Error).message || "Serveur injoignable.");
    }
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(() => !document.hidden && reload(), 5 * 60_000);
    return () => clearInterval(t);
  }, [reload]);

  const run = async (url: string, init: RequestInit, failure: string): Promise<string | null> => {
    try {
      const { ok, body } = await call(url, init);
      if (!ok) return errorOf(body, failure);
      await reload();
      return null;
    } catch {
      return "Serveur injoignable.";
    }
  };

  return {
    alerts,
    configured,
    notify,
    error,
    add: (a: { epic: string; op: AlertOp; price: number; note?: string }) => run("/api/alerts", { method: "POST", body: JSON.stringify(a) }, "Création impossible."),
    remove: (id: string) => run(`/api/alerts/${id}`, { method: "DELETE" }, "Suppression impossible."),
    test: () => run("/api/alerts/test", { method: "POST" }, "Envoi impossible."),
  };
}
