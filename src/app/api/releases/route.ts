import { handle, json, userOf } from "@/lib/server/http";
import { releases } from "@/lib/server/observe";

export const GET = handle(async (req) => {
  userOf(req);
  return json(await releases());
});
