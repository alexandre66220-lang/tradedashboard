import { describe, expect, it } from "vitest";
import { readJson, unexpectedResponse } from "@/lib/readJson";

describe("readJson", () => {
  it("returns the body, or null when it is not JSON (a gateway error page, an empty answer)", async () => {
    expect(await readJson<{ a: number }>(new Response('{"a":1}'))).toEqual({ a: 1 });
    expect(await readJson(new Response("<html>Gateway Timeout</html>", { status: 504 }))).toBeNull();
    expect(await readJson(new Response(null, { status: 502 }))).toBeNull();
  });

  it("names the HTTP status, and says so when the server was too slow", () => {
    expect(unexpectedResponse(new Response("x", { status: 504 })).message).toMatch(/trop de temps.*504/);
    expect(unexpectedResponse(new Response("x", { status: 500 })).message).toMatch(/inattendue.*500/);
  });
});
