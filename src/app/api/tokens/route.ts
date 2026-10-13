// API tokens: your own (admins: ?all=1 for everyone's). Create returns the token once; only its hash is kept.
import { apiTokensEnabled } from "@/lib/automation";
import { createToken, listTokens } from "@/lib/server/auth/api-tokens";
import { assertDevLoopback } from "@/lib/server/auth/config";
import { handle, json, readJson, requirePerm } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  const c = personOf(req);
  const all = req.nextUrl.searchParams.get("all") === "1";
  if (all) requirePerm(c.user, "admin");
  return json({ tokens: await listTokens(c.user, all), enabled: apiTokensEnabled() });
});

// { name, role?, mode?: "read" | "propose" | "act", expiresInDays: 7 | 30 | 90 | null }
// A token outlives dev mode, so in dev it is only minted for a request addressed to a loopback host (F02).
export const POST = handle(async (req) => {
  assertDevLoopback(req);
  const c = personOf(req);
  const b = await readJson(req);
  return json(await createToken(c.user, { name: b.name, role: b.role, mode: b.mode, expiresInDays: b.expiresInDays }, c.ip), 201);
});
