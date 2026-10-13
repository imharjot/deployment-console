// ClickUp API v2. Personal tokens ("pk_…") go in the Authorization header as-is (no "Bearer").
// Create task: POST /v2/list/{list_id}/task — https://developer.clickup.com/reference/createtask
// Get list:    GET  /v2/list/{list_id}      — https://developer.clickup.com/reference/getlist
import { jsonReq, oneLine, send, splitList, type Req } from "./http.ts";
import type { Config, Plugin, TicketInput } from "./types.ts";

const CLICKUP_API = "https://api.clickup.com/api/v2";
const list = (cfg: Config) => encodeURIComponent(cfg.listId.trim());

export const clickupListRequest = (cfg: Config, base = CLICKUP_API): Req => jsonReq("GET", `${base}/list/${list(cfg)}`, { Authorization: cfg.token });

export function clickupTaskRequest(cfg: Config, t: TicketInput, base = CLICKUP_API): Req {
  const tags = splitList(cfg.tags);
  // markdown_content wins over description when both are set; description keeps a plain-text copy.
  return jsonReq("POST", `${base}/list/${list(cfg)}/task`, { Authorization: cfg.token }, { name: oneLine(t.title, 250), description: t.body, markdown_content: t.body, ...(tags.length ? { tags } : {}) });
}

export const clickup: Plugin = {
  id: "clickup",
  name: "ClickUp",
  description: "Create tasks in a ClickUp list.",
  icon: "list-checks",
  docsUrl: "https://developer.clickup.com/docs/authentication",
  capabilities: ["tickets"],
  fields: [
    { key: "token", label: "API token", type: "secret", required: true, placeholder: "pk_…", help: "ClickUp → Settings → Apps → API Token." },
    { key: "listId", label: "List ID", type: "text", required: true, placeholder: "901234567890", help: "Open the list → ⋯ → Copy link; the number after /li/." },
    { key: "tags", label: "Tags", type: "text", placeholder: "ops, console", help: "Optional, comma-separated. Tags must already exist in the space." },
  ],
  async test(cfg, base) {
    const res = await send("ClickUp", clickupListRequest(cfg, base));
    const name = (res.json as { name?: string })?.name;
    return `Connected to list “${name ?? cfg.listId}”`;
  },
  async createTicket(cfg, t, base) {
    const res = await send("ClickUp", clickupTaskRequest(cfg, t, base), 10_000);
    const j = res.json as { id?: string; url?: string };
    if (!j?.id) throw new Error("ClickUp: response had no task id");
    return { id: j.id, url: j.url ?? `https://app.clickup.com/t/${j.id}` };
  },
};
