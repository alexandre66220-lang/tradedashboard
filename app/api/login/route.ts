import { NextResponse } from "next/server";
import { passwordMatches, sessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Basic brute-force protection (per server instance).
const attempts = new Map<string, { count: number; since: number }>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function redirect(req: Request, path: string) {
  return NextResponse.redirect(new URL(path, req.url), 303);
}

export async function POST(req: Request) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return new NextResponse("Site verrouillé", { status: 503 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  const now = Date.now();
  const a = attempts.get(ip);
  if (a && now - a.since < WINDOW_MS && a.count >= MAX_ATTEMPTS) return redirect(req, "/login?e=locked");

  const form = await req.formData().catch(() => null);
  const submitted = form?.get("password");
  if (typeof submitted !== "string" || !(await passwordMatches(submitted, password))) {
    const entry = a && now - a.since < WINDOW_MS ? a : { count: 0, since: now };
    entry.count++;
    attempts.set(ip, entry);
    await new Promise((r) => setTimeout(r, 600));
    return redirect(req, "/login?e=1");
  }

  attempts.delete(ip);
  const res = redirect(req, "/");
  res.cookies.set(SESSION_COOKIE, await sessionToken(password), {
    httpOnly: true,
    // Secure everywhere except `next dev` (plain http://localhost)
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
