import { NextResponse, type NextRequest } from "next/server";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";

// The manifest and icons hold no data; the phone fetches them without the session cookie (home-screen install).
const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/logout", "/manifest.webmanifest", "/icon.png", "/apple-icon.png"]);
// Called by Vercel Cron without the dashboard cookie; the route itself requires `Bearer $CRON_SECRET` (fails closed).
// The Netlify background function that records the journal is called by the scheduled functions without the cookie too: it checks
// the same secret itself and does nothing without it. (Before this was listed, the scheduler's call was sent to /login and nothing
// was ever recorded in the background.)
const CRON_PATHS = new Set(["/api/journal/record", "/api/alerts/check", "/api/backup/run", "/.netlify/functions/journal-record-background"]);

export async function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  // Fail closed: without a configured password nothing is served.
  if (!password) {
    const msg = "DASHBOARD_PASSWORD n'est pas défini côté serveur : le site est verrouillé.";
    return isApi
      ? NextResponse.json({ error: { code: "CONFIG_MISSING", message: msg } }, { status: 503 })
      : new NextResponse(msg, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (PUBLIC_PATHS.has(pathname) || CRON_PATHS.has(pathname)) return NextResponse.next();

  if (await isValidSession(req.cookies.get(SESSION_COOKIE)?.value, password)) return NextResponse.next();

  if (isApi) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Authentification requise." } }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  // Everything except Next.js build assets (JS/CSS chunks contain no data).
  matcher: ["/((?!_next/static|_next/image).*)"],
};
