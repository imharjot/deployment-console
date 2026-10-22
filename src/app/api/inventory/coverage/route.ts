import { can } from "@/lib/rbac";
import { awsCallStats } from "@/lib/server/aws-limiter";
import { handle, json, requirePerm, userOf } from "@/lib/server/http";
import { inventoryCoverage } from "@/lib/server/inventory";

// What the cloud map knows and what it doesn't (REVIEW "inventory reconciliation view"), for Settings → AWS permissions:
// the last complete scan, sources denied or failing, capped types, runs served from an older read, regions still being
// read, remote references nothing in the account answers to (at most 200), resources pending deletion confirmation, the
// activity-metric budget, and a `freshness` for the banner. AWS call stats (per service and region) are for operators
// and admins, like GET /api/diagnostics/aws. Names, ids and counts only — no values, no secrets.
export const GET = handle(async (req) => {
  const user = userOf(req);
  requirePerm(user, "view");
  const coverage = await inventoryCoverage();
  return json({ ...coverage, awsCalls: can(user, "act", true) ? awsCallStats() : [] });
});
