// SSO step 1: send the browser to the provider with state, nonce and a PKCE challenge (kept in a sealed cookie).
import { NextResponse } from "next/server";
import { safeNext } from "@/lib/authn";
import { authorizeUrl, pkcePair, randomValue } from "@/lib/oidc";
import { authConfig, loginMethods, publicOrigin } from "@/lib/server/auth/config";
import { discovery, setFlowCookie } from "@/lib/server/auth/oidc";
import { handle } from "@/lib/server/http";

export const GET = handle(async (req) => {
  const origin = publicOrigin(req);
  const o = authConfig().oidc;
  if (!o || !loginMethods().sso) return NextResponse.redirect(new URL("/login?error=sso_off", origin));
  try {
    const d = await discovery(o.issuer);
    const { verifier, challenge } = pkcePair();
    const flow = { state: randomValue(), nonce: randomValue(), verifier, redirectUri: `${origin}/api/auth/oidc/callback`, next: safeNext(req.nextUrl.searchParams.get("next")) };
    const res = NextResponse.redirect(authorizeUrl(d, { clientId: o.clientId, redirectUri: flow.redirectUri, scope: o.scopes, state: flow.state, nonce: flow.nonce, challenge }));
    res.headers.set("Cache-Control", "no-store");
    setFlowCookie(res, req, flow);
    return res;
  } catch (e) {
    console.error(JSON.stringify({ level: 50, msg: "sso start failed", err: String((e as Error)?.message ?? e) }));
    return NextResponse.redirect(new URL("/login?error=sso_unavailable", origin));
  }
});
