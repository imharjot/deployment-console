import { handle, ipOf, json, readJson, userOf } from "@/lib/server/http";
import { runAction } from "@/lib/server/inventory-actions";

// Run a provider action on a cloud-map resource: { key, provider, action, input, confirm?, reason?, dryRun? }.
// A dry run (`"dryRun": true` or `?dryRun=1`; anything but an explicit false counts) returns { plan } whose `confirm`
// is the text to send; a run returns 202 { result, operationId }. Roles, protection (read live right before the change),
// typed confirmations, the mutation coordinator's lock and operation record, and the audit log are applied in
// src/lib/server/inventory-actions.ts (shared with cloud.action). Errors carry `code` and `operationId` when the
// coordinator refused or lost track ("outcome unknown — check the resource before retrying").
// CSRF is checked by the proxy. Body cap 12 MB: a Lambda deploy may carry a zip as base64 (`zipBase64`, ≤ 8 MB of
// zip ≈ 10.7 MB of base64); larger packages go through an S3 object instead.
const MAX_BODY = 12_000_000;

export const POST = handle(async (req) => {
  const user = userOf(req);
  const body = await readJson(req, MAX_BODY);
  const r = await runAction(body, { user, actor: user.email, ip: ipOf(req), via: "map" }, req.nextUrl.searchParams.get("dryRun"));
  return "plan" in r ? json(r) : json(r, 202);
});
