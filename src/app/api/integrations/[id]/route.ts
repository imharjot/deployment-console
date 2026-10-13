// Integration settings (admin). Every save and delete runs through the mutation coordinator (REVIEW R10): one change
// per integration at a time (key console:integration/<id>), the stored row read under that lock, and the operation +
// audit intent committed before anything is written — no intent, no change. Field names only are audited, never values.
import { canonicalKey } from "@/lib/mutation-keys";
import { merge } from "@/lib/plugins/config";
import { DEFAULT_SUBSCRIPTION, parseSubscription } from "@/lib/plugins/events";
import { pluginOf } from "@/lib/plugins/registry";
import type { User } from "@/lib/rbac";
import { HttpError } from "@/lib/server/errors";
import { invalidateIntegrations } from "@/lib/server/events";
import { handle, ipOf, json, readJson, requirePerm, userOf } from "@/lib/server/http";
import { mutate, type MutationActor } from "@/lib/server/mutations";
import { lastDeliveries, readOne, remove, save, viewOf } from "@/lib/server/plugins/store";
import { seal } from "@/lib/server/secrets";

function plugin(id: string) {
  const p = pluginOf(id);
  if (!p) throw new HttpError(404, `unknown integration "${id}"`);
  return p;
}

const actorOf = (user: User, ip: string | undefined): MutationActor => ({ display: user.email, kind: "person", userId: user.id, ...(ip ? { ip } : {}) });
const keyOf = (id: string) => canonicalKey({ console: `integration/${id}` });

// Body: { enabled?, config?, events? }. Omitted parts keep their saved value; secrets are kept unless replaced.
export const PUT = handle<RouteContext<"/api/integrations/[id]">>(async (req, ctx) => {
  const user = userOf(req);
  requirePerm(user, "admin");
  const p = plugin((await ctx.params).id);
  const body = (await readJson(req)) as { enabled?: unknown; config?: unknown; events?: unknown };
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
  try {
    await mutate({ action: "integration.update", actor: actorOf(user, ipOf(req)), target: p.id, keys: [keyOf(p.id)], params: {} }, async (h) => {
      // Under the lock: merge onto the row as it is now, so two admins' saves can't drop each other's fields.
      const prev = await readOne(p.id);
      const m = merge(p.fields, prev?.stored ?? {}, body.config, seal);
      if (!m.ok) throw new HttpError(400, m.error); // before the intent: a refusal, nothing recorded
      const enabled = typeof body.enabled === "boolean" ? body.enabled : (prev?.enabled ?? false);
      const subscription = body.events !== undefined ? parseSubscription(body.events) : (prev?.subscription ?? DEFAULT_SUBSCRIPTION);
      await h.intent({ enabled, changed: m.changed, ...(p.notify ? { events: subscription } : {}) });
      await save({ id: p.id, enabled, stored: m.stored, subscription }, user.email);
      return { id: p.id, enabled };
    });
  } finally {
    invalidateIntegrations(); // also after a failure: a save whose outcome is unclear must not leave a stale cache
  }
  return json(viewOf(p, await readOne(p.id), true, (await lastDeliveries()).get(p.id)));
});

export const DELETE = handle<RouteContext<"/api/integrations/[id]">>(async (req, ctx) => {
  const user = userOf(req);
  requirePerm(user, "admin");
  const p = plugin((await ctx.params).id);
  try {
    await mutate({ action: "integration.delete", actor: actorOf(user, ipOf(req)), target: p.id, keys: [keyOf(p.id)], params: {} }, async (h) => {
      const prev = await readOne(p.id);
      await h.intent({ configured: !!prev });
      await remove(p.id);
      return { id: p.id };
    });
  } finally {
    invalidateIntegrations();
  }
  return json(viewOf(p, undefined, true));
});
