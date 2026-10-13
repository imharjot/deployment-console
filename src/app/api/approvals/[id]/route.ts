// One approval request. GET: people, or the token (or agent run) that asked. POST { decision, reason?, confirm?,
// migrationAck? }: people only, with the operation's permission; approving a token's request runs the operation as the
// approver, approving an agent's queues it on the agent's run under an exact-plan grant (see decide()).
import { handle, json } from "@/lib/server/http";
import { decide, getApprovalView } from "@/lib/server/ops";
import { agentCallerOf, personOf, readBody, withProblems } from "@/lib/server/ops/caller";

export const GET = handle<RouteContext<"/api/approvals/[id]">>(async (req, ctx) => {
  const c = await agentCallerOf(req);
  return json({ approval: await getApprovalView((await ctx.params).id, c) });
});

export const POST = handle<RouteContext<"/api/approvals/[id]">>(async (req, ctx) =>
  withProblems(async () => {
    const c = personOf(req);
    return json(await decide((await ctx.params).id, await readBody(req, 10_000), c));
  }),
);
