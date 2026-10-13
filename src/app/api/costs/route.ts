import { costsView } from "@/lib/server/billing";
import { handle, json, requirePerm, userOf } from "@/lib/server/http";

// Spend (Cost Explorer snapshot, taken at most every few hours and only when someone looks) + the free run-rate
// estimate. Costs are sensitive: operator role and up (`costs`). Response: CostsView (src/lib/spend.ts).
export const GET = handle(async (req) => {
  requirePerm(userOf(req), "costs");
  return json(await costsView());
});
