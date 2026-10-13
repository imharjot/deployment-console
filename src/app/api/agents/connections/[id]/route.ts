// One model connection (people only). GET → { connection }. PATCH { label?, model?, backgroundOk?, minRole?, secret? }
// → { connection }: a secret rotates the credential (write-only, never returned). DELETE { reason? } → { connection,
// pausedRuns }: disconnects it — runs waiting on it pause (paused_auth) and never switch to another connection; the
// sealed credential is deleted and `revokeConfirmed` says whether the provider confirmed a sign-out. The built-in demo
// connection can't be changed or disconnected.
import { personFrom, revoke, update, view } from "@/lib/server/agents/connections";
import { handle, json, readJson } from "@/lib/server/http";

export const GET = handle<RouteContext<"/api/agents/connections/[id]">>(async (req, ctx) => json({ connection: await view(personFrom(req), (await ctx.params).id) }));

export const PATCH = handle<RouteContext<"/api/agents/connections/[id]">>(async (req, ctx) => {
  const actor = personFrom(req);
  return json({ connection: await update(actor, (await ctx.params).id, await readJson(req, 16_000)) });
});

export const DELETE = handle<RouteContext<"/api/agents/connections/[id]">>(async (req, ctx) => {
  const actor = personFrom(req);
  return json(await revoke(actor, (await ctx.params).id, await readJson(req, 2_000)));
});
