// The caller's preferences. GET → { home?, region?, "dashboards.lastOpened"? }; PATCH with any of those keys → the
// whole set. `home` is "overview", "incident" or "dashboard:<id>" (one the caller can see); null removes a key; any
// other key is refused. Never audited. People only (tokenRoute allows GET /api/me itself, not this).
import { workspaceErrors } from "@/lib/server/dashboards";
import { handle, json, readJson } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";
import { getPrefs, setPrefs } from "@/lib/server/workspace";

export const GET = handle(async (req) => json(await getPrefs(personOf(req).user)));

export const PATCH = handle(async (req) =>
  workspaceErrors(async () => json(await setPrefs(personOf(req).user, await readJson(req, 2_000)))),
);
