// Runs before every page and API route (except Next's own assets, favicon and /api/healthz).
// 1. CSRF: every non-GET must carry x-console-csrf and a same-host Origin — cookies ride along automatically.
// 2. Identity (AUTH_MODE): session cookie (default), the ALB's signed OIDC header, or the local dev user.
// 3. Unauthenticated: pages → /login?next=… (or /setup on first run), APIs → 401 JSON.
// 4. Client-sent x-console-user* headers are dropped, then set from the verified identity for route handlers.
// 5. Agents: `Authorization: Bearer dc_…` is an API token, `Bearer da_…` an agent token (a run's own, or an external
//    agent's). Such a request is judged on the token alone — cookies are removed, so it can never borrow a browser
//    session — and it is exempt from the CSRF check, which exists because cookies ride along automatically; a bearer
//    header never does. Tokens reach only the operations API (tokenRoute), never pages, users, tokens, integrations,
//    settings, variable values or approval decisions. Agent tokens are refused (503) while agents are turned off.
// 0. Before all of that, AUTH_MODE=dev answers only requests addressed to a loopback host (Host, X-Forwarded-Host and
//    Forwarded host=): dev makes every caller an admin, so a LAN client or a DNS-rebinding page gets 403 (F02).
import { NextResponse, type NextRequest } from "next/server";
import { safeNext, sessionCookie } from "@/lib/authn";
import { API_TOKENS_OFF, apiTokensEnabled, bearerToken, isAgentBearer, tokenRoute } from "@/lib/automation";
import { devHostProblem } from "@/lib/dev-host";
import { authConfig, authMode, publicOrigin, secureRequest } from "@/lib/server/auth/config";
import { resolveAgentTokenIdentity, resolveIdentity, resolveTokenIdentity } from "@/lib/server/auth/resolve";

// Reachable without a session. Every /api/auth route checks what it needs itself (login, logout, setup, invite, SSO).
const PUBLIC_PAGE = /^\/(login|setup|invite\/[^/]+)\/?$/;
const isPublic = (path: string) => PUBLIC_PAGE.test(path) || path.startsWith("/api/auth/");

const esc = (s: string) => s.replace(/[<>&"']/g, "");

function deny(req: NextRequest, status: number, error: string) {
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
  const title = status === 403 ? "Not allowed" : status === 401 ? "Sign-in required" : status === 503 ? "Console unavailable" : "Console misconfigured";
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:15px system-ui;background:#090b0f;color:#e7eaf0;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box"><div style="max-width:440px"><h1 style="font-size:20px;margin:0 0 8px">${title}</h1><p style="color:#a3adbd;line-height:1.5;margin:0">${esc(error)}</p></div>`;
  return new NextResponse(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// With CONSOLE_PUBLIC_URL set (recommended in production) the Origin must be exactly that origin — no request header
// decides it. Without it, the request's own host (X-Forwarded-Host from a proxy, else Host) is the reference; a
// client could spoof those, but it can't make a browser send the x-console-csrf header cross-site anyway.
function sameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const pub = authConfig().publicUrl;
    if (pub) return o.origin === new URL(pub).origin;
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return !!host && o.host === host;
  } catch {
    return false;
  }
}

const OURS = ["x-console-user", "x-console-auth", "x-console-token", "x-console-agent"];
const stripOurs = (headers: Headers) => {
  for (const k of [...headers.keys()]) if (OURS.some((p) => k.startsWith(p))) headers.delete(k);
};

async function agentTokenRequest(req: NextRequest, path: string, token: string) {
  const route = tokenRoute(req.method, path, "agent");
  if (!route.ok) return deny(req, 403, route.error);
  let id: Awaited<ReturnType<typeof resolveAgentTokenIdentity>>;
  try {
    id = await resolveAgentTokenIdentity(req, token);
  } catch (e) {
    console.error(JSON.stringify({ level: 50, msg: "agent token lookup failed", path, err: String((e as Error)?.message ?? e) }));
    return deny(req, 503, "The console database is unavailable. Try again shortly.");
  }
  if (id.kind === "deny") {
    const res = deny(req, id.status, id.error);
    if (id.retryAfterMs) res.headers.set("Retry-After", String(Math.ceil(id.retryAfterMs / 1000)));
    if (id.status === 401) res.headers.set("WWW-Authenticate", 'Bearer realm="deployment-console"');
    return res;
  }
  const headers = new Headers(req.headers);
  stripOurs(headers);
  headers.delete("cookie");
  headers.set("x-console-user-id", id.user.id);
  headers.set("x-console-user-email", id.user.email);
  headers.set("x-console-user-role", id.user.role);
  headers.set("x-console-auth-via", "agent");
  headers.set("x-console-agent-principal", id.token.id); // opaque: the registry loads the principal by it
  headers.set("x-console-agent-run", id.token.runId);
  // An external agent's token name (printable ASCII only, tokenNameProblem) goes into the audit actor; a run's own
  // token has no name of its own — the actor already names the run.
  if (id.token.kind === "external") headers.set("x-console-agent-token-name", id.token.name);
  return NextResponse.next({ request: { headers } });
}

async function tokenRequest(req: NextRequest, path: string, token: string) {
  if (isAgentBearer(token)) return agentTokenRequest(req, path, token);
  if (!apiTokensEnabled()) return deny(req, 403, API_TOKENS_OFF);
  const route = tokenRoute(req.method, path);
  if (!route.ok) return deny(req, 403, route.error);
  let id: Awaited<ReturnType<typeof resolveTokenIdentity>>;
  try {
    id = await resolveTokenIdentity(req, token);
  } catch (e) {
    console.error(JSON.stringify({ level: 50, msg: "token lookup failed", path, err: String((e as Error)?.message ?? e) }));
    return deny(req, 503, "The console database is unavailable. Try again shortly.");
  }
  if (id.kind === "deny") {
    const res = deny(req, id.status, id.error);
    if (id.retryAfterMs) res.headers.set("Retry-After", String(Math.ceil(id.retryAfterMs / 1000)));
    if (id.status === 401) res.headers.set("WWW-Authenticate", 'Bearer realm="deployment-console"');
    return res;
  }
  const headers = new Headers(req.headers);
  stripOurs(headers);
  headers.delete("cookie");
  headers.set("x-console-user-id", id.user.id);
  headers.set("x-console-user-email", id.user.email);
  headers.set("x-console-user-role", id.user.role);
  headers.set("x-console-auth-via", "token");
  headers.set("x-console-token-id", id.token.id);
  headers.set("x-console-token-name", id.token.name); // printable ASCII only (tokenNameProblem)
  headers.set("x-console-token-mode", id.token.mode);
  return NextResponse.next({ request: { headers } });
}

const redirect = (req: NextRequest, to: string) => NextResponse.redirect(new URL(to, publicOrigin(req)), { headers: { "Cache-Control": "no-store" } });

export async function proxy(req: NextRequest) {
  const { pathname: path, search } = req.nextUrl;
  const api = path.startsWith("/api/");
  const open = isPublic(path);
  const read = req.method === "GET" || req.method === "HEAD";

  // Ahead of the bearer and identity branches: in dev mode nothing else may run for a non-loopback host.
  const mode = authMode();
  if (mode.ok && mode.mode === "dev") {
    const problem = devHostProblem((name) => req.headers.get(name));
    if (problem) return deny(req, 403, problem);
  }

  const bearer = bearerToken(req.headers.get("authorization"));
  if (bearer !== null) return tokenRequest(req, path, bearer);

  if (!read && (req.headers.get("x-console-csrf") !== "1" || !sameOrigin(req))) return deny(req, 403, "cross-site request refused");

  let id: Awaited<ReturnType<typeof resolveIdentity>>;
  try {
    id = await resolveIdentity(req, open);
  } catch (e) {
    console.error(JSON.stringify({ level: 50, msg: "identity lookup failed", path, err: String((e as Error)?.message ?? e) }));
    return deny(req, 503, "The console database is unavailable. Try again shortly.");
  }
  if (id.kind === "deny") return deny(req, id.status, id.error);

  const headers = new Headers(req.headers);
  stripOurs(headers);

  if (id.kind === "anon") {
    if (!open) {
      if (id.setup) return api ? deny(req, 401, "first-run setup required: open /setup") : redirect(req, "/setup");
      if (api) return deny(req, 401, "not signed in");
      return redirect(req, path === "/" ? "/login" : `/login?next=${encodeURIComponent(path + search)}`);
    }
    // ALB first run: /setup may only create an admin for the identity the load balancer verified.
    if (id.verifiedEmail) headers.set("x-console-user-verified-email", id.verifiedEmail);
    return NextResponse.next({ request: { headers } });
  }

  // Already signed in: the sign-in pages have nothing to do.
  if (read && (path === "/login" || path === "/setup")) return redirect(req, safeNext(req.nextUrl.searchParams.get("next")));

  headers.set("x-console-user-id", id.user.id);
  headers.set("x-console-user-email", id.user.email);
  headers.set("x-console-user-role", id.user.role);
  headers.set("x-console-auth-via", id.via);
  const res = NextResponse.next({ request: { headers } });
  if (id.renew) res.cookies.set(sessionCookie(id.renew.token, secureRequest(req), id.renew.until - Date.now()));
  return res;
}

export const config = {
  matcher: ["/((?!_next/|favicon\\.ico$|icon\\.svg$|api/healthz$).*)"],
};
