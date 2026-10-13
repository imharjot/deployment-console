// Real CI source: GitHub REST with conditional requests (ETag). A 304 costs nothing against the 5,000/h limit.
import { unzipSync, strFromU8 } from "fflate";
import { compareComplete } from "../ci-rules.ts";
import { LIMITS } from "../config.ts";
import { summarize } from "../junit.ts";
import type { CiJob, CiRun, CommitInfo } from "../types.ts";
import { cached, memo } from "./cache.ts";
import { NotConfiguredError, flagAfterSend } from "./errors.ts";
import type { Ci, Compare } from "./sources.ts";

const API = "https://api.github.com";
const COMPARE_PAGES = 10; // commit pages of 100 read per comparison; a longer range is reported incomplete

// ETag bodies, least recently used first, at most 500 (F28). Immutable answers aren't kept here at all: a compare of
// two shas and a commit by sha never change, and the caller caches them (memo / cached). A compare against a branch
// (the overview's "behind by" check, every minute) is kept — slimmed to the fields compare() reads, never the patches —
// so its 304s stay free against the rate limit.
const ETAG_MAX = 500;
const g = globalThis as { __consoleGithubEtags?: Map<string, { etag: string; body: unknown }> };
const etags = (g.__consoleGithubEtags ??= new Map());
const immutable = (url: string) => /\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}(?:$|\?)/i.test(url) || /\/commits\/[0-9a-f]{7,40}(?:$|\?)/i.test(url);
export function rememberEtag(map: Map<string, { etag: string; body: unknown }>, url: string, etag: string, body: unknown, max = ETAG_MAX) {
  if (immutable(url)) return;
  map.delete(url);
  map.set(url, { etag, body });
  while (map.size > max) map.delete(map.keys().next().value!);
}
function recallEtag(url: string) {
  const hit = etags.get(url);
  if (hit) {
    etags.delete(url); // most recently used goes last
    etags.set(url, hit);
  }
  return hit;
}

class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// No token: "not configured" (503 with a pointer to the setup docs), never an outage (F37).
function headers(extra: Record<string, string> = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new NotConfiguredError("GitHub is not connected: GITHUB_TOKEN is not set", "/docs/github");
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...extra };
}

const isAbort = (e: unknown) => (e as { name?: string })?.name === "TimeoutError" || (e as { name?: string })?.name === "AbortError";

// `slim` keeps only what the caller reads: that is what is returned and what the ETag store holds.
async function gh<T>(path: string, init: RequestInit = {}, slim?: (raw: unknown) => T): Promise<T> {
  const url = `${API}${path}`;
  const method = init.method ?? "GET";
  const prev = method === "GET" ? recallEtag(url) : undefined;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: headers(prev ? { "If-None-Match": prev.etag } : {}),
      signal: AbortSignal.timeout(LIMITS.githubTimeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    // A write (re-run) cut off after it left: GitHub may have acted — outcome unknown, never retried blindly.
    throw method !== "GET" && isAbort(e) ? flagAfterSend(e) : e;
  }
  if (res.status === 304 && prev) return prev.body as T;
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    throw new GitHubError(429, `GitHub rate limit reached, resets ${new Date(reset).toISOString().slice(11, 16)} UTC`);
  }
  if (!res.ok) throw new GitHubError(res.status, `GitHub ${res.status} on ${path.split("?")[0]}`);
  if (res.status === 201 || res.status === 204) return undefined as T;
  const raw: unknown = await res.json();
  const body = slim ? slim(raw) : (raw as T);
  const etag = res.headers.get("etag");
  if (etag && method === "GET") rememberEtag(etags, url, etag, body);
  return body;
}

interface GhRun {
  id: number; name: string; head_branch: string; head_sha: string; display_title: string; actor?: { login: string };
  event: string; status: string; conclusion: string | null; run_attempt: number; created_at: string; updated_at: string; html_url: string;
  path?: string; workflow_id?: number;
}

// `path` is the workflow file (".github/workflows/deploy.yml", sometimes "…@<ref>"): what a deployment binding names (R03).
export const toRun = (repo: string, r: GhRun): CiRun => ({
  id: r.id, repo, workflow: r.name, branch: r.head_branch, sha: r.head_sha, title: r.display_title, actor: r.actor?.login ?? "",
  event: r.event, status: r.status, conclusion: r.conclusion, attempt: r.run_attempt, createdAt: r.created_at, updatedAt: r.updated_at, url: r.html_url,
  ...(r.path ? { workflowPath: r.path } : {}), ...(typeof r.workflow_id === "number" ? { workflowId: r.workflow_id } : {}),
});

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15_000), redirect: "follow" });
  if (!res.ok) throw new GitHubError(res.status, `download ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// A job log's newest bytes, at most `max` (F28): the body is read as a stream and only the newest `max` bytes are held,
// so a 200 MB build log never sits in memory. A cut log loses its first (partial) line and says so.
const JOB_LOG_BYTES = 1024 * 1024;
export async function readTail(res: Response, max = JOB_LOG_BYTES): Promise<{ text: string; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", cut: false };
  const chunks: Uint8Array[] = [];
  let held = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    held += value.length;
    while (held - chunks[0].length >= max) {
      held -= chunks.shift()!.length;
      cut = true;
    }
  }
  let buf = new Uint8Array(held);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.length;
  }
  if (held > max) {
    buf = buf.subarray(held - max);
    cut = true;
  }
  const text = new TextDecoder().decode(buf);
  return { text: cut ? text.slice(text.indexOf("\n") + 1) : text, cut };
}

// A compare page as compare() reads it: counts, file names and each commit's first line (no patches, no stats).
type GhCompare = { ahead_by: number; behind_by: number; total_commits?: number; files: string[]; commits: { sha: string; title: string; author: string; date: string }[] };
export function slimCompare(raw: unknown): GhCompare {
  const r = raw as { ahead_by: number; behind_by: number; total_commits?: number; files?: { filename: string }[]; commits?: { sha: string; commit: { message: string; author?: { name: string; date: string } } }[] };
  return {
    ahead_by: r.ahead_by, behind_by: r.behind_by, ...(typeof r.total_commits === "number" ? { total_commits: r.total_commits } : {}),
    files: (r.files ?? []).map((f) => f.filename),
    commits: (r.commits ?? []).map((c) => ({ sha: c.sha, title: c.commit.message.split("\n")[0], author: c.commit.author?.name ?? "", date: c.commit.author?.date ?? "" })),
  };
}

export function githubCi(): Ci {
  return {
    kind: "github",

    async runs(repo, branch, limit) {
      const q = new URLSearchParams({ per_page: String(limit) });
      if (branch) q.set("branch", branch);
      const r = await gh<{ workflow_runs: GhRun[] }>(`/repos/${repo}/actions/runs?${q}`);
      return r.workflow_runs.map((x) => toRun(repo, x));
    },

    async run(repo, id) {
      return toRun(repo, await gh<GhRun>(`/repos/${repo}/actions/runs/${id}`));
    },

    async jobs(repo, runId) {
      const r = await gh<{ jobs: { id: number; name: string; status: string; conclusion: string | null; started_at: string; completed_at: string | null; html_url: string; steps?: { number: number; name: string; status: string; conclusion: string | null; started_at?: string; completed_at?: string }[] }[] }>(
        `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
      );
      return r.jobs.map<CiJob>((j) => ({
        id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, startedAt: j.started_at, completedAt: j.completed_at ?? undefined, url: j.html_url,
        steps: (j.steps ?? []).map((s) => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion, startedAt: s.started_at, completedAt: s.completed_at })),
      }));
    },

    async jobLog(repo, jobId) {
      const res = await fetch(`${API}/repos/${repo}/actions/jobs/${jobId}/logs`, { headers: headers(), signal: AbortSignal.timeout(15_000), redirect: "follow" });
      if (!res.ok) throw new GitHubError(res.status, `job log ${res.status}`);
      const { text, cut } = await readTail(res);
      return cut ? `… earlier lines not shown: only the newest ${JOB_LOG_BYTES / 1024 / 1024} MB of this log is read — open it on GitHub for the rest\n${text}` : text;
    },

    async tests(repo, runId) {
      return (
        await cached(`gh:tests:${repo}:${runId}`, 5 * 60_000, async () => {
          const r = await gh<{ artifacts: { name: string; archive_download_url: string; expired: boolean }[] }>(`/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
          const junit = r.artifacts.filter((a) => a.name.startsWith("junit") && !a.expired);
          if (!junit.length) return null;
          const files: { name: string; xml: string }[] = [];
          for (const a of junit) {
            const zip = unzipSync(await download(a.archive_download_url));
            for (const [name, data] of Object.entries(zip)) if (name.endsWith(".xml")) files.push({ name: `${a.name}/${name}`, xml: strFromU8(data) });
          }
          return summarize(files);
        })
      ).value;
    },

    async rerun(repo, runId, failedOnly) {
      await gh(`/repos/${repo}/actions/runs/${runId}/${failedOnly ? "rerun-failed-jobs" : "rerun"}`, { method: "POST" });
    },

    commit(repo, sha) {
      return memo<CommitInfo | null>(`gh:commit:${repo}:${sha}`, async () => {
        const c = await gh<{ sha: string; html_url: string; commit: { message: string; author?: { name: string; date: string } } }>(`/repos/${repo}/commits/${sha}`);
        return { sha: c.sha, title: c.commit.message.split("\n")[0], author: c.commit.author?.name ?? "", date: c.commit.author?.date ?? "", url: c.html_url };
      });
    },

    // GitHub lists at most 300 files (on the first page only) and pages the commits, oldest first: up to COMPARE_PAGES
    // pages of 100 are read — for a longer range the first page (it carries the files) and the newest pages, so the
    // newest commits are always there. complete = fewer than 300 files and every commit read (R25).
    async compare(repo, base, head) {
      const path = `/repos/${repo}/compare/${base}...${head}`;
      const read = (page: number) => gh<GhCompare>(`${path}?per_page=100&page=${page}`, {}, slimCompare);
      const first = await read(1);
      const total = first.total_commits;
      const last = total === undefined ? 1 : Math.ceil(total / 100);
      const from = last <= COMPARE_PAGES ? 2 : last - COMPARE_PAGES + 2;
      const commits = [...first.commits];
      for (let page = from; page <= last; page++) {
        const next = await read(page);
        if (!next.commits.length) break;
        commits.push(...next.commits);
      }
      return {
        aheadBy: first.ahead_by,
        behindBy: first.behind_by,
        files: first.files,
        commits,
        complete: last <= COMPARE_PAGES && compareComplete(first.files.length, commits.length, total),
      } satisfies Compare;
    },

    // One directory at a ref (R25), via the contents API: null when the path or ref doesn't exist, is a file, or the
    // listing may be cut short (the API returns at most 1,000 entries).
    async listDir(repo, path, ref) {
      const p = path.replace(/^\/+|\/+$/g, "").split("/").map(encodeURIComponent).join("/");
      try {
        const r = await gh<{ name: string; sha: string }[] | Record<string, unknown>>(`/repos/${repo}/contents/${p}?ref=${encodeURIComponent(ref)}`);
        if (!Array.isArray(r) || r.length >= 1000) return null;
        return r.map((e) => ({ name: e.name, sha: e.sha }));
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404) return null;
        throw e;
      }
    },

    // Used to confirm a guessed service → repo mapping. Cached for an hour either way.
    async repoExists(repo) {
      return (
        await cached(`gh:exists:${repo}`, 60 * 60_000, async () => {
          try {
            await gh(`/repos/${repo}`);
            return true;
          } catch (e) {
            if (e instanceof GitHubError && e.status === 404) return false;
            throw e;
          }
        })
      ).value;
    },
  };
}
