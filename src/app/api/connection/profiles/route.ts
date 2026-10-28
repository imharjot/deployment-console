// Settings → AWS connection → AWS CLI profile → Add a profile (src/lib/server/connection.ts). People only, admins only,
// and only on a console run locally by one person (AUTH_MODE=dev).
// POST { name, accessKeyId, secretAccessKey } → { name, identity: { account, arn } }: the key, once AWS accepts it, is
// appended to this machine's AWS credentials file as a new profile, the way `aws configure` does. 400 for a key AWS
// refuses or a root user's; 403 off a local console; 409 for a name already taken, or when an environment variable
// pins the account or the sign-in. The secret is never returned, logged or kept by the console.
import { addProfile } from "@/lib/server/connection";
import { handle, json, readJson, requirePerm } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const POST = handle(async (req) => {
  const c = personOf(req);
  requirePerm(c.user, "admin");
  return json(await addProfile(await readJson(req), { email: c.user.email, ip: c.ip }));
});
