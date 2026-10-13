// Tests a model connection (people only, and only one they may use): POST → { ok, model?, models?, capabilities?,
// warnings?, runtime?, error?, errorKind? }. The provider's adapter validates the credential (a local runtime checks
// that its CLI is installed); a failure is ok: false with the error scrubbed of the secret and of anything that looks
// like a credential. Someone else's personal connection is 403 before anything is opened.
import { personFrom, test } from "@/lib/server/agents/connections";
import { handle, json } from "@/lib/server/http";

export const POST = handle<RouteContext<"/api/agents/connections/[id]/test">>(async (req, ctx) => json(await test(personFrom(req), (await ctx.params).id)));
