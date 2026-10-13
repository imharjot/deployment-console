import { capabilityView, refreshCapability, watchActions } from "@/lib/server/capability";
import { handle, json, requirePerm, userOf } from "@/lib/server/http";
import { PROVIDERS } from "@/lib/server/providers";

// What the console's AWS identity may change (audit C5): the IAM policy simulation (refreshed at most every 10 minutes,
// and when new actions are watched; never throws) plus what real calls taught us. Covers the console's own writes and
// every cloud-map provider's declared write actions. Action names and states only — no ARNs, no secrets.
export const GET = handle(async (req) => {
  requirePerm(userOf(req), "view");
  watchActions(PROVIDERS.flatMap((p) => [...(p.write ?? []), ...(p.actions ?? []).flatMap((a) => a.iam ?? [])]));
  await refreshCapability();
  return json(capabilityView());
});
