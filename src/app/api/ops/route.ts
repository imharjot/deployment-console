// The operations catalog for the caller (session, ALB, dev or API token). ?format=anthropic|openai|mcp returns
// ready-to-use tool definitions for the operations this caller may call.
import { TOOL_FORMATS, type ToolFormat } from "@/lib/ops-schema";
import { HttpError } from "@/lib/server/errors";
import { handle, json } from "@/lib/server/http";
import { listOps, toolsFor } from "@/lib/server/ops";
import { agentCallerOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  const c = await agentCallerOf(req);
  const format = req.nextUrl.searchParams.get("format");
  if (format !== null) {
    if (!TOOL_FORMATS.includes(format as ToolFormat)) throw new HttpError(400, `format must be one of ${TOOL_FORMATS.join(", ")}`);
    return json({ tools: toolsFor(c, format as ToolFormat) });
  }
  return json({
    caller: {
      email: c.user.email, role: c.user.role, via: c.via,
      ...(c.via === "token" ? { token: { id: c.tokenId, name: c.tokenName, mode: c.tokenMode } } : {}),
      ...(c.via === "agent" && c.principal ? { agent: { runId: c.principal.runId, mode: c.principal.mode, policyHash: c.principal.policyHash } } : {}),
    },
    operations: listOps(c),
  });
});
