// ChatGPT plan sign-in, step 1: PKCE S256, a fresh state and nonce, the installation host id, then a redirect to
// ChatGPT. ?connection=<id> signs in to an existing connection again (same account, same client registration). 404
// unless CONSOLE_CHATGPT_PLAN=eligible. The callback must be a loopback URL on 127.0.0.1, so a browser on localhost or
// [::1] is first sent to the same path on 127.0.0.1; any other host can't use this route.
import { NextResponse } from "next/server";
import { auditSignInFailure, automationUrl, requestOrigin, requireChatgptPlan, setFlowCookie, signInErrorCode, startSignIn } from "@/lib/server/agents/chatgpt-plan";
import { handle } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  requireChatgptPlan();
  const c = personOf(req);
  const o = requestOrigin(req);
  if (o.loopbackName && o.port && !o.host.startsWith("127.0.0.1:")) {
    const to = new URL(`http://127.0.0.1:${o.port}${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(to, 302);
  }
  const connection = req.nextUrl.searchParams.get("connection") ?? undefined;
  try {
    const { url, flow } = await startSignIn(c.user, o.origin, connection);
    const res = NextResponse.redirect(url, 302);
    res.headers.set("Cache-Control", "no-store");
    setFlowCookie(res, req, flow);
    return res;
  } catch (e) {
    await auditSignInFailure(c.user, e, c.ip);
    return NextResponse.redirect(automationUrl(req, signInErrorCode(e)), 302);
  }
});
