import { EVENT_LABELS, EVENT_TYPES } from "@/lib/plugins/events";
import { PLUGINS } from "@/lib/plugins/registry";
import { can } from "@/lib/rbac";
import { listEnvs } from "@/lib/server/discovery";
import { handle, json, userOf } from "@/lib/server/http";
import { lastDeliveries, readAll, viewOf } from "@/lib/server/plugins/store";

// Anyone signed in may see which integrations exist and are enabled (the ticket dialog needs it).
// Only admins get configs (secrets redacted to { set: true }), subscriptions and the env list for filters.
export const GET = handle(async (req) => {
  const admin = can(userOf(req), "admin");
  const [rows, last] = await Promise.all([readAll(), lastDeliveries()]);
  return json({
    admin,
    integrations: PLUGINS.map((p) => viewOf(p, rows.get(p.id), admin, last.get(p.id))),
    eventTypes: admin ? EVENT_TYPES.map((t) => ({ value: t, label: EVENT_LABELS[t] })) : [],
    envs: admin ? (await listEnvs()).map((e) => ({ id: e.id, label: e.label, protected: e.protected })) : [],
  });
});
