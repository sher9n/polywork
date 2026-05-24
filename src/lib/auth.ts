// Bearer-token guard for mutating API routes. Read-only routes stay public
// so the dashboard works without login. Mutating routes (lab actions) must
// pass a token that matches POLYWORK_ADMIN_TOKEN.
//
// Returns null when the request is authorized. Returns a NextResponse the
// caller should return directly when the request is rejected.

import { NextResponse } from "next/server";

export function requireAdmin(req: Request): NextResponse | null {
  const expected = process.env.POLYWORK_ADMIN_TOKEN;
  if (!expected || expected.length < 16) {
    // Fail closed: refuse mutations entirely when no token is configured,
    // rather than silently allowing anonymous writes.
    return NextResponse.json(
      { error: "server misconfigured: POLYWORK_ADMIN_TOKEN not set or too short" },
      { status: 503 },
    );
  }
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  const provided = m ? m[1].trim() : "";
  if (!provided || !timingSafeEqual(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
