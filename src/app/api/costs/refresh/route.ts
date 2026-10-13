import { refreshCosts } from "@/lib/server/billing";
import { handle, ipOf, json, requirePerm, userOf } from "@/lib/server/http";

// Take a new Cost Explorer snapshot now. Each one is a few billed requests (~$0.04), so it's limited to one per
// 5 minutes across all users (429 otherwise) and audited. Body: none. Response: CostsView.
export const POST = handle(async (req) => {
  const user = userOf(req);
  requirePerm(user, "costs");
  return json(await refreshCosts(user.email, ipOf(req)));
});
