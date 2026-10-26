import { NextResponse, type NextRequest } from "next/server";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";

const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/logout"]);
// Called by Vercel Cron without the dashboard cookie; the route itself requires `Bearer $CRON_SECRET` (fails closed).
const CRON_PATHS = new Set(["/api/journal/record", "/api/alerts/check"]);

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
