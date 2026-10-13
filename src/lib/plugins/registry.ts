// Built-in integrations, in the order the settings page shows them.
//
// Adding an integration = one file + one line here:
//   1. src/lib/plugins/<id>.ts exporting a `Plugin` (see ./types.ts). Keep request building in exported pure
//      functions returning a `Req` so it can be unit-tested, and perform it with `send()` from ./http.ts.
//      Mark every credential (tokens, URLs that embed tokens) `type: "secret"` — it is then sealed at rest and never
//      returned to the browser. `icon` is a lucide name; the settings page maps known names and falls back to a plug.
//   2. Add it to PLUGINS below. Storage, the settings UI, test/notify routing and ticket creation pick it up.
import { asana } from "./asana.ts";
import { clickup } from "./clickup.ts";
import { github } from "./github.ts";
import { jira } from "./jira.ts";
import { linear } from "./linear.ts";
import { slack } from "./slack.ts";
import type { Plugin } from "./types.ts";
import { webhook } from "./webhook.ts";

export const PLUGINS: Plugin[] = [slack, webhook, github, jira, linear, clickup, asana];

export const pluginOf = (id: string): Plugin | undefined => PLUGINS.find((p) => p.id === id);
