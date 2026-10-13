import { assertRepo, runs } from "@/lib/server/ci";
import { handle, json, userOf } from "@/lib/server/http";

export const GET = handle(async (req) => {
  userOf(req);
  const q = req.nextUrl.searchParams;
  return json(await runs(await assertRepo(q.get("repo")), q.get("branch") || undefined));
});
