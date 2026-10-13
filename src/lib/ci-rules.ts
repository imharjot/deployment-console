// Which environment a CI run deploys to, and the rules for re-running it (R03), plus how a migration check reads a
// truncated GitHub comparison (R25). Pure: src/lib/server/ci.ts feeds it the run, the bindings and the envs.
//
// A workflow's name is not its identity — anyone can rename "Deploy" to "CI". A run is bound to an environment by its
// workflow FILE (`.github/workflows/deploy.yml`), through console.config.json `ci.deployments` or a
// `console:deploy-workflow` tag on the environment's ECS cluster. A run that isn't bound but ran on a protected
// environment's branch might deploy there (GitHub doesn't expose workflow_dispatch inputs on a run), so it is treated
// as a deploy to that environment: the conservative reading.
import type { CiRun, EnvInfo } from "./types.ts";

export interface DeployBinding {
  repo?: string; // "owner/name"; undefined = any repository (a cluster tag without a repo prefix)
  workflow: string; // the workflow file's path, ".github/workflows/deploy.yml"
  env: string; // environment id
  source: "config" | "tag";
  inputs?: Record<string, string>; // workflow_dispatch inputs that select this target (config only)
}

export type DeployScope = "bound" | "protected-branch-unknown" | "none";

export interface DeployClass {
  scope: DeployScope;
  env?: EnvInfo; // where it deploys (bound), or the env whose branch it ran on
  protectedEnv?: EnvInfo; // set when re-running it is a deploy to a protected environment
  protected: boolean;
  why: string;
  bindings?: DeployBinding[]; // the bindings that matched (bound only)
}

// GitHub exposes no workflow_dispatch inputs on a run, so a binding's `inputs` can never be checked against one.
export const INPUTS_NOTE = "inputs: not exposed by GitHub (treated as unknown)";

export const DEPLOY_WORKFLOW_TAG = "console:deploy-workflow";

// GitHub reports a run's workflow as ".github/workflows/build.yml" — or with the ref it was read from,
// ".github/workflows/build.yml@main" (reusable and some dispatched runs). Compared without the ref and leading "./".
export function workflowFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const p = path.trim().replace(/@.*$/, "").replace(/^\.?\/+/, "");
  return p || undefined;
}

// The cluster tag: one or more workflow files separated by spaces (AWS tag values can't hold commas), each optionally
// prefixed with its repository: "acme/storefront-api:.github/workflows/deploy.yml .github/workflows/release.yml".
export function tagBindings(env: string, value: string | undefined): DeployBinding[] {
  if (!value) return [];
  const out: DeployBinding[] = [];
  for (const part of value.trim().split(/\s+/)) {
    const m = /^(?:([\w.-]+\/[\w.-]+):)?(\.?\/?\.github\/workflows\/[\w./-]+\.ya?ml)$/.exec(part);
    if (!m) continue;
    const workflow = workflowFile(m[2]);
    if (workflow) out.push({ ...(m[1] ? { repo: m[1] } : {}), workflow, env, source: "tag" });
  }
  return out;
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase(); // GitHub owner/name are case-insensitive

// Bound → that env; unbound on a protected env's branch → treated as a deploy there; otherwise not a deploy.
// Events whose run can carry inputs (or a caller's choice of target) that GitHub doesn't show on the run.
const DISPATCHED = new Set(["workflow_dispatch", "repository_dispatch", "workflow_call"]);

export function classify(run: Pick<CiRun, "repo" | "workflow" | "branch" | "workflowPath"> & { event?: string }, bindings: DeployBinding[], envs: EnvInfo[]): DeployClass {
  const file = workflowFile(run.workflowPath);
  const byId = new Map(envs.map((e) => [e.id, e]));
  const matched = file ? bindings.filter((b) => workflowFile(b.workflow) === file && (!b.repo || sameRepo(b.repo, run.repo))) : [];
  const known = matched.filter((b) => byId.has(b.env));
  const onBranch = envs.filter((e) => e.branch && e.branch === run.branch);
  const label = (e: EnvInfo) => e.label;

  if (known.length) {
    const targets = [...new Set(known.map((b) => b.env))].map((id) => byId.get(id)!);
    // One workflow bound to several environments: a pushed run's target follows its branch (deploy.yml on staging →
    // Staging, on main → Production). A dispatched run may have chosen its target with inputs, which a run doesn't
    // expose: the most protective reading wins (a protected target, preferring the one on the run's branch).
    const pushed = !!run.event && !DISPATCHED.has(run.event); // an unknown event counts as dispatched
    const byBranch = targets.length > 1 && pushed ? targets.filter((e) => e.branch === run.branch) : [];
    const prot = targets.filter((e) => e.protected);
    const pick = byBranch.length === 1 ? byBranch[0] : (prot.find((e) => e.branch === run.branch) ?? prot[0] ?? targets.find((e) => e.branch === run.branch) ?? targets[0]);
    const src = [...new Set(known.map((b) => (b.source === "config" ? "ci.deployments" : DEPLOY_WORKFLOW_TAG)))].join(" + ");
    const several =
      targets.length < 2
        ? ""
        : byBranch.length === 1
          ? `; bound to ${targets.length} environments, this ${run.event} ran on ${run.branch}`
          : byBranch.length > 1
            ? `; ${byBranch.map((e) => e.label).join(" and ")} share ${run.branch} — treated as a deploy to ${pick.label}`
            : `; one of ${targets.length} bound environments, ${INPUTS_NOTE} — treated as a deploy to ${pick.label}`;
    return {
      scope: "bound", env: pick, ...(pick.protected ? { protectedEnv: pick } : {}), protected: pick.protected, bindings: known,
      why: `${file} deploys to ${pick.label} (${src})${several}`,
    };
  }

  const unknownEnvs = [...new Set(matched.map((b) => b.env))];
  const stray = unknownEnvs.length ? ` (bound to unknown environment ${unknownEnvs.map((x) => `"${x}"`).join(", ")})` : "";
  const prot = onBranch.filter((e) => e.protected);
  if (prot.length) {
    const others = prot.length > 1 ? ` (and ${prot.slice(1).map(label).join(", ")})` : "";
    return {
      scope: "protected-branch-unknown", env: prot[0], protectedEnv: prot[0], protected: true,
      why: `unknown deployment scope — treated as a deploy to ${prot[0].label}${others}: ${file ?? `"${run.workflow}"`} isn't bound to an environment and ran on ${run.branch}${stray}`,
    };
  }
  return {
    scope: "none", ...(onBranch[0] ? { env: onBranch[0] } : {}), protected: false,
    why: `not a deployment: ${file ?? `"${run.workflow}"`} isn't bound to an environment and ${run.branch} is no protected environment's branch${stray}`,
  };
}

// ---------- re-run modes ----------

export type RerunMode = "tests" | "redeploy";

export interface RerunRules {
  perm: { protected: boolean }; // re-running needs ci:rerun, or ci:rerun:protected
  confirm: string; // the text to type: the protected env's id, else "yes"
  needsReason: boolean;
  refused?: string; // why this mode can't be used for this run
}

// "tests" re-runs the failed jobs only — for a workflow that deploys (or may: unknown on a protected branch) that would
// be a partial deploy, so it is refused ("use redeploy"). "redeploy" re-runs every job; on a protected env it needs the
// protected permission, the env id typed and a reason.
export function rerunRules(c: DeployClass, mode: RerunMode): RerunRules {
  const deploys = c.scope !== "none";
  return {
    perm: { protected: c.protected },
    confirm: c.protectedEnv?.id ?? "yes",
    needsReason: c.protected,
    ...(mode === "tests" && deploys
      ? { refused: `re-running only the failed jobs is refused for a workflow that deploys${c.env ? ` to ${c.env.label}` : ""} (${c.scope === "bound" ? "bound" : "unknown deployment scope"}) — use redeploy` }
      : {}),
  };
}

// ---------- migrations across a comparison (R25) ----------

// GitHub's compare lists at most 300 files (no pagination for files) and pages its commits: a comparison is complete
// only when fewer than 300 files came back and every commit was read.
export const COMPARE_FILE_CAP = 300;
export const compareComplete = (files: number, commitsRead: number, totalCommits: number | undefined) =>
  files < COMPARE_FILE_CAP && (totalCommits === undefined || commitsRead >= totalCommits);

export type Listing = { name: string; sha: string }[] | null;
export interface DirPair {
  path: string;
  base: Listing; // null: not found, or the listing was cut short
  head: Listing;
  error?: string; // the listing couldn't be read at all
}

// A truncated comparison can't prove that no migration changed. Each migrations directory is listed at both commits
// instead (entries carry their git sha, so an edited migration shows too): any difference = changed; identical = not
// changed there; missing at both = no such directory. A directory listed at only one commit, a failed listing, or no
// directory found anywhere stays unknown — never "no migrations".
export function migrationsFromListings(pairs: DirPair[]): { changed: boolean | "unknown"; why?: string } {
  const key = (l: { name: string; sha: string }[]) => l.map((e) => `${e.name}@${e.sha}`).sort().join("\n");
  let unknown: string | undefined;
  let compared = 0;
  for (const p of pairs) {
    if (p.error) {
      unknown ??= `${p.path} couldn't be listed (${p.error})`;
      continue;
    }
    if (p.base === null && p.head === null) continue;
    if (p.base === null || p.head === null) {
      unknown ??= `${p.path} could be listed at only one of the two commits`;
      continue;
    }
    if (key(p.base) !== key(p.head)) return { changed: true, why: `${p.path} differs between the two commits (comparison truncated)` };
    compared++;
  }
  if (unknown) return { changed: "unknown", why: `GitHub truncated the comparison and ${unknown}` };
  if (!compared) return { changed: "unknown", why: "GitHub truncated the comparison and no migrations directory could be listed" };
  return { changed: false };
}

// Whether migrations changed between two commits, from a comparison (complete or not) and, when it was truncated, the
// migrations directories listed at both commits. `listDir` is absent when the CI source can't list directories.
export async function decideMigrations(
  cmp: { files: string[]; complete?: boolean } | null,
  paths: string[],
  listDir?: (path: string, at: "base" | "head") => Promise<Listing>,
): Promise<{ changed: boolean | "unknown"; why?: string }> {
  if (!paths.length) return { changed: false };
  if (!cmp) return { changed: "unknown", why: "compare failed" };
  const touches = cmp.files.some((f) => paths.some((p) => f.startsWith(p)));
  if (cmp.complete !== false || touches) return { changed: touches }; // a migration in a truncated list is still a change
  if (!listDir) return { changed: "unknown", why: "GitHub truncated the comparison (300 files or more)" };
  const pairs = await Promise.all(
    paths.map(async (path): Promise<DirPair> => {
      try {
        const [base, head] = await Promise.all([listDir(path, "base"), listDir(path, "head")]);
        return { path, base, head };
      } catch (e) {
        return { path, base: null, head: null, error: (e as Error)?.message ?? String(e) };
      }
    }),
  );
  return migrationsFromListings(pairs);
}

// Why a comparison couldn't be made, in a few words (the revisions list and Releases show it next to "unknown").
export function compareWhy(e: unknown): string {
  const err = e as { status?: number; code?: string; message?: string } | undefined;
  const msg = String(err?.message ?? e ?? "");
  if (err?.code === "not_configured" || err?.status === 401 || /GITHUB_TOKEN is not set|not connected/i.test(msg)) return "GitHub not connected";
  if (err?.status === 429 || /rate limit/i.test(msg)) return "GitHub rate limit reached";
  if (err?.status === 404) return "commit not found on GitHub";
  return "compare failed";
}
