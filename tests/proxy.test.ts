import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

const call = (path: string) => proxy(new NextRequest(`https://dash.example.app${path}`));

beforeEach(() => vi.stubEnv("DASHBOARD_PASSWORD", "secret"));
afterEach(() => vi.unstubAllEnvs());

describe("proxy (password gate)", () => {
  it("lets the phone fetch the manifest and icons without a session (home-screen install)", async () => {
    for (const path of ["/manifest.webmanifest", "/icon.png", "/apple-icon.png", "/login"]) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("lets the schedulers reach the cron routes (they check their own secret)", async () => {
    for (const path of ["/api/journal/record", "/api/alerts/check", "/api/backup/run"]) expect((await call(path)).headers.get("x-middleware-next"), path).toBe("1");
  });

  it("keeps everything else behind the password", async () => {
    expect((await call("/")).status).toBe(307);
    expect((await call("/api/health")).status).toBe(401);
    expect((await call("/api/outlook/cell?epic=GOLD&key=day")).status).toBe(401);
    expect((await call("/api/journal/signal")).status).toBe(401);
    expect((await call("/api/backup")).status).toBe(401); // downloading or restoring a backup needs the password
  });

  it("locks the whole site when no password is configured", async () => {
    vi.stubEnv("DASHBOARD_PASSWORD", "");
    expect((await call("/manifest.webmanifest")).status).toBe(503);
  });
});
