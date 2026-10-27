// Settings → AWS connection (src/lib/server/connection.ts). People only, admins only.
// GET → what the console reads and how it signs in, what decides each part (an environment variable, the config file,
// Settings or the default), the AWS profiles this console can see by name, and who AWS says the connection is.
// PUT { source: "mock" } | { source: "aws", signIn?, home?, regions? } → switches at once, audited. 400 when AWS
// doesn't accept the new sign-in, 409 when an environment variable decides that part or changes are still running.
import { connectionView, saveConnection } from "@/lib/server/connection";
import { handle, json, readJson, requirePerm } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  requirePerm(personOf(req).user, "admin");
  return json(await connectionView());
});

export const PUT = handle(async (req) => {
  const c = personOf(req);
  requirePerm(c.user, "admin");
  return json(await saveConnection(await readJson(req), { email: c.user.email, ip: c.ip }));
});
