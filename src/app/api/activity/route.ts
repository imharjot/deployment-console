import { envOf, handle, json, userOf } from "@/lib/server/http";
import { activity } from "@/lib/server/observe";

export const GET = handle(async (req) => {
  userOf(req);
  return json(await activity(envOf(req.nextUrl.searchParams.get("env"))));
});
