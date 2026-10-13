// Model Context Protocol endpoint (Streamable HTTP, plain JSON responses, stateless): lets Claude Desktop, Claude Code
// or any MCP client drive the console with an API token (dc_) or an agent token (da_: a run's embedded CLI, or an
// external agent from the Connect screen). tools/list shows only what the token may call (an agent's: what its policy
// allows); tools/call goes through the same registry as POST /api/ops/<name> (validation, role, mode gate or policy,
// approvals, audit).
import { handleMcp } from "@/lib/mcp";
import { checkRunTools } from "@/lib/server/agents/tools";
import { toMcpTool } from "@/lib/ops-schema";
import { limits } from "@/lib/server/auth/limits";
import { HttpError } from "@/lib/server/errors";
import { handle, json } from "@/lib/server/http";
import { callTool, toolSourcesFor } from "@/lib/server/ops";
import { agentCallerOf, callerOf } from "@/lib/server/ops/caller";

export const POST = handle(async (req) => {
  const first = callerOf(req);
  if (first.via !== "token" && first.via !== "agent") throw new HttpError(401, "the MCP endpoint needs an API or agent token: Authorization: Bearer dc_… or da_…");
  const c = first.via === "agent" ? await agentCallerOf(req) : first;
  const text = await req.text();
  if (text.length > 256 * 1024) throw new HttpError(413, "body too large");
  // The proxy counted this request once against the token's rate limit; every further tool call in a batch counts too.
  let calls = 0;
  const r = await handleMcp(text, {
    // A run's own token must see the tools its run started with (AGENT_ARCHITECTURE §9.4): changed → the run stops.
    tools: async () => {
      if (c.via === "agent") await checkRunTools(c);
      return toolSourcesFor(c).map(toMcpTool);
    },
    call: (name, args) => {
      if (++calls > 1 && c.tokenId) {
        if (limits.apiToken.retryIn(c.tokenId)) throw new HttpError(429, `rate limit: ${limits.apiToken.max} calls per minute per token`, limits.apiToken.retryIn(c.tokenId));
        limits.apiToken.fail(c.tokenId);
      }
      return callTool(name, args, c);
    },
  });
  return r.body === undefined ? new Response(null, { status: r.status, headers: { "Cache-Control": "no-store" } }) : json(r.body, r.status);
});

// No server-initiated stream and no sessions to end.
const notAllowed = () => new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
export const GET = notAllowed;
export const DELETE = notAllowed;
