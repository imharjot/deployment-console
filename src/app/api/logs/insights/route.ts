import { envOf, handle, json, readJson, userOf } from "@/lib/server/http";
import { insightsStart, servicesParam } from "@/lib/server/logs";

// Read-only query; POST only because the query text can be long. Log groups are fixed server-side. Rate-limited per
// person and across the console; the id it returns is readable only by whoever started it (or an admin).
export const POST = handle(async (req) => {
  const user = userOf(req);
  const b = await readJson(req);
  const env = envOf(b.env);
  return json(await insightsStart(await servicesParam(env, Array.isArray(b.services) ? b.services.join(",") : b.services), String(b.query ?? ""), Number(b.start), Number(b.end), user));
});
