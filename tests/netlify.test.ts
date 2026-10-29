import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import alerts, { config as alertsConfig } from "../netlify/functions/cron-alerts.mjs";
import journal, { config as journalConfig } from "../netlify/functions/cron-journal.mjs";
import daily, { config as dailyConfig } from "../netlify/functions/cron-journal-daily.mjs";
import backup, { config as backupConfig } from "../netlify/functions/cron-backup.mjs";
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
    expect(backupConfig.schedule).toBe("30 3 * * *");
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

  it("ask for the nightly backup with the shared secret", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await backup(req(), ctx);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://dash.example.app/api/backup/run");
    expect(init.headers).toMatchObject({ Authorization: "Bearer s3cret" });
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

  it("recorder refuses a caller without the secret and records everything at once when no scope is given", async () => {
    const fetchMock = vi.fn(async () => new Response('{"jobs":9,"failed":0}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await record(req(), ctx);
    await record(req("Bearer wrong"), ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    await record(req("Bearer s3cret"), ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://dash.example.app/api/journal/record");
    await record(new Request("https://dash.example.app/x?scope=%22evil", { method: "POST", headers: { Authorization: "Bearer s3cret" } }), ctx);
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("https://dash.example.app/api/journal/record"); // unknown scope: ignored
  });

  it("recorder asks for the plan, then for each forecast in its own request, two at a time", async () => {
    const calls = ["scope=intraday&epic=GOLD", "scope=intraday&epic=BTCUSD", "scope=intraday&epic=US100", "bad call;rm"];
    let running = 0, peak = 0;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("plan=intraday")) return new Response(JSON.stringify({ calls }), { status: 200 });
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return new Response("{}", { status: String(url).includes("US100") ? 500 : 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.mocked(console.log);
    await record(new Request("https://dash.example.app/x?scope=intraday", { method: "POST", headers: { Authorization: "Bearer s3cret" } }), ctx);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toBe("https://dash.example.app/api/journal/record?plan=intraday");
    expect(urls.slice(1).sort()).toEqual(calls.slice(0, 3).map((c) => `https://dash.example.app/api/journal/record?${c}`).sort()); // the odd one is dropped
    expect(fetchMock.mock.calls.every((c) => (c[1] as RequestInit).headers && ((c[1] as RequestInit).headers as Record<string, string>).Authorization === "Bearer s3cret")).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(log.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/done \(intraday\): 2 recorded, 1 failed/);
  });

  it("recorder stops quietly when the plan cannot be read", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>login</html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(record(new Request("https://dash.example.app/x?scope=daily", { method: "POST", headers: { Authorization: "Bearer s3cret" } }), ctx)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
