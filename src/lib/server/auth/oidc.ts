// Server side of SSO: cached discovery and the short-lived sealed cookie that carries state, nonce and the PKCE
// verifier from /api/auth/oidc/start to /api/auth/oidc/callback.
import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { OIDC_COOKIE, safeNext } from "../../authn.ts";
import { discover, type Discovery } from "../../oidc.ts";
import { seal, unseal } from "../secrets.ts";
import { secureRequest } from "./config.ts";

const DISCOVERY_MS = 60 * 60_000;
const STATE_MS = 10 * 60_000;
let cached: { issuer: string; at: number; doc: Discovery } | undefined;

export async function discovery(issuer: string): Promise<Discovery> {
  if (cached && cached.issuer === issuer && Date.now() - cached.at < DISCOVERY_MS) return cached.doc;
  const doc = await discover(issuer);
  cached = { issuer, at: Date.now(), doc };
  return doc;
}

export interface FlowState {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  next: string;
  exp: number;
}

// AES-GCM sealed (secrets.ts): the browser can carry it but can neither read the verifier nor forge the state.
// Path-scoped to the SSO routes; Lax so it survives the top-level redirect back from the provider.
export function setFlowCookie(res: NextResponse, req: NextRequest, s: Omit<FlowState, "exp">) {
  res.cookies.set({ name: OIDC_COOKIE, value: seal(JSON.stringify({ ...s, exp: Date.now() + STATE_MS })), httpOnly: true, sameSite: "lax", secure: secureRequest(req), path: "/api/auth/oidc", maxAge: STATE_MS / 1000 });
}

export function clearFlowCookie(res: NextResponse, req: NextRequest) {
  res.cookies.set({ name: OIDC_COOKIE, value: "", httpOnly: true, sameSite: "lax", secure: secureRequest(req), path: "/api/auth/oidc", maxAge: 0 });
}

export function readFlowCookie(req: NextRequest): FlowState | null {
  const raw = req.cookies.get(OIDC_COOKIE)?.value;
  if (!raw) return null;
  try {
    const s = JSON.parse(unseal(raw)) as FlowState;
    if (typeof s.exp !== "number" || s.exp < Date.now() || typeof s.state !== "string" || typeof s.nonce !== "string" || typeof s.verifier !== "string") return null;
    return { ...s, next: safeNext(s.next) };
  } catch {
    return null; // tampered, sealed with an old key, or garbage
  }
}
