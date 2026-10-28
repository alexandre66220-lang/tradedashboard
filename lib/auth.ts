// Shared by proxy.ts and the login route. Uses Web Crypto only.

export const SESSION_COOKIE = "dash_session";
export const SESSION_MAX_AGE = 30 * 24 * 3600;

const encoder = new TextEncoder();

export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, encoder.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cookie value derived from DASHBOARD_PASSWORD: changing the password invalidates every session. */
export function sessionToken(password: string): Promise<string> {
  return hmacHex(password, "market-dashboard/session/v1");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Compares a submitted password without leaking its length or content through timing. */
export async function passwordMatches(submitted: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmacHex("pw-compare", submitted), hmacHex("pw-compare", expected)]);
  return timingSafeEqualStr(a, b);
}

export async function isValidSession(cookie: string | undefined, password: string): Promise<boolean> {
  if (!cookie) return false;
  return timingSafeEqualStr(cookie, await sessionToken(password));
}
