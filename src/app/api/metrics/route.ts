import { metricMinutes, metrics } from "@/lib/server/console";
import { envOf, handle, json, userOf } from "@/lib/server/http";

export const GET = handle(async (req) => {
  userOf(req);
  const q = req.nextUrl.searchParams;
  // Whole minutes, 15 min to a day: one cache entry per window, not one per float (F28).
  return json(await metrics(envOf(q.get("env")), q.get("key") ?? "", metricMinutes(q.get("minutes"))));
});
