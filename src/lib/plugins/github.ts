// GitHub Issues via the REST API. Token: fine-grained PAT with Issues read/write, or the console's GITHUB_TOKEN.
// Create issue: POST /repos/{owner}/{repo}/issues — https://docs.github.com/en/rest/issues/issues#create-an-issue
// Get repo:     GET  /repos/{owner}/{repo}        — https://docs.github.com/en/rest/repos/repos#get-a-repository
import { jsonReq, oneLine, send, splitList, type Req } from "./http.ts";
import type { Config, Plugin, TicketInput } from "./types.ts";

const GITHUB_API = "https://api.github.com";
const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/; // owner/name; "." and ".." are not repo names

function headers(cfg: Config) {
  const token = cfg.token || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GitHub: no token — set one here or GITHUB_TOKEN on the console");
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}

function repo(cfg: Config) {
  const r = cfg.repo.trim();
  if (!REPO.test(r)) throw new Error("GitHub: repository must look like owner/name");
  return r;
}

export const githubRepoRequest = (cfg: Config, base = GITHUB_API): Req => jsonReq("GET", `${base}/repos/${repo(cfg)}`, headers(cfg));

export function githubIssueRequest(cfg: Config, t: TicketInput, base = GITHUB_API): Req {
  const labels = splitList(cfg.labels);
  return jsonReq("POST", `${base}/repos/${repo(cfg)}/issues`, headers(cfg), { title: oneLine(t.title, 250), body: t.body, ...(labels.length ? { labels } : {}) });
}

export const github: Plugin = {
  id: "github",
  name: "GitHub Issues",
  description: "Open issues in a GitHub repository.",
  icon: "circle-dot",
  docsUrl: "https://docs.github.com/en/rest/issues/issues#create-an-issue",
  capabilities: ["tickets"],
  fields: [
    { key: "repo", label: "Repository", type: "text", required: true, placeholder: "acme/api" },
    { key: "token", label: "Token", type: "secret", placeholder: "optional — falls back to GITHUB_TOKEN", help: "Fine-grained token with Issues: read and write on this repository." },
    { key: "labels", label: "Labels", type: "text", placeholder: "bug, ops", help: "Optional, comma-separated. GitHub drops labels silently without push access." },
  ],
  async test(cfg, base) {
    const res = await send("GitHub", githubRepoRequest(cfg, base));
    const j = res.json as { full_name?: string; has_issues?: boolean };
    if (j?.has_issues === false) throw new Error(`GitHub: issues are disabled on ${j.full_name ?? cfg.repo}`);
    return `Connected to ${j?.full_name ?? cfg.repo}`;
  },
  async createTicket(cfg, t, base) {
    const res = await send("GitHub", githubIssueRequest(cfg, t, base), 10_000);
    const j = res.json as { number?: number; html_url?: string };
    if (!j?.number || !j.html_url) throw new Error("GitHub: response had no issue number");
    return { id: `#${j.number}`, url: j.html_url };
  },
};
