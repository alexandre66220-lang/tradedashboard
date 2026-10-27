import { NextResponse } from "next/server";
import { passwordMatches, sessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth";
import { clientIp, lockStatus, recordFailure, recordSuccess } from "@/lib/loginGuard";

export const dynamic = "force-dynamic";

function redirect(req: Request, path: string) {
  return NextResponse.redirect(new URL(path, req.url), 303);
}

export async function POST(req: Request) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return new NextResponse("Site verrouillé", { status: 503 });

  const ip = clientIp(req);
  // A locked-out client is refused before the password is even looked at: guessing is pointless while locked
  if ((await lockStatus(ip)).locked) return redirect(req, "/login?e=locked");

  const form = await req.formData().catch(() => null);
  const submitted = form?.get("password");
  if (typeof submitted !== "string" || !(await passwordMatches(submitted, password))) {
    const { justLocked } = await recordFailure(ip);
    await new Promise((r) => setTimeout(r, 600));
    return redirect(req, justLocked ? "/login?e=locked" : "/login?e=1");
  }

  await recordSuccess(ip);
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
