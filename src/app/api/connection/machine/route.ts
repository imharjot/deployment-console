// Settings → AWS connection: who the machine's own login (the SDK's default chain: an ECS task role, an EC2 instance
// profile, ~/.aws's default profile) signs in as, shown beside that choice (src/lib/server/connection.ts). People only,
// admins only. → { identity: { account, arn } } or { error } when the machine has none or AWS refuses it; 409 when an
// environment variable pins the account or the sign-in. Changes nothing.
import { machineLogin } from "@/lib/server/connection";
import { handle, json, requirePerm } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  requirePerm(personOf(req).user, "admin");
  return json(await machineLogin());
});
