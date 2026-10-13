import { auditLog } from "@/lib/server/console";
import { handle, json, userOf } from "@/lib/server/http";

export const GET = handle(async (req) => {
  userOf(req);
  const n = Math.trunc(Number(req.nextUrl.searchParams.get("limit")));
  return json(await auditLog(Number.isFinite(n) && n >= 1 ? Math.min(n, 500) : 200)); // 1–500, default 200
});
