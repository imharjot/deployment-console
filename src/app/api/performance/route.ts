import { envOf, handle, json, userOf } from "@/lib/server/http";
import { performance } from "@/lib/server/observe";

// ?minutes= is snapped to 60, 360, 1440 or 10080 (one cache key per window). The answer carries `freshness`.
export const GET = handle(async (req) => {
  userOf(req);
  const q = req.nextUrl.searchParams;
  return json(await performance(envOf(q.get("env")), Number(q.get("minutes") ?? 60)));
});
