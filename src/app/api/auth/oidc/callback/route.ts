// SSO step 2: check state, exchange the code (with the PKCE verifier), verify the id_token, map the email to a user,
// and check the account's bound SSO subject (F63: bound at the first SSO sign-in; a different subject is refused).
// Failures redirect to /login with a stable error code; provider detail goes to the log and the audit table only.
import { NextResponse, type NextRequest } from "next/server";
import { OidcError, exchangeCode, remoteKeys, sameValue, verifyIdToken } from "@/lib/oidc";
import { audit } from "@/lib/server/auth/audit";
import { authConfig, oidcRequireVerified, publicOrigin } from "@/lib/server/auth/config";
import { clearFlowCookie, discovery, readFlowCookie } from "@/lib/server/auth/oidc";
import { signIn } from "@/lib/server/auth/signin";
import { bindSubject, provision } from "@/lib/server/auth/users";
import { handle, ipOf } from "@/lib/server/http";

const ERROR_CODE: Record<OidcError["code"], string> = {
  discovery: "sso_unavailable",
  state: "sso_state",
  token: "sso_failed",
  id_token: "sso_failed",
  no_email: "sso_no_email",
  unverified: "sso_unverified",
  subject: "sso_mismatch",
};

function toLogin(req: NextRequest, code: string) {
  const res = NextResponse.redirect(new URL(`/login?error=${code}`, publicOrigin(req)));
  clearFlowCookie(res, req);
  return res;
}

export const GET = handle(async (req) => {
  const ip = ipOf(req);
  const o = authConfig().oidc;
  if (!o) return toLogin(req, "sso_off");
  const q = req.nextUrl.searchParams;
  if (q.get("error")) {
    await audit({ action: "auth.login_failed", actor: "(sso)", ip, result: "error", detail: `provider returned ${String(q.get("error")).slice(0, 80)}` });
    return toLogin(req, "sso_denied");
  }
  const flow = readFlowCookie(req);
  const code = q.get("code");
  if (!flow || !code || !sameValue(q.get("state"), flow.state)) return toLogin(req, "sso_state");

  try {
    const d = await discovery(o.issuer);
    const { id_token } = await exchangeCode(d, { code, verifier: flow.verifier, redirectUri: flow.redirectUri, clientId: o.clientId, clientSecret: o.clientSecret });
    const claims = await verifyIdToken(id_token, { issuer: d.issuer, clientId: o.clientId, nonce: flow.nonce, keys: remoteKeys(d.jwks_uri), requireVerified: oidcRequireVerified() });
    const p = await provision(claims.email, claims.name, "oidc", ip);
    if (!p.ok) {
      await audit({ action: "auth.login_failed", actor: claims.email, target: claims.email, ip, result: "error", detail: p.reason === "disabled" ? "disabled" : "not invited and domain not allowed" });
      return toLogin(req, p.reason === "disabled" ? "sso_disabled" : "sso_not_invited");
    }
    const bind = await bindSubject(p.row.id, claims.sub);
    if (!bind.ok) {
      const detail = bind.reason === "mismatch" ? "SSO subject differs from the one this account is bound to" : "SSO subject is already bound to another account";
      await audit({ action: "auth.login_failed", actor: claims.email, target: claims.email, ip, result: "error", detail, params: { method: "sso", sub: claims.sub } });
      return toLogin(req, ERROR_CODE.subject);
    }
    if (bind.bound) await audit({ action: "user.sso_bind", actor: claims.email, target: claims.email, ip, params: { sub: claims.sub } });
    const res = NextResponse.redirect(new URL(flow.next, publicOrigin(req)));
    res.headers.set("Cache-Control", "no-store");
    clearFlowCookie(res, req);
    return signIn(req, res, p.row, "sso", ip, { sub: claims.sub });
  } catch (e) {
    const err = e instanceof OidcError ? e : null;
    const detail = String((e as Error)?.message ?? e).slice(0, 300);
    console.error(JSON.stringify({ level: 50, msg: "sso callback failed", code: err?.code, err: detail }));
    await audit({ action: "auth.login_failed", actor: "(sso)", ip, result: "error", detail });
    return toLogin(req, err ? ERROR_CODE[err.code] : "sso_failed");
  }
});
