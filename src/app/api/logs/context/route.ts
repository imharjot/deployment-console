import { envOf, handle, json, userOf } from "@/lib/server/http";
import { logContext, servicesParam } from "@/lib/server/logs";

export const GET = handle(async (req) => {
  userOf(req);
  const q = req.nextUrl.searchParams;
  const env = envOf(q.get("env"));
  const [target] = await servicesParam(env, q.get("service"));
  return json(await logContext(target, q.get("stream") ?? "", Number(q.get("ts"))));
});
