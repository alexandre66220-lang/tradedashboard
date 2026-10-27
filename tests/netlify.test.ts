import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import alerts, { config as alertsConfig } from "../netlify/functions/cron-alerts.mjs";
import journal, { config as journalConfig } from "../netlify/functions/cron-journal.mjs";
import daily, { config as dailyConfig } from "../netlify/functions/cron-journal-daily.mjs";
import record, { config as recordConfig } from "../netlify/functions/journal-record-background.mjs";

const ctx = { site: { url: "https://dash.example.app" } };
const req = (auth?: string) => new Request("https://dash.example.app/x", { method: "POST", headers: auth ? { Authorization: auth } : {} });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Netlify scheduled functions", () => {
  it("are scheduled in UTC cron syntax and the recorder is a background function", () => {
    expect(alertsConfig.schedule).toBe("*/5 * * * *");
    expect(journalConfig.schedule).toBe("*/30 * * * *");
    expect(dailyConfig.schedule).toBe("5 7 * * *");
    expect(recordConfig.background).toBe(true);
  });

  it("check the alerts with the shared secret", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await alerts(req(), ctx);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://dash.example.app/api/alerts/check");
    expect(init.headers).toMatchObject({ Authorization: "Bearer s3cret" });
  });

  it("hand the journal over to the background function without waiting for it", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await journal(req(), ctx);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://dash.example.app/.netlify/functions/journal-record-background?scope=intraday");
    expect(init.method).toBe("POST");
    fetchMock.mockClear();
    await daily(req(), ctx);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain("?scope=daily");
  });

  it("do nothing without the secret, and never throw when the site is down", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("down");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(alerts(req(), ctx)).resolves.toBeUndefined();
    await expect(journal(req(), ctx)).resolves.toBeUndefined();
    vi.stubEnv("CRON_SECRET", "");
    fetchMock.mockClear();
    await alerts(req(), ctx);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recorder refuses a caller without the secret and records for the right one", async () => {
    const fetchMock = vi.fn(async () => new Response('{"jobs":9,"failed":0}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await record(req(), ctx);
    await record(req("Bearer wrong"), ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    await record(req("Bearer s3cret"), ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://dash.example.app/api/journal/record");
    await record(new Request("https://dash.example.app/x?scope=intraday", { method: "POST", headers: { Authorization: "Bearer s3cret" } }), ctx);
    await record(new Request("https://dash.example.app/x?scope=%22evil", { method: "POST", headers: { Authorization: "Bearer s3cret" } }), ctx);
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("https://dash.example.app/api/journal/record?scope=intraday");
    expect((fetchMock.mock.calls[2] as unknown as [string])[0]).toBe("https://dash.example.app/api/journal/record"); // unknown scope: ignored
  });
});
