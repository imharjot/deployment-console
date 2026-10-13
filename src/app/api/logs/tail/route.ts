import { envOf, handle, json, userOf } from "@/lib/server/http";
import { logTail, servicesParam } from "@/lib/server/logs";

export const GET = handle(async (req) => {
  userOf(req);
  const q = req.nextUrl.searchParams;
  const env = envOf(q.get("env"));
  return json(await logTail(await servicesParam(env, q.get("services") ?? q.get("service")), q.get("cursor"), Number(q.get("limit"))));
});
