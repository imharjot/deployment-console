import { handle, json, userOf } from "@/lib/server/http";
import { consoleRegions } from "@/lib/server/regions";

// The regions this console reads, home first: { home, regions, allEnabled, source } (region filters, the map). Any
// signed-in person; `problems` names configuration entries that were dropped.
export const GET = handle(async (req) => {
  userOf(req);
  return json(await consoleRegions());
});
