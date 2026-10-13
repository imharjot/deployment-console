// The models a connection offers (people only, and only for a connection they may use): GET ?connection=<id> →
// { models: { id, label, capabilities }[] }. A local runtime picks its own model (an empty list). A provider failure is
// 502 with the error scrubbed.
import { models, personFrom } from "@/lib/server/agents/connections";
import { handle, json } from "@/lib/server/http";

export const GET = handle(async (req) => json(await models(personFrom(req), req.nextUrl.searchParams.get("connection") ?? "")));
