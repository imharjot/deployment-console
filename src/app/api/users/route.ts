// Users admin: list and invite. Admin role only.
import { cleanName, normalizeEmail } from "@/lib/authn";
import { isRole } from "@/lib/rbac";
import { inviteUser, listUserItems } from "@/lib/server/auth/admin";
import { publicOrigin } from "@/lib/server/auth/config";
import { HttpError } from "@/lib/server/errors";
import { handle, ipOf, json, readJson, requirePerm, userOf } from "@/lib/server/http";

export const GET = handle(async (req) => {
  requirePerm(userOf(req), "admin");
  return json(await listUserItems());
});

export const POST = handle(async (req) => {
  const actor = userOf(req);
  requirePerm(actor, "admin");
  const b = await readJson(req);
  const email = normalizeEmail(b.email);
  if (!email) throw new HttpError(400, "Enter a valid email address.");
  if (!isRole(b.role)) throw new HttpError(400, "role must be viewer, developer, operator or admin");
  return json(await inviteUser(actor, { email, role: b.role, name: cleanName(b.name) }, ipOf(req), publicOrigin(req)), 201);
});
