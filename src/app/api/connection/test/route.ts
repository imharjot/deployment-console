// Settings → AWS connection's "Test connection" (src/lib/server/connection.ts). People only, admins only. Body: like
// PUT /api/connection. → { ok, identity: { account, arn }, regions: [{ region, clusters, more?, error? }],
// suggestedHome?, problems?, error? }: who the candidate signs in as and how many ECS clusters each enabled region has,
// read with its own clients. Changes nothing.
import { testConnection } from "@/lib/server/connection";
import { handle, json, readJson, requirePerm } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const POST = handle(async (req) => {
  requirePerm(personOf(req).user, "admin");
  return json(await testConnection(await readJson(req)));
});
