// Model connections (master plan §3.5; people only). GET → { connections, endpoints, providers, policy, admin }: the
// caller's own connections, the organisation's and (with the simulated account) the built-in demo, never a secret;
// admins add ?all=1 for everyone's (to revoke a leaver's). POST { provider, authKind, label, scope?, model?, endpoint?,
// region?, backgroundOk?, minRole?, secret? } → 201 { connection }: the secret is write-only. PUT (admin)
// { endpoints?, policy? } → { endpoints, policy }: the registry of custom model endpoints (settings agents:endpoints)
// and the organisation's connection policy. Errors are { error, code? }.
import { create, listFor, personFrom, settings } from "@/lib/server/agents/connections";
import { handle, json, readJson } from "@/lib/server/http";

export const GET = handle(async (req) => json(await listFor(personFrom(req), { all: req.nextUrl.searchParams.get("all") === "1" })));

export const POST = handle(async (req) => {
  const actor = personFrom(req);
  return json({ connection: await create(actor, await readJson(req, 16_000)) }, 201);
});

export const PUT = handle(async (req) => {
  const actor = personFrom(req);
  return json(await settings(actor, await readJson(req, 64_000)));
});
