import { HttpError } from "@/lib/server/errors";
import { handle, json, requirePerm, userOf } from "@/lib/server/http";
import { resourceDetail } from "@/lib/server/inventory";

// One resource's extra detail for its panel (the provider's detail() in the resource's own region, plus the activity
// series behind an idle mark). Slim rows (hidden and generic resources) also get the props the map didn't carry.
// External hosts have nothing to load; only the resource's own provider can fail the request (502).
// `prefix` / `token` browse inside a resource (S3 prefixes; the next token comes back in `page.next`). 404 when the
// key isn't on the map.
export const GET = handle(async (req) => {
  requirePerm(userOf(req), "view");
  const q = req.nextUrl.searchParams;
  const key = q.get("key");
  if (!key || key.length > 2048) throw new HttpError(400, "key is required (a resource key from GET /api/inventory)");
  const prefix = q.get("prefix") ?? undefined;
  const token = q.get("token") ?? undefined;
  if (prefix !== undefined && prefix.length > 1024) throw new HttpError(400, "prefix must be at most 1,024 characters");
  if (token !== undefined && token.length > 2048) throw new HttpError(400, "token must be at most 2,048 characters");
  return json(await resourceDetail(key, prefix !== undefined || token !== undefined ? { prefix, token } : undefined));
});
