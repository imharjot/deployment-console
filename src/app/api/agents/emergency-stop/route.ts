// The agents' emergency stop (master plan §3.5). GET (any signed-in person) → { on, by?, at?, reason? }. POST (admin)
// { on: boolean, reason } → the new state: while on, no agent can change anything (the registry answers 423 and the
// worker holds execute steps), whatever the policies say. Audited; published as an `action` event.
import { HttpError } from "@/lib/server/errors";
import { handle, json, readJson, requirePerm } from "@/lib/server/http";
import { isEmergencyStopped, setEmergencyStop } from "@/lib/server/agents/stop";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  personOf(req);
  return json(await isEmergencyStopped());
});

export const POST = handle(async (req) => {
  const c = personOf(req);
  requirePerm(c.user, "admin");
  const b = await readJson(req);
  if (typeof b.on !== "boolean") throw new HttpError(400, "on must be a boolean");
  if (b.reason !== undefined && (typeof b.reason !== "string" || b.reason.length > 500)) throw new HttpError(400, "reason must be a string ≤ 500 chars");
  return json(await setEmergencyStop(b.on, c.user.email, b.reason, c.ip));
});
