// ChatGPT plan sign-in, step 2: the state (and that the same person started it), the issued client registration, the
// code exchanged with the PKCE verifier, the ID token verified (signature, issuer, audience, expiry, nonce) and the
// plan scope granted; then the connection is created (or signed in again) with its tokens sealed by the credential
// broker and bound to the ChatGPT subject and client registration. Always back to Automation → Connections with a
// result code. 404 unless CONSOLE_CHATGPT_PLAN=eligible.
import { NextResponse } from "next/server";
import { auditSignInFailure, automationUrl, clearFlowCookie, finishSignIn, readFlowCookie, requireChatgptPlan, signInErrorCode } from "@/lib/server/agents/chatgpt-plan";
import { handle } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  requireChatgptPlan();
  const c = personOf(req);
  let res: NextResponse;
  try {
    const r = await finishSignIn(req.nextUrl.searchParams, readFlowCookie(req), c.user, c.ip);
    res = NextResponse.redirect(automationUrl(req, r.created ? "connected" : "reconnected"), 302);
  } catch (e) {
    await auditSignInFailure(c.user, e, c.ip);
    res = NextResponse.redirect(automationUrl(req, signInErrorCode(e)), 302);
  }
  res.headers.set("Cache-Control", "no-store");
  clearFlowCookie(res, req);
  return res;
});
