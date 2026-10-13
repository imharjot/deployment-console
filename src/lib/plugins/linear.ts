// Linear GraphQL API. Personal API keys go in the Authorization header as-is (OAuth tokens would use "Bearer").
// https://linear.app/developers/graphql — endpoint, auth, issueCreate and team(id) examples.
// GraphQL errors arrive as HTTP 200 with an `errors` array, so the response body is checked too.
import { apiError, jsonReq, oneLine, send, type Req } from "./http.ts";
import type { Config, Plugin, TicketInput } from "./types.ts";

const LINEAR_API = "https://api.linear.app/graphql";

const gql = (cfg: Config, query: string, variables: Record<string, unknown>, base = LINEAR_API): Req =>
  jsonReq("POST", base, { Authorization: cfg.apiKey }, { query, variables });

const TEAM_QUERY = "query Team($id: String!) { team(id: $id) { id key name } }";
export const ISSUE_CREATE = "mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }";

export const linearTeamRequest = (cfg: Config, base?: string) => gql(cfg, TEAM_QUERY, { id: cfg.teamId.trim() }, base);
export const linearIssueRequest = (cfg: Config, t: TicketInput, base?: string) =>
  gql(cfg, ISSUE_CREATE, { input: { teamId: cfg.teamId.trim(), title: oneLine(t.title, 250), description: t.body } }, base);

async function run<T>(req: Req): Promise<T> {
  const res = await send("Linear", req, 10_000);
  const j = res.json as { data?: T; errors?: unknown[] };
  if (j?.errors?.length) throw new Error(`Linear: ${apiError(j, res.text)}`.slice(0, 240));
  if (!j?.data) throw new Error("Linear: empty response");
  return j.data;
}

export const linear: Plugin = {
  id: "linear",
  name: "Linear",
  description: "Create issues in a Linear team.",
  icon: "zap",
  docsUrl: "https://linear.app/developers/graphql",
  capabilities: ["tickets"],
  fields: [
    { key: "apiKey", label: "API key", type: "secret", required: true, placeholder: "lin_api_…", help: "Linear → Settings → Security & access → Personal API keys." },
    { key: "teamId", label: "Team ID", type: "text", required: true, placeholder: "9cfb482a-81e3-4154-b5b9-2c805e70a02d", help: "The team's UUID: Cmd/Ctrl+K on the team → “Copy model UUID”." },
  ],
  async test(cfg, base) {
    const d = await run<{ team?: { key: string; name: string } | null }>(linearTeamRequest(cfg, base));
    if (!d.team) throw new Error("Linear: team not found");
    return `Connected to team ${d.team.name} (${d.team.key})`;
  },
  async createTicket(cfg, t, base) {
    const d = await run<{ issueCreate?: { success: boolean; issue?: { id: string; identifier: string; url: string } } }>(linearIssueRequest(cfg, t, base));
    const issue = d.issueCreate?.issue;
    if (!d.issueCreate?.success || !issue) throw new Error("Linear: issueCreate did not succeed");
    return { id: issue.identifier, url: issue.url };
  },
};
