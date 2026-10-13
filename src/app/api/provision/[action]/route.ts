import { HttpError } from "@/lib/server/errors";
import { handle, ipOf, json, readJson, userOf } from "@/lib/server/http";
import { PROVISION } from "@/lib/server/provision";

// Create & scale: POST /api/provision/<clone | scale | run-task | add-host | delete-service | terminate-host> with the
// body described in docs/provisioning.md. `?dryRun=1` (or `"dryRun": true`) returns the plan — changes, warnings, a
// cost estimate and the confirmation a run needs — without calling AWS. Roles, guards, the mutation coordinator
// (409 while another change holds the service or the cluster's hosts) and the audit log are applied in
// src/lib/server/provision.ts, shared with the agent operations. A run answers 202 with the operation id.
export const POST = handle<RouteContext<"/api/provision/[action]">>(async (req, ctx) => {
  const user = userOf(req);
  const { action } = await ctx.params;
  const op = Object.hasOwn(PROVISION, action) ? PROVISION[action] : undefined;
  if (!op) throw new HttpError(404, `unknown provisioning action "${action}" (${Object.keys(PROVISION).join(", ")})`);
  const body = await readJson(req);
  // Fail safe: any dryRun other than an explicit false/0 means "plan only" — a typo must never run the real thing.
  const off = (v: unknown) => v === undefined || v === null || v === false || v === 0 || v === "false" || v === "0";
  const q = req.nextUrl.searchParams.get("dryRun");
  const dry = !off(q) || (!!body && typeof body === "object" && !off((body as { dryRun?: unknown }).dryRun));
  const who = { user, actor: user.email, ip: ipOf(req) };
  return dry ? json(await op.plan(body, who)) : json(await op.run(body, who), 202);
});
