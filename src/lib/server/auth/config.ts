// Auth configuration from the environment. Read per call (cheap) so a dev .env reload is picked up.
import "server-only";
import type { NextRequest } from "next/server";
import { isSecure, readAuthConfig, resolveAuthMode, type AuthConfig } from "../../authn.ts";
import { devHostProblem } from "../../dev-host.ts";
import { HttpError } from "../errors.ts";

export const authMode = () => resolveAuthMode(process.env);

// Logged once per process (the first request reads the config): misconfiguration, and session/alb without
// CONSOLE_PUBLIC_URL — then the proxy's same-origin check and every link the console builds trust the Host header.
let warned = false;
export function authConfig(): AuthConfig {
  const c = readAuthConfig(process.env);
  if (!warned) {
    warned = true;
    for (const p of c.problems) console.warn(`[deployment-console] auth config: ${p}`);
    const m = authMode();
    if (m.ok && m.mode !== "dev" && !c.publicUrl)
      console.warn(
        `[deployment-console] auth config: AUTH_MODE=${m.mode} without CONSOLE_PUBLIC_URL — the allowed origin for changes, sign-in redirects and invite links follow the request's Host header. Set CONSOLE_PUBLIC_URL to the URL people use.`,
      );
  }
  return c;
}

// OIDC_REQUIRE_EMAIL_VERIFIED (default true): an id_token whose email isn't verified — email_verified absent counts as
// unverified — can't sign in. Only "false" turns it off (a provider that never sends the claim and that you trust).
export const oidcRequireVerified = () => (process.env.OIDC_REQUIRE_EMAIL_VERIFIED ?? "").trim().toLowerCase() !== "false";

// F02 defence in depth for the routes that mint lasting credentials (a first password, an API token): in dev mode the
// request must name a loopback host. The proxy already refuses anything else; this holds even if a matcher changes.
export function assertDevLoopback(req: NextRequest) {
  const m = authMode();
  if (!m.ok || m.mode !== "dev") return;
  const problem = devHostProblem((name) => req.headers.get(name));
  if (problem) throw new HttpError(403, problem);
}

export interface LoginMethods {
  password: boolean;
  sso: { label: string } | null;
}

// What the login page offers. Behind an ALB the load balancer does the sign-in, so the console offers none.
export function loginMethods(): LoginMethods {
  const m = authMode();
  if (!m.ok || m.mode === "alb") return { password: false, sso: null };
  const c = authConfig();
  return { password: c.passwordLogin, sso: c.oidc ? { label: c.oidc.label } : null };
}

// The origin users reach us on: CONSOLE_PUBLIC_URL, else what the request says (fine for local and single-proxy setups).
export function publicOrigin(req: NextRequest): string {
  const c = authConfig();
  if (c.publicUrl) return c.publicUrl;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  return `${proto}://${host}`;
}

export const secureRequest = (req: NextRequest) =>
  isSecure({ publicUrl: authConfig().publicUrl, forwardedProto: req.headers.get("x-forwarded-proto"), protocol: req.nextUrl.protocol });
