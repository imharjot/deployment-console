// Asana REST API 1.0 with a personal access token (Bearer). Request and response bodies are wrapped in "data".
// Create task: POST /tasks            — https://developers.asana.com/reference/createtask
// Get project: GET  /projects/{gid}   — https://developers.asana.com/reference/getproject
import { jsonReq, oneLine, send, type Req } from "./http.ts";
import type { Config, Plugin, TicketInput } from "./types.ts";

const ASANA_API = "https://app.asana.com/api/1.0";
const auth = (cfg: Config) => ({ Authorization: `Bearer ${cfg.token}` });

export const asanaProjectRequest = (cfg: Config, base = ASANA_API): Req =>
  jsonReq("GET", `${base}/projects/${encodeURIComponent(cfg.projectGid.trim())}?opt_fields=name`, auth(cfg));

// `notes` is plain text (markdown stays readable); html_notes would need Asana's strict XML subset.
export function asanaTaskRequest(cfg: Config, t: TicketInput, base = ASANA_API): Req {
  const data: Record<string, unknown> = { name: oneLine(t.title, 250), notes: t.body, projects: [cfg.projectGid.trim()] };
  if (cfg.workspaceGid) data.workspace = cfg.workspaceGid.trim();
  return jsonReq("POST", `${base}/tasks?opt_fields=gid,permalink_url`, auth(cfg), { data });
}

export const asana: Plugin = {
  id: "asana",
  name: "Asana",
  description: "Create tasks in an Asana project.",
  icon: "square-kanban",
  docsUrl: "https://developers.asana.com/docs/personal-access-token",
  capabilities: ["tickets"],
  fields: [
    { key: "token", label: "Personal access token", type: "secret", required: true, placeholder: "2/1200…", help: "Asana → My settings → Apps → Developer apps → Personal access tokens." },
    { key: "projectGid", label: "Project GID", type: "text", required: true, placeholder: "1204567890123456", help: "The number in the project URL: app.asana.com/0/<project>/…" },
    { key: "workspaceGid", label: "Workspace GID", type: "text", placeholder: "optional", help: "Only needed if Asana asks for it; normally inferred from the project." },
  ],
  async test(cfg, base) {
    const res = await send("Asana", asanaProjectRequest(cfg, base));
    const name = (res.json as { data?: { name?: string } })?.data?.name;
    return `Connected to project “${name ?? cfg.projectGid}”`;
  },
  async createTicket(cfg, t, base) {
    const res = await send("Asana", asanaTaskRequest(cfg, t, base), 10_000);
    const d = (res.json as { data?: { gid?: string; permalink_url?: string } })?.data;
    if (!d?.gid) throw new Error("Asana: response had no task gid");
    return { id: d.gid, url: d.permalink_url ?? `https://app.asana.com/0/${cfg.projectGid}/${d.gid}` };
  },
};
