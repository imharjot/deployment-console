// ChatGPT plan: what the Connections screen needs before a sign-in — the eligibility notes, the usage-controls link and
// whether this browser reached the console on the loopback address the sign-in must return to. 404 unless
// CONSOLE_CHATGPT_PLAN=eligible. Never a token, never a remaining quota (the console can't read one).
import { CHATGPT_START_PATH, CHATGPT_USAGE_URL, ELIGIBILITY_NOTE } from "@/lib/agents/chatgpt/info";
import { requestOrigin, requireChatgptPlan } from "@/lib/server/agents/chatgpt-plan";
import { handle, json } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  requireChatgptPlan();
  personOf(req);
  const o = requestOrigin(req);
  return json({
    enabled: true,
    eligibility: ELIGIBILITY_NOTE,
    usageUrl: CHATGPT_USAGE_URL,
    startPath: CHATGPT_START_PATH,
    loopback: o.loopbackName,
    // The sign-in returns to http://127.0.0.1:<port>; a person on localhost is sent there first.
    signInOrigin: o.loopbackName && o.port ? `http://127.0.0.1:${o.port}` : null,
  });
});
