import { knownRepos } from "@/lib/server/discovery";
import { handle, json, userOf } from "@/lib/server/http";

// GitHub repositories mapped to discovered services (tags, config or name match).
export const GET = handle(async (req) => {
  userOf(req);
  return json(await knownRepos());
});
