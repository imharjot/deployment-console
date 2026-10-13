import { overview } from "@/lib/server/console";
import { envOf, handle, json, userOf } from "@/lib/server/http";
import { applyPerms } from "@/lib/server/identity";

// One environment: every tile with its state, per-tile fetchedAt, the overview's freshness, its region and the ECS
// operations still being verified (R21, REVIEW "accepted is not done").
export const GET = handle(async (req) => {
  const user = userOf(req);
  return json(await applyPerms(await overview(envOf(req.nextUrl.searchParams.get("env"))), user));
});
