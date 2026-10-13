import { envOf, handle, json, userOf } from "@/lib/server/http";
import { provisionInfo } from "@/lib/server/provision";

// What the Create & scale UI needs for one env: limits, role gates, services and hosts with the facts the shared guards
// read (src/lib/provision.ts), and with ?sources=1 every service of the region that may be copied. Read-only.
export const GET = handle(async (req) => {
  const user = userOf(req);
  const q = req.nextUrl.searchParams;
  return json(await provisionInfo(envOf(q.get("env")), user, q.get("sources") === "1"));
});
