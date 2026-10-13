// File a ticket in a connected tracker. Runs through the mutation coordinator (REVIEW R10): the operation + audit
// intent (ticket.create) commits before the vendor is called — if it can't, no ticket is filed — and the result is
// recorded as completed (the vendor answered with the ticket), failed (the vendor refused) or outcome unknown (the
// request left but the answer didn't come back: check the tracker before filing again).
import { canonicalKey } from "@/lib/mutation-keys";
import { pluginOf } from "@/lib/plugins/registry";
import { envInfo } from "@/lib/server/discovery";
import { HttpError } from "@/lib/server/errors";
import { envOf, handle, ipOf, json, readJson, requirePerm, userOf } from "@/lib/server/http";
import { mutate } from "@/lib/server/mutations";
import { configOf, readOne } from "@/lib/server/plugins/store";

const MAX_BODY = 8_000;
// readJson caps bytes: room for an 8,000-character body and a 250-character title in any script (up to 4 bytes a
// character in UTF-8) plus JSON escapes, so the character limits below are the ones a person meets.
const MAX_REQUEST_BYTES = 40_000;

// Body: { integration, title, body (markdown), env?, target? } → { id, url }.
export const POST = handle(async (req) => {
  const user = userOf(req);
  requirePerm(user, "tickets:create");
  const b = (await readJson(req, MAX_REQUEST_BYTES)) as { integration?: unknown; title?: unknown; body?: unknown; env?: unknown; target?: unknown };
  const id = typeof b.integration === "string" ? b.integration : "";
  const p = pluginOf(id);
  const createTicket = p?.createTicket;
  if (!p || !createTicket) throw new HttpError(400, "integration must be a ticket integration");
  const row = await readOne(p.id);
  if (!row?.enabled) throw new HttpError(400, `${p.name} is not enabled — an admin can set it up in Settings → Integrations`);
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title || title.length > 250) throw new HttpError(400, "title must be 1–250 characters");
  const text = typeof b.body === "string" ? b.body.trim() : "";
  if (text.length > MAX_BODY) throw new HttpError(400, `body must be at most ${MAX_BODY} characters`);
  const env = b.env === undefined || b.env === null || b.env === "" ? undefined : envOf(b.env);
  const target = typeof b.target === "string" && b.target ? b.target.slice(0, 200) : undefined;
  // The environment as discovery knows it (label, protection) when it does; a ticket about an environment that is gone
  // can still be filed.
  const e = env ? await envInfo(env).catch(() => undefined) : undefined;

  const input = { title, body: `${text}\n\n---\nFiled from the deployment console by ${user.email}`, env, target };
  const ip = ipOf(req);
  const { result } = await mutate(
    {
      action: "ticket.create",
      actor: { display: user.email, kind: "person", userId: user.id, ...(ip ? { ip } : {}) },
      ...(env ? { env: e ? { id: e.id, label: e.label, protected: e.protected, region: e.region } : { id: env, protected: false } } : {}),
      target: target ?? p.id,
      keys: [canonicalKey({ console: `ticket/${p.id}` })],
      params: { integration: p.id, title, ...(target ? { about: target } : {}) },
      summarize: (t) => ({ id: (t as { id: string }).id, url: (t as { url: string }).url }),
    },
    async (h) => {
      await h.intent();
      const t = await createTicket(configOf(p.fields, row.stored), input);
      h.requestId(t.id);
      return t;
    },
  );
  return json(result, 201);
});
