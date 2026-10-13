import { envOf, handle, json, userOf } from "@/lib/server/http";
import { logSearch, servicesParam } from "@/lib/server/logs";

export const GET = handle(async (req) => {
  userOf(req);
  const q = req.nextUrl.searchParams;
  const env = envOf(q.get("env"));
  const targets = await servicesParam(env, q.get("services") ?? q.get("service"));
  return json(await logSearch(targets, q.get("q") ?? "", q.get("mode") ?? "text", Number(q.get("start")), Number(q.get("end")), q.get("cursor")));
});
