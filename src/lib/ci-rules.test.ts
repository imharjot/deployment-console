import { test } from "node:test";
import assert from "node:assert/strict";
import { INPUTS_NOTE, classify, compareComplete, decideMigrations, migrationsFromListings, rerunRules, tagBindings, workflowFile, type DeployBinding } from "./ci-rules.ts";
import { can } from "./rbac.ts";
import { mockCi } from "./server/mock.ts";
import type { CiRun, EnvInfo } from "./types.ts";

const env = (id: string, label: string, branch: string, prot: boolean, order: number): EnvInfo => ({
  id, label, protected: prot, region: "us-east-1", cluster: `acme-${id}`, kind: "fargate", branch, order, source: "discovered",
});
const STAGING = env("staging", "Staging", "staging", false, 1);
const PROD = env("production", "Production", "main", true, 2);
const ENVS = [STAGING, PROD];
const run = (o: Partial<CiRun>): Pick<CiRun, "repo" | "workflow" | "branch" | "workflowPath"> => ({ repo: "acme/storefront-api", workflow: "CI", branch: "main", ...o });
const DEPLOY: DeployBinding = { repo: "acme/storefront-api", workflow: ".github/workflows/deploy.yml", env: "production", source: "config" };

test("REVIEW R03: a workflow named CI on the production branch is a protected deploy — a developer can't re-run it", () => {
  for (const workflow of ["CI", "Build", "Deploy"]) {
    const c = classify(run({ workflow, workflowPath: `.github/workflows/${workflow.toLowerCase()}.yml` }), [], ENVS);
    assert.equal(c.scope, "protected-branch-unknown", workflow);
    assert.equal(c.protectedEnv?.id, "production");
    assert.ok(c.protected);
    assert.match(c.why, /^unknown deployment scope — treated as a deploy to Production/);
    assert.equal(can({ role: "developer" }, "ci:rerun", c.protected), false, `${workflow}: developer refused`);
    assert.equal(can({ role: "operator" }, "ci:rerun", c.protected), true, `${workflow}: operator allowed`);
    const r = rerunRules(c, "redeploy");
    assert.deepEqual([r.confirm, r.needsReason, r.perm.protected], ["production", true, true]);
    assert.match(rerunRules(c, "tests").refused ?? "", /use redeploy/);
  }
  // Without a workflow path (an older run, or the simulated account) the name is only shown, never trusted.
  assert.equal(classify(run({ workflow: "CI", workflowPath: undefined }), [DEPLOY], ENVS).scope, "protected-branch-unknown");
});

test("a binding is the workflow FILE: renaming the workflow doesn't unbind it, and it binds on any branch", () => {
  const c = classify(run({ workflow: "Ship it", branch: "release-42", workflowPath: ".github/workflows/deploy.yml@refs/heads/release-42" }), [DEPLOY], ENVS);
  assert.equal(c.scope, "bound");
  assert.equal(c.env?.id, "production");
  assert.equal(c.protectedEnv?.id, "production");
  assert.match(c.why, /deploy\.yml deploys to Production \(ci\.deployments\)/);
  // Another repository's workflow of the same name isn't bound by this binding.
  assert.equal(classify(run({ repo: "acme/jobs", branch: "staging", workflowPath: ".github/workflows/deploy.yml" }), [DEPLOY], ENVS).scope, "none");
  // Repository names compare case-insensitively.
  assert.equal(classify(run({ repo: "Acme/Storefront-API", branch: "x", workflowPath: "./.github/workflows/deploy.yml" }), [DEPLOY], ENVS).scope, "bound");
});

test("bound to an unprotected env: not protected, but re-running only failed jobs is still refused (it deploys)", () => {
  const b: DeployBinding = { ...DEPLOY, env: "staging" };
  const c = classify(run({ branch: "staging", workflowPath: ".github/workflows/deploy.yml" }), [b], ENVS);
  assert.deepEqual([c.scope, c.env?.id, c.protected, c.protectedEnv], ["bound", "staging", false, undefined]);
  assert.deepEqual(rerunRules(c, "redeploy"), { perm: { protected: false }, confirm: "yes", needsReason: false });
  assert.match(rerunRules(c, "tests").refused ?? "", /deploys to Staging \(bound\) — use redeploy/);
});

test("unbound on an unprotected branch: not a deploy, both modes allowed", () => {
  const c = classify(run({ branch: "staging", workflowPath: ".github/workflows/ci.yml" }), [DEPLOY], ENVS);
  assert.deepEqual([c.scope, c.env?.id, c.protected], ["none", "staging", false]);
  assert.equal(rerunRules(c, "tests").refused, undefined);
  assert.equal(rerunRules(c, "redeploy").confirm, "yes");
  assert.equal(classify(run({ branch: "feature/x", workflowPath: ".github/workflows/ci.yml" }), [], ENVS).env, undefined);
});

test("one workflow bound to several envs: a push follows its branch; a dispatch's inputs aren't exposed, so the protected one wins", () => {
  const both: DeployBinding[] = [{ ...DEPLOY, env: "staging", inputs: { target: "staging" } }, { ...DEPLOY, inputs: { target: "production" } }];
  const dispatched = classify({ ...run({ branch: "staging", workflowPath: ".github/workflows/deploy.yml" }), event: "workflow_dispatch" }, both, ENVS);
  assert.equal(dispatched.scope, "bound");
  assert.equal(dispatched.protectedEnv?.id, "production");
  assert.ok(dispatched.why.includes(INPUTS_NOTE), dispatched.why);
  const pushed = classify({ ...run({ branch: "staging", workflowPath: ".github/workflows/deploy.yml" }), event: "push" }, both, ENVS);
  assert.deepEqual([pushed.env?.id, pushed.protected, pushed.protectedEnv], ["staging", false, undefined]);
  assert.match(pushed.why, /this push ran on staging/);
  const pushedMain = classify({ ...run({ workflowPath: ".github/workflows/deploy.yml" }), event: "push" }, both, ENVS);
  assert.equal(pushedMain.protectedEnv?.id, "production");
  // A push on a branch none of the bound envs use: still the protective reading.
  assert.equal(classify({ ...run({ branch: "feature/x", workflowPath: ".github/workflows/deploy.yml" }), event: "push" }, both, ENVS).protectedEnv?.id, "production");
  // Two protected envs on the pushed branch (two regions): the protected first one, and both named.
  const eu = { ...PROD, id: "production-eu-west-1", label: "Production (eu-west-1)", region: "eu-west-1" };
  const three = [...both, { ...DEPLOY, env: eu.id }];
  const two = classify({ ...run({ workflowPath: ".github/workflows/deploy.yml" }), event: "push" }, three, [...ENVS, eu]);
  assert.equal(two.protectedEnv?.id, "production");
  assert.match(two.why, /Production and Production \(eu-west-1\) share main/);
  // No event known (older callers): treated like a dispatch.
  assert.equal(classify(run({ branch: "staging", workflowPath: ".github/workflows/deploy.yml" }), both, ENVS).protectedEnv?.id, "production");
});

test("a binding to an environment that doesn't exist falls back to the branch rule, and says so", () => {
  const c = classify(run({ workflowPath: ".github/workflows/deploy.yml" }), [{ ...DEPLOY, env: "prod-old" }], ENVS);
  assert.equal(c.scope, "protected-branch-unknown");
  assert.match(c.why, /bound to unknown environment "prod-old"/);
});

test("two protected envs on one branch (two regions): the first is the target, the other is named", () => {
  const eu = { ...env("production-eu-west-1", "Production (eu-west-1)", "main", true, 2), region: "eu-west-1" };
  const c = classify(run({ workflowPath: ".github/workflows/ci.yml" }), [], [STAGING, PROD, eu]);
  assert.equal(c.protectedEnv?.id, "production");
  assert.match(c.why, /\(and Production \(eu-west-1\)\)/);
});

test("console:deploy-workflow cluster tag: space-separated files, an optional repo prefix, junk ignored", () => {
  const b = tagBindings("production", "acme/storefront-api:.github/workflows/deploy.yml  .github/workflows/release.yaml nonsense,x");
  assert.deepEqual(b, [
    { repo: "acme/storefront-api", workflow: ".github/workflows/deploy.yml", env: "production", source: "tag" },
    { workflow: ".github/workflows/release.yaml", env: "production", source: "tag" },
  ]);
  assert.deepEqual(tagBindings("production", undefined), []);
  const c = classify(run({ repo: "acme/billing", branch: "x", workflowPath: ".github/workflows/release.yaml" }), b, ENVS);
  assert.equal(c.scope, "bound", "a tag without a repo binds that file in every repository");
  assert.match(c.why, /console:deploy-workflow/);
  assert.equal(workflowFile(" ./.github/workflows/x.yml@main "), ".github/workflows/x.yml");
  assert.equal(workflowFile(""), undefined);
});

test("compare completeness: fewer than 300 files and every commit read", () => {
  assert.equal(compareComplete(299, 120, 120), true);
  assert.equal(compareComplete(300, 120, 120), false);
  assert.equal(compareComplete(10, 100, 250), false);
  assert.equal(compareComplete(10, 3, undefined), true);
});

test("R25: a 300-file comparison hiding a migration — the directory listing finds it", async () => {
  const files = Array.from({ length: 300 }, (_, i) => `src/generated/client/model-${i}.ts`);
  const base = [{ name: "20250114093000_init", sha: "a1" }];
  const head = [...base, { name: "20260901120000_refund_reason", sha: "b2" }];
  const listDir = async (path: string, at: "base" | "head") => (path === "prisma/migrations/" ? (at === "base" ? base : head) : null);
  const paths = ["prisma/migrations/", "migrations/", "db/migrate/"];
  assert.deepEqual(await decideMigrations({ files, complete: false }, paths, listDir), { changed: true, why: "prisma/migrations/ differs between the two commits (comparison truncated)" });
  // An edited migration (same name, new sha) is a change too.
  assert.equal((await decideMigrations({ files, complete: false }, paths, async (p, at) => (p === "prisma/migrations/" ? (at === "base" ? base : [{ ...base[0], sha: "zz" }]) : null))).changed, true);
  // Identical directories at both ends: no migration changed, even though the file list was cut.
  assert.deepEqual(await decideMigrations({ files, complete: false }, paths, async (p) => (p === "prisma/migrations/" ? base : null)), { changed: false });
  // A complete comparison is read directly; a truncated one that already names a migration is a change.
  assert.deepEqual(await decideMigrations({ files: ["src/a.ts"], complete: true }, paths), { changed: false });
  assert.deepEqual(await decideMigrations({ files: [...files.slice(1), "prisma/migrations/x/migration.sql"], complete: false }, paths), { changed: true });
});

test("R25: both incomplete (comparison and listings) → unknown, never 'no migrations'", async () => {
  const files = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);
  const nothing = async () => null;
  assert.equal((await decideMigrations({ files, complete: false }, ["prisma/migrations/"], nothing)).changed, "unknown");
  assert.equal((await decideMigrations({ files, complete: false }, ["prisma/migrations/"])).changed, "unknown", "no listDir");
  assert.equal((await decideMigrations(null, ["prisma/migrations/"])).changed, "unknown");
  const oneSide = await decideMigrations({ files, complete: false }, ["prisma/migrations/"], async (_p, at) => (at === "base" ? [{ name: "x", sha: "1" }] : null));
  assert.equal(oneSide.changed, "unknown");
  assert.match(oneSide.why ?? "", /only one of the two commits/);
  const failed = await decideMigrations({ files, complete: false }, ["prisma/migrations/"], async () => {
    throw new Error("GitHub 403");
  });
  assert.deepEqual(failed, { changed: "unknown", why: "GitHub truncated the comparison and prisma/migrations/ couldn't be listed (GitHub 403)" });
  assert.deepEqual(migrationsFromListings([]), { changed: "unknown", why: "GitHub truncated the comparison and no migrations directory could be listed" });
  assert.deepEqual(await decideMigrations({ files, complete: false }, []), { changed: false }, "no migrations paths: nothing to check");
});

test("R25 against the simulated account: a range across the 320-file bulk push is truncated, and its migration still counts", async () => {
  const ci = mockCi();
  const repo = "acme/storefront-api";
  const shas = [...new Set((await ci.runs(repo, "main", 200)).map((r) => r.sha))];
  const [head, base] = [shas[0], shas[shas.length - 1]];
  const cmp = await ci.compare(repo, base, head);
  assert.equal(cmp?.complete, false);
  const r = await decideMigrations(cmp, ["prisma/migrations/", "migrations/"], (path, at) => ci.listDir!(repo, path, at === "base" ? base : head));
  assert.equal(r.changed, true);
});

// ---------- github.ts (no server-only import): run mapping, compare completeness, listDir, ETag LRU, log tail ----------

const ghRun = { id: 7, name: "CI", head_branch: "main", head_sha: "a".repeat(40), display_title: "t", event: "push", status: "completed", conclusion: "success", run_attempt: 1, created_at: "2026-10-05T10:00:00Z", updated_at: "2026-10-05T10:05:00Z", html_url: "https://github.com/acme/api/actions/runs/7" };

async function withFetch<T>(handler: (url: string, init?: RequestInit) => Response, fn: () => Promise<T>, token: string | null = "test-token"): Promise<T> {
  const real = globalThis.fetch;
  const saved = process.env.GITHUB_TOKEN;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => handler(String(u), init)) as typeof fetch;
  if (token === null) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = token;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
}
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("github: a run carries its workflow file and id (R03)", async () => {
  const { toRun } = await import("./server/github.ts");
  const r = toRun("acme/api", { ...ghRun, path: ".github/workflows/ci.yml@main", workflow_id: 99 });
  assert.equal(r.workflowPath, ".github/workflows/ci.yml@main");
  assert.equal(r.workflowId, 99);
  assert.equal(workflowFile(r.workflowPath), ".github/workflows/ci.yml");
  assert.equal("workflowPath" in toRun("acme/api", ghRun), false);
});

test("github: compare pages its commits and is incomplete at 300 files or unread commits (R25)", async () => {
  const { githubCi } = await import("./server/github.ts");
  const commit = (i: number) => ({ sha: `c${i}`, commit: { message: `m${i}\nbody`, author: { name: "a", date: "d" } } });
  const seen: string[] = [];
  const page = (n: number, total: number, files: number) => (url: string) => {
    seen.push(url);
    const p = Number(new URL(url).searchParams.get("page"));
    const commits = Array.from({ length: Math.max(0, Math.min(100, total - (p - 1) * 100)) }, (_, i) => commit((p - 1) * 100 + i));
    return jsonRes({ ahead_by: total, behind_by: n, total_commits: total, files: Array.from({ length: files }, (_, i) => ({ filename: `src/f${i}.ts` })), commits });
  };
  const c = await withFetch(page(2, 250, 12), () => githubCi().compare("acme/api", "aaa", "bbb"));
  assert.equal(seen.length, 3, "250 commits = 3 pages of 100");
  assert.equal(c?.commits.length, 250);
  assert.deepEqual([c?.commits[0].sha, c?.commits[0].title, c?.behindBy], ["c0", "m0", 2], "oldest first, first line only");
  assert.equal(c?.complete, true);
  assert.equal((await withFetch(page(0, 3, 300), () => githubCi().compare("acme/api", "aaa", "ccc")))?.complete, false, "300 files");
  seen.length = 0;
  const long = await withFetch(page(0, 2500, 3), () => githubCi().compare("acme/api", "aaa", "ddd"));
  assert.equal(long?.complete, false, "commits beyond the pages read");
  assert.equal(seen.length, 10, "at most 10 pages");
  assert.deepEqual(seen.map((u) => Number(new URL(u).searchParams.get("page"))), [1, 17, 18, 19, 20, 21, 22, 23, 24, 25], "the first page (files) and the newest nine");
  assert.equal(long?.commits.at(-1)?.sha, "c2499", "the newest commit is always read (Releases lists the newest 50)");
  assert.equal(long?.files.length, 3, "files come from the first page");
});

test("github: listDir is null for a missing path, a file, or a possibly cut listing; a missing token is 'not configured' (F37)", async () => {
  const { githubCi } = await import("./server/github.ts");
  const ci = githubCi();
  const dir = [{ name: "20250114093000_init", sha: "s1", type: "dir" }];
  let asked = "";
  assert.deepEqual(await withFetch((u) => ((asked = u), jsonRes(dir)), () => ci.listDir!("acme/api", "/prisma/migrations/", "main")), [{ name: "20250114093000_init", sha: "s1" }]);
  assert.equal(asked, "https://api.github.com/repos/acme/api/contents/prisma/migrations?ref=main");
  assert.equal(await withFetch(() => jsonRes({ message: "Not Found" }, 404), () => ci.listDir!("acme/api", "db/migrate", "main")), null);
  assert.equal(await withFetch(() => jsonRes({ type: "file", name: "x" }), () => ci.listDir!("acme/api", "x", "main")), null);
  assert.equal(await withFetch(() => jsonRes(Array.from({ length: 1000 }, (_, i) => ({ name: `m${i}`, sha: "s" }))), () => ci.listDir!("acme/api", "m", "main")), null);
  await assert.rejects(withFetch(() => jsonRes({}, 500), () => ci.listDir!("acme/api", "m", "main")), /GitHub 500/);
  await assert.rejects(
    withFetch(() => jsonRes([]), () => ci.runs("acme/api", "main", 5), null),
    (e: unknown) => (e as { code?: string; status?: number; setup?: string }).code === "not_configured" && (e as { status?: number }).status === 503 && (e as { setup?: string }).setup === "/docs/github",
  );
});

test("github: the ETag store is an LRU of 500 that never keeps immutable compares or commits (F28)", async () => {
  const { rememberEtag } = await import("./server/github.ts");
  const m = new Map<string, { etag: string; body: unknown }>();
  for (let i = 0; i < 520; i++) rememberEtag(m, `https://api.github.com/repos/a/b/actions/runs?page=${i}`, `e${i}`, i);
  assert.equal(m.size, 500);
  assert.equal(m.has("https://api.github.com/repos/a/b/actions/runs?page=0"), false, "oldest evicted");
  rememberEtag(m, `https://api.github.com/repos/a/b/compare/${"a".repeat(40)}...${"b".repeat(40)}?per_page=100&page=1`, "e", {});
  rememberEtag(m, `https://api.github.com/repos/a/b/commits/${"f".repeat(40)}`, "e", {});
  assert.equal(m.size, 500);
  assert.equal([...m.keys()].some((k) => k.includes("/compare/") || k.includes("/commits/")), false);
  // A compare against a branch changes as the branch moves: it keeps its ETag, so the minute-by-minute check is a 304.
  rememberEtag(m, `https://api.github.com/repos/a/b/compare/${"a".repeat(40)}...main?per_page=100&page=1`, "e", {});
  assert.equal([...m.keys()].at(-1)?.endsWith("...main?per_page=100&page=1"), true);
});

test("github: a branch compare answers a 304 from its slimmed body (no patches held)", async () => {
  const { githubCi } = await import("./server/github.ts");
  const ci = githubCi();
  const full = { ahead_by: 2, behind_by: 0, total_commits: 2, files: [{ filename: "prisma/migrations/x/migration.sql", patch: "x".repeat(50_000) }], commits: [0, 1].map((i) => ({ sha: `c${i}`, commit: { message: `m${i}\nbody`, author: { name: "a", date: "d" } } })) };
  const sent: (string | undefined)[] = [];
  const handler = (_u: string, init?: RequestInit) => {
    const inm = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"];
    sent.push(inm);
    return inm === '"v1"' ? new Response(null, { status: 304 }) : new Response(JSON.stringify(full), { status: 200, headers: { etag: '"v1"', "content-type": "application/json" } });
  };
  const sha = "e".repeat(40);
  const a = await withFetch(handler, () => ci.compare("acme/etag", sha, "main"));
  const b = await withFetch(handler, () => ci.compare("acme/etag", sha, "main"));
  assert.deepEqual(sent, [undefined, '"v1"']);
  assert.deepEqual(b, a);
  assert.deepEqual(b?.files, ["prisma/migrations/x/migration.sql"]);
  assert.deepEqual(b?.commits.map((c) => c.title), ["m0", "m1"]);
});

test("github: a job log is read as a stream keeping only the newest bytes (F28)", async () => {
  const { readTail } = await import("./server/github.ts");
  const lines = Array.from({ length: 5000 }, (_, i) => `2026-10-05T10:00:00.000Z line ${i}`);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (let i = 0; i < lines.length; i += 100) c.enqueue(enc.encode(lines.slice(i, i + 100).join("\n") + "\n"));
      c.close();
    },
  });
  const r = await readTail(new Response(body), 10_000);
  assert.equal(r.cut, true);
  assert.ok(r.text.length <= 10_000);
  assert.ok(r.text.endsWith("line 4999\n"));
  assert.match(r.text.split("\n")[0], /^2026-10-05T10:00:00.000Z line \d+$/, "the partial first line is dropped");
  const small = await readTail(new Response("a\nb\n"), 10_000);
  assert.deepEqual(small, { text: "a\nb\n", cut: false });
});
