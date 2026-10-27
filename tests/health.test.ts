import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const quote = vi.fn();
const calendar = vi.fn();
const overview = vi.fn();
vi.mock("@/lib/capital", async () => {
  const actual = await vi.importActual<typeof import("@/lib/capital")>("@/lib/capital");
  return { ...actual, getMarketQuote: (...a: unknown[]) => quote(...a) };
});
vi.mock("@/lib/calendar-source", () => ({ getCalendar: () => calendar() }));
vi.mock("@/lib/journal/service", () => ({ journalOverview: () => overview() }));

import { CapitalError } from "@/lib/capital";
import { healthReport, JOURNAL_SILENT_ERROR_MS, JOURNAL_SILENT_WARN_MS } from "@/lib/health";
import { saveBackup } from "@/lib/backup";
import { __resetMemoryStorage } from "@/lib/journal/storage";

const by = (r: Awaited<ReturnType<typeof healthReport>>, id: string) => r.checks.find((c) => c.id === id)!;
const journal = (silentMs: number | null) => ({ configured: true, activity: { lastRecordedAt: silentMs === null ? null : Date.now() - silentMs, last24h: 12, total: 40 } });

beforeEach(() => {
  vi.stubEnv("JOURNAL_STORAGE", "memory");
  vi.stubEnv("CRON_SECRET", "x");
  vi.stubEnv("NTFY_TOPIC", "t");
  vi.stubEnv("FORECAST_SERVICE_URL", "");
  vi.stubEnv("FORECAST_SERVICE_TOKEN", "");
  vi.stubEnv("STORAGE_BACKEND", "");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "");
  __resetMemoryStorage();
  quote.mockResolvedValue({ status: "TRADEABLE", bid: 1, offer: 1 });
  calendar.mockResolvedValue({ events: [{}, {}], updatedAt: Date.now() - 60_000, stale: false });
  overview.mockResolvedValue(journal(5 * 60_000));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("health report", () => {
  it("is all green when everything answers", async () => {
    await saveBackup();
    const r = await healthReport();
    expect(r.overall).toBe("ok");
    expect(by(r, "capital").status).toBe("ok");
    expect(by(r, "model").status).toBe("off"); // no external model configured: not a problem
    expect(by(r, "journal").detail).toMatch(/12 prévisions sur 24 h/);
  });

  it("reports a Capital.com failure with its message, without failing the whole report", async () => {
    quote.mockRejectedValue(new CapitalError("AUTH_FAILED", "Identifiants refusés", 502));
    const r = await healthReport();
    expect(by(r, "capital")).toMatchObject({ status: "error", detail: "Identifiants refusés" });
    expect(by(r, "calendar").status).toBe("ok");
    expect(r.overall).toBe("error");
  });

  it("warns, then errors, when the journal has been silent for too long", async () => {
    overview.mockResolvedValue(journal(JOURNAL_SILENT_WARN_MS + 60_000));
    expect(by(await healthReport(), "journal").status).toBe("warn");
    overview.mockResolvedValue(journal(JOURNAL_SILENT_ERROR_MS + 60_000));
    const r = await healthReport();
    expect(by(r, "journal").status).toBe("error");
    expect(by(r, "journal").detail).toMatch(/CRON_SECRET/);
    overview.mockResolvedValue(journal(null));
    expect(by(await healthReport(), "journal").status).toBe("warn");
  });

  it("flags missing settings by name, never by value", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NTFY_TOPIC", "");
    const c = by(await healthReport(), "settings");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/CRON_SECRET/);
    expect(c.detail).toMatch(/NTFY_TOPIC/);
  });

  it("checks the external model, and notices a missing token", async () => {
    vi.stubEnv("FORECAST_SERVICE_URL", "http://ml.test/api/forecast");
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"status":"ok"}', { status: 200 })));
    expect(by(await healthReport(), "model")).toMatchObject({ status: "warn" });
    vi.stubEnv("FORECAST_SERVICE_TOKEN", "tok");
    expect(by(await healthReport(), "model").status).toBe("ok");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
    expect(by(await healthReport(), "model").status).toBe("error");
  });

  it("watches the backup: none yet, a recent one, a stale one", async () => {
    expect(by(await healthReport(), "backup").status).toBe("warn");
    await saveBackup();
    expect(by(await healthReport(), "backup")).toMatchObject({ status: "ok" });
    await saveBackup(new Date(Date.now() - 5 * 86_400_000)); // an old file does not count as recent
    __resetMemoryStorage();
    await saveBackup(new Date(Date.now() - 5 * 86_400_000));
    expect(by(await healthReport(), "backup").status).toBe("warn");
  });

  it("marks a stale calendar as something to watch", async () => {
    calendar.mockResolvedValue({ events: [], updatedAt: Date.now() - 3 * 3600_000, stale: true });
    expect(by(await healthReport(), "calendar").status).toBe("warn");
  });

  it("is an error when no storage is configured", async () => {
    vi.stubEnv("JOURNAL_STORAGE", "");
    overview.mockResolvedValue({ configured: false });
    const r = await healthReport();
    expect(by(r, "storage").status).toBe("error");
    expect(by(r, "journal").status).toBe("off");
  });
});
