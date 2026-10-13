// The last step of every sign-in (password, first-run setup, invite/reset link, SSO).
import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { audit } from "./audit.ts";
import { authConfig } from "./config.ts";
import { createSession, deleteSession, sessionIdOf, setSessionCookie } from "./sessions.ts";
import { touchLogin } from "./users.ts";

// Always a fresh random token (no session fixation), replacing whatever session this browser held before;
// stamps the last sign-in, writes the audit row, and puts the cookie on `res`.
export async function signIn<R extends NextResponse>(req: NextRequest, res: R, user: { id: string; email: string }, method: string, ip?: string, extra?: Record<string, unknown>): Promise<R> {
  const ttl = authConfig().ttlMs;
  const previous = sessionIdOf(req);
  if (previous) await deleteSession(previous);
  const token = await createSession(user.id, ttl, { ip, userAgent: req.headers.get("user-agent") });
  await touchLogin(user.id);
  await audit({ action: "auth.login", actor: user.email, target: user.email, ip, params: { method, ...extra } });
  setSessionCookie(res, req, token, ttl);
  return res;
}
