import { HttpError } from "@/lib/server/errors";
import { handle, json, requirePerm, userOf } from "@/lib/server/http";
import { listActions } from "@/lib/server/inventory-actions";

// Actions that apply to one resource, with `allowed` (this caller's role on this resource's protection), `blocked`
// (why it can't run right now — including an AWS permission the console's identity lacks) and `note` (a permission
// that is probably missing, or tags that weren't read). Run one with POST /api/inventory/action.
export const GET = handle(async (req) => {
  const user = userOf(req);
  requirePerm(user, "view");
  const key = req.nextUrl.searchParams.get("key");
  if (!key || key.length > 2048) throw new HttpError(400, "key is required (a resource key from GET /api/inventory)");
  return json({ actions: await listActions(key, user) });
});
