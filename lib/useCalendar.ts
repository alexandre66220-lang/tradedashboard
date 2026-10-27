"use client";

import { useEffect, useState } from "react";
import type { CalendarEvent } from "./calendar";
import { readJson, RETRY_AFTER_FAILURE_MS, unexpectedResponse } from "./readJson";

const POLL_MS = 5 * 60_000;

/** Economic announcements (medium and high impact, next 7 days), refreshed every 5 minutes while the page is visible. */
export function useCalendar() {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failed = false;
    const run = async () => {
      clearTimeout(timer);
      if (!document.hidden) {
        try {
          const res = await fetch("/api/calendar", { signal: ctrl.signal, cache: "no-store" });
          if (res.status === 401) {
            window.location.href = "/login";
            return;
          }
          const body = await readJson<{ events?: CalendarEvent[]; stale?: boolean; error?: { message?: string } }>(res);
          if (!body) throw unexpectedResponse(res);
          if (!res.ok || !body.events) throw new Error(body.error?.message ?? `Erreur ${res.status}`);
          setEvents(body.events);
          setStale(Boolean(body.stale));
          setError(null);
          failed = false;
        } catch (e) {
          failed = true;
          if (!ctrl.signal.aborted) setError((e as Error).message || "Serveur injoignable.");
        }
      }
      if (!ctrl.signal.aborted) timer = setTimeout(run, failed ? RETRY_AFTER_FAILURE_MS : POLL_MS);
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

  return { events, stale, error };
}
