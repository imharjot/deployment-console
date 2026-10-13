// External agent tokens (master plan §3.5; people only — the proxy never lets a token reach this). GET → { tokens }:
// your own (admins: ?all=1 for everyone's), never the token itself. POST { name, definitionId, days: 7 | 30 | 90 } →
// 201 { token /* shown once */, id, runId, expiresAt, mcpUrl }: an agent token bound to an agent definition's policy
// (or a built-in template's, by name), with its own run record of kind "external". Errors are { error, code? }.
import { assertDevLoopback, publicOrigin } from "@/lib/server/auth/config";
import { listAgentTokens, mintExternalToken } from "@/lib/server/auth/agent-tokens";
import { HttpError } from "@/lib/server/errors";
import { handle, json, readJson, requirePerm } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  const c = personOf(req);
  const all = req.nextUrl.searchParams.get("all") === "1";
  if (all) requirePerm(c.user, "admin");
  return json({ tokens: await listAgentTokens(c.user, all) });
});

// A token outlives dev mode, so in dev it is only minted for a request addressed to a loopback host (F02).
export const POST = handle(async (req) => {
  assertDevLoopback(req);
  const c = personOf(req);
  const b = await readJson(req);
  if (b.name === undefined) throw new HttpError(400, "name is required");
  const t = await mintExternalToken(c.user, b.definitionId, b.days, { name: b.name, ip: c.ip });
  return json({ ...t, mcpUrl: `${publicOrigin(req)}/api/mcp` }, 201);
});
