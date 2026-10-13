import { awsCallStats } from "@/lib/server/aws-limiter";
import { handle, json, requirePerm, userOf } from "@/lib/server/http";

// AWS calls since the console started, per service and region: requests, SDK attempts (retries included), throttles,
// errors, p95 latency, and what is running or queued at the SDK-call limiter right now. Operators and admins.
export const GET = handle(async (req) => {
  requirePerm(userOf(req), "act", true); // act:protected — operator and above
  return json(awsCallStats());
});
