// Jira Cloud REST v3 with basic auth (account email + API token). Descriptions must be ADF.
// Create issue: POST /rest/api/3/issue                  — https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post
// Get project:  GET  /rest/api/3/project/{key}          — https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-projectidorkey-get
// Basic auth:   https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
import { toAdf } from "./adf.ts";
import { jsonReq, oneLine, send, type Req } from "./http.ts";
import type { Config, Plugin, TicketInput } from "./types.ts";

// The site URL is a user field (every Jira Cloud tenant has its own host), so no separate test base is needed.
const site = (cfg: Config) => cfg.siteUrl.trim().replace(/\/+$/, "");
const auth = (cfg: Config) => ({ Authorization: `Basic ${Buffer.from(`${cfg.email.trim()}:${cfg.token}`).toString("base64")}` });
const issueType = (cfg: Config) => cfg.issueType?.trim() || "Bug";

export const jiraProjectRequest = (cfg: Config): Req => jsonReq("GET", `${site(cfg)}/rest/api/3/project/${encodeURIComponent(cfg.projectKey.trim())}`, auth(cfg));

export function jiraIssueRequest(cfg: Config, t: TicketInput): Req {
  const fields: Record<string, unknown> = {
    project: { key: cfg.projectKey.trim() },
    summary: oneLine(t.title, 250), // summary is single-line, max 255
    issuetype: { name: issueType(cfg) },
  };
  if (t.body.trim()) fields.description = toAdf(t.body);
  return jsonReq("POST", `${site(cfg)}/rest/api/3/issue`, auth(cfg), { fields });
}

export const jira: Plugin = {
  id: "jira",
  name: "Jira Cloud",
  description: "Create issues in a Jira Cloud project.",
  icon: "ticket",
  docsUrl: "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/",
  capabilities: ["tickets"],
  fields: [
    { key: "siteUrl", label: "Site URL", type: "url", required: true, placeholder: "https://your-team.atlassian.net" },
    { key: "email", label: "Account email", type: "text", required: true, placeholder: "ops@example.com" },
    { key: "token", label: "API token", type: "secret", required: true, help: "id.atlassian.com → Security → API tokens." },
    { key: "projectKey", label: "Project key", type: "text", required: true, placeholder: "OPS" },
    { key: "issueType", label: "Issue type", type: "text", placeholder: "Bug", help: "Defaults to Bug. Must exist in the project." },
  ],
  async test(cfg) {
    const res = await send("Jira", jiraProjectRequest(cfg));
    const p = res.json as { key?: string; name?: string; issueTypes?: { name: string }[] };
    const types = p?.issueTypes?.map((x) => x.name) ?? [];
    if (types.length && !types.some((n) => n.toLowerCase() === issueType(cfg).toLowerCase())) {
      throw new Error(`Jira: issue type "${issueType(cfg)}" is not in ${p.key}; available: ${types.join(", ")}`);
    }
    return `Connected to ${p?.key ?? cfg.projectKey}${p?.name ? ` (${p.name})` : ""}`;
  },
  async createTicket(cfg, t) {
    const res = await send("Jira", jiraIssueRequest(cfg, t), 10_000);
    const j = res.json as { id?: string; key?: string };
    if (!j?.key) throw new Error("Jira: response had no issue key");
    return { id: j.key, url: `${site(cfg)}/browse/${j.key}` };
  },
};
