import { handle, json, requirePerm, userOf } from "@/lib/server/http";
import { recentDeliveries } from "@/lib/server/plugins/store";

export const GET = handle(async (req) => {
  requirePerm(userOf(req), "admin");
  return json(await recentDeliveries(50));
});
