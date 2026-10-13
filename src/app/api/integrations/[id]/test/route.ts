import { merge } from "@/lib/plugins/config";
import { pluginOf } from "@/lib/plugins/registry";
import { HttpError, errText } from "@/lib/server/errors";
import { sendTest } from "@/lib/server/events";
import { handle, json, readJson, requirePerm, userOf } from "@/lib/server/http";
import { configOf, readOne } from "@/lib/server/plugins/store";
import { seal } from "@/lib/server/secrets";

// Tests what the admin sees on screen: unsaved edits in `config` are merged over the saved row but never persisted.
// Notify plugins get a real "test" event; ticket plugins validate credentials + target without creating anything.
export const POST = handle<RouteContext<"/api/integrations/[id]/test">>(async (req, ctx) => {
  const user = userOf(req);
  requirePerm(user, "admin");
  const { id } = await ctx.params;
  const p = pluginOf(id);
  if (!p) throw new HttpError(404, `unknown integration "${id}"`);
  const body = (await readJson(req)) as { config?: unknown };
  const m = merge(p.fields, (await readOne(p.id))?.stored ?? {}, body.config, seal);
  if (!m.ok) throw new HttpError(400, m.error);
  const cfg = configOf(p.fields, m.stored);
  try {
    return json({ ok: true, message: p.notify ? await sendTest(p, cfg, user.email) : await p.test(cfg) });
  } catch (e) {
    throw new HttpError(502, errText(e));
  }
});
