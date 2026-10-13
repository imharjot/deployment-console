import { NextResponse } from "next/server";
import { etagMatches } from "@/lib/inventory/vanish";
import { handle, requirePerm, userOf } from "@/lib/server/http";
import { inventoryPayload } from "@/lib/server/inventory";

// The cloud map: every resource, edge, environment and provider status (docs/cloud-map.md). Cached for 2 minutes;
// `?refresh=1` re-discovers everything (at most once per 20 s — otherwise the cached map is returned). Never carries
// environment values or other secrets: Mention refs stay inside the build.
// Hidden and generic rows are sent slim (`slim: true`, no props — the detail call loads them). The response carries a
// weak ETag per build (and per phase, and per note counts): a poll with If-None-Match gets 304 and no body (CC-17, F51).
// `private, no-cache` lets the browser keep the last copy and revalidate it every time; nothing here is secret.
const HEADERS = { "Cache-Control": "private, no-cache", Vary: "Cookie, Authorization" };

export const GET = handle(async (req) => {
  const user = userOf(req);
  requirePerm(user, "view");
  const refresh = /^(1|true|yes)$/i.test(req.nextUrl.searchParams.get("refresh") ?? "");
  // Forcing a full re-read of the account costs AWS API calls (and CloudWatch money): developers and up only.
  if (refresh) requirePerm(user, "act");
  const { etag, view } = await inventoryPayload({ refresh });
  if (etagMatches(req.headers.get("if-none-match"), etag)) return new NextResponse(null, { status: 304, headers: { ...HEADERS, ETag: etag } });
  return NextResponse.json(view(), { status: 200, headers: { ...HEADERS, ETag: etag } });
});
