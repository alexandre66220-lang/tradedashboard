import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn(async (..._args: unknown[]) => true);
vi.mock("@/lib/notify", () => ({ notifyConfigured: () => true, sendNotification: (...a: unknown[]) => send(...a) }));

import { POST } from "@/app/api/login/route";
import { BASE_LOCK_MS, clientIp, isLocked, lockStatus, MAX_FAILURES, MAX_LOCK_MS, recordFailure, recordSuccess, withFailure, WINDOW_MS, __resetLoginGuard } from "@/lib/loginGuard";
import { __resetMemoryStorage } from "@/lib/journal/storage";

const T = 1_700_000_000_000;

describe("lock-out rules", () => {
  it("locks after five failures within the window, not after four", () => {
    let a = undefined as ReturnType<typeof withFailure>["next"] | undefined;
    for (let i = 0; i < MAX_FAILURES - 1; i++) a = withFailure(a, "x", T + i).next;
    expect(isLocked(a, T + 10)).toBe(false);
    const last = withFailure(a, "x", T + 20);
    expect(last.justLocked).toBe(true);
    expect(isLocked(last.next, T + 30)).toBe(true);
    expect(isLocked(last.next, T + 20 + BASE_LOCK_MS + 1)).toBe(false);
  });

  it("forgets failures older than the window", () => {
    let a = undefined as ReturnType<typeof withFailure>["next"] | undefined;
    for (let i = 0; i < MAX_FAILURES - 1; i++) a = withFailure(a, "x", T + i).next;
    const later = withFailure(a, "x", T + WINDOW_MS + 5);
    expect(later.justLocked).toBe(false);
    expect(later.next.fails).toHaveLength(1);
  });

  it("doubles the lock at each new lock-out, up to a day", () => {
    let a = undefined as ReturnType<typeof withFailure>["next"] | undefined;
    let now = T;
    const lockOnce = () => {
      for (let i = 0; i < MAX_FAILURES; i++) a = withFailure(a, "x", now).next;
      const length = a!.lockedUntil - now;
      now = a!.lockedUntil + 1;
      return length;
    };
    expect(lockOnce()).toBe(BASE_LOCK_MS);
    expect(lockOnce()).toBe(BASE_LOCK_MS * 2);
    expect(lockOnce()).toBe(BASE_LOCK_MS * 4);
    for (let k = 0; k < 10; k++) lockOnce();
    expect(lockOnce()).toBeLessThanOrEqual(MAX_LOCK_MS);
  });
});

describe("client address", () => {
  it("trusts the platform's headers in a fixed order", () => {
    const req = (h: Record<string, string>) => new Request("https://x.test", { headers: h });
    expect(clientIp(req({ "x-nf-client-connection-ip": "1.1.1.1", "x-forwarded-for": "9.9.9.9" }))).toBe("1.1.1.1");
    expect(clientIp(req({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "9.9.9.9" }))).toBe("2.2.2.2");
    expect(clientIp(req({ "x-forwarded-for": "3.3.3.3, 10.0.0.1" }))).toBe("3.3.3.3");
    expect(clientIp(req({}))).toBe("local");
  });
});

describe("shared counter", () => {
  beforeEach(() => {
    vi.stubEnv("JOURNAL_STORAGE", "memory");
    vi.stubEnv("STORAGE_BACKEND", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "");
    __resetMemoryStorage();
    __resetLoginGuard();
    send.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("counts failures per client, warns the owner once when one is locked out, and clears them on success", async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) expect((await recordFailure("1.2.3.4", T + i)).justLocked).toBe(false);
    expect((await lockStatus("1.2.3.4", T + 100)).locked).toBe(false);
    expect((await recordFailure("1.2.3.4", T + 200)).justLocked).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const s = await lockStatus("1.2.3.4", T + 300);
    expect(s.locked).toBe(true);
    expect(s.retryAfterSec).toBeGreaterThan(14 * 60);
    expect((await lockStatus("5.6.7.8", T + 300)).locked).toBe(false); // someone else is not affected
    await recordFailure("1.2.3.4", T + 400); // already locked: no second warning
    expect(send).toHaveBeenCalledTimes(1);
    await recordSuccess("5.6.7.8", T + 500);
  });

  it("keeps counting in memory when there is no store", async () => {
    vi.stubEnv("JOURNAL_STORAGE", "");
    for (let i = 0; i < MAX_FAILURES; i++) await recordFailure("9.9.9.9", T + i);
    expect((await lockStatus("9.9.9.9", T + 50)).locked).toBe(true);
  });
});

describe("login route", () => {
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_PASSWORD", "right-password");
    vi.stubEnv("JOURNAL_STORAGE", "memory");
    vi.stubEnv("STORAGE_BACKEND", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", "");
    __resetMemoryStorage();
    __resetLoginGuard();
  });
  afterEach(() => vi.unstubAllEnvs());

  const attempt = (password: string, ip = "7.7.7.7") => {
    const body = new FormData();
    body.set("password", password);
    return POST(new Request("https://dash.example.app/api/login", { method: "POST", body, headers: { "x-nf-client-connection-ip": ip } }));
  };

  it("lets the right password in, and refuses a client that guessed five times, even with the right password", async () => {
    const ok = await attempt("right-password");
    expect(ok.headers.get("location")).toBe("https://dash.example.app/");
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
    for (let i = 0; i < MAX_FAILURES; i++) {
      const bad = await attempt("nope");
      expect(bad.headers.get("location")).toContain(i === MAX_FAILURES - 1 ? "e=locked" : "e=1");
    }
    const locked = await attempt("right-password");
    expect(locked.headers.get("location")).toContain("e=locked");
    expect(locked.headers.get("set-cookie")).toBeNull();
    expect((await attempt("right-password", "8.8.8.8")).headers.get("set-cookie")).toContain("HttpOnly"); // another visitor
  }, 20_000);
});
