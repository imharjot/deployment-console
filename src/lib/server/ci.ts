import "server-only";
import {
  DEPLOY_WORKFLOW_TAG, INPUTS_NOTE, classify, compareWhy, decideMigrations, rerunRules, tagBindings, workflowFile, type DeployBinding, type DeployClass,
  type RerunMode,
} from "../ci-rules.ts";
import { canonicalKey } from "../mutation-keys.ts";
import { can, roleFor, type User } from "../rbac.ts";
import type { CiJob, CiRun, EnvInfo, TestReport } from "../types.ts";
import { cached, invalidate } from "./cache.ts";
import { HttpError, errText } from "./errors.ts";
import { consoleConfig, knownRepos, listEnvs } from "./discovery.ts";
import { mutate, type MutationActor } from "./mutations.ts";
import { getCi, getCloud } from "./sources.ts";

// Only repositories that discovery mapped to a running service can be read or re-run through the console.
export async function assertRepo(repo: string | null): Promise<string> {
  if (!repo || !(await knownRepos()).includes(repo)) throw new HttpError(400, "unknown repo");
  return repo;
}

export async function runs(repo: string, branch: string | undefined): Promise<CiRun[]> {
  const ci = await getCi();
  return (await cached(`runs:${repo}:${branch ?? "*"}`, 10_000, () => ci.runs(repo, branch, 25))).value;
}

// What the run detail says about deploying (R03): the resolved environment, how sure that is, and what each re-run
// mode needs. The CI page shows it next to the re-run buttons; the server re-checks everything on the re-run itself.
export interface DeployView {
  scope: DeployClass["scope"];
  env?: string;
  envLabel?: string;
  protected: boolean;
  why: string;
  inputs: string;
  confirm: string;
  needsReason: boolean;
  needs: string; // the role a re-run needs
  testsRefused?: string; // why "re-run failed jobs" can't be used
}

export async function runDetail(repo: string, id: number): Promise<{ run: CiRun; jobs: CiJob[]; tests: TestReport | null; testsError?: string; deploy?: DeployView; deployError?: string }> {
  const ci = await getCi();
  const [run, jobs] = await Promise.all([
    cached(`run:${repo}:${id}`, 5_000, () => ci.run(repo, id)).then((r) => r.value),
    cached(`jobs:${repo}:${id}`, 5_000, () => ci.jobs(repo, id)).then((r) => r.value),
  ]);
  let tests: TestReport | null = null;
  let testsError: string | undefined;
  if (run.status === "completed") {
    try {
      tests = await ci.tests(repo, id);
    } catch (e) {
      testsError = errText(e);
    }
  }
  let deploy: DeployView | undefined;
  let deployError: string | undefined;
  try {
    const t = await deployTarget(run);
    const redeploy = rerunRules(t, "redeploy");
    const tests = rerunRules(t, "tests");
    deploy = {
      scope: t.scope, ...(t.env ? { env: t.env.id, envLabel: t.env.label } : {}), protected: t.protected, why: t.why, inputs: INPUTS_NOTE,
      confirm: redeploy.confirm, needsReason: redeploy.needsReason, needs: roleFor("ci:rerun", t.protected),
      ...(tests.refused ? { testsRefused: tests.refused } : {}),
    };
  } catch (e) {
    deployError = errText(e);
  }
  return { run, jobs, tests, testsError, ...(deploy ? { deploy } : {}), ...(deployError ? { deployError } : {}) };
}

// A job log is kept only as its tail (F28): the newest maxLines lines, at most 1 MB, plus the line count. GitHub
// serves the newest megabyte (github.ts), so a 200 MB build log never sits in memory.
const LOG_TAIL_BYTES = 1024 * 1024;
export function tailOf(text: string, maxLines: number): { lines: string[]; total: number } {
  const all = text.split("\n");
  if (all.length && all[all.length - 1] === "") all.pop();
  let lines = all.slice(-maxLines);
  let bytes = 0;
  let from = lines.length;
  while (from > 0 && bytes + lines[from - 1].length + 1 <= LOG_TAIL_BYTES) bytes += lines[--from].length + 1;
  if (from > 0) lines = lines.slice(from);
  return { lines, total: all.length };
}

export async function jobLog(repo: string, jobId: number, maxLines = 2000): Promise<{ lines: string[]; total: number }> {
  if (!Number.isInteger(jobId) || jobId <= 0) throw new HttpError(400, "job id must be a positive number");
  const ci = await getCi();
  return (await cached(`joblog:${repo}:${jobId}:${maxLines}`, 10_000, async () => tailOf(await ci.jobLog(repo, jobId), maxLines))).value;
}

// ---------- deployment target (R03) ----------

// Bindings from console.config.json (ci.deployments) and from the console:deploy-workflow tag of each env's cluster.
// A tag that can't be read is reported (`tagError`): a re-run that nothing else marks as a deploy is then refused.
async function deployBindings(envs: EnvInfo[]): Promise<{ bindings: DeployBinding[]; tagError?: string }> {
  const fromConfig: DeployBinding[] = (consoleConfig().config.ci?.deployments ?? []).map((d) => ({ repo: d.repo, workflow: d.workflow, env: d.env, source: "config", ...(d.inputs ? { inputs: d.inputs } : {}) }));
  const regions = [...new Set(envs.map((e) => e.region))];
  const tags: DeployBinding[] = [];
  let tagError: string | undefined;
  await Promise.all(
    regions.map(async (region) => {
      try {
        const clusters = (await cached(`ci:clusters@${region}`, 60_000, async () => (await getCloud(region)).clusters())).value;
        for (const e of envs.filter((x) => x.region === region)) {
          const c = clusters.find((x) => x.name === e.cluster);
          if (c && Object.hasOwn(c.tags, DEPLOY_WORKFLOW_TAG)) tags.push(...tagBindings(e.id, c.tags[DEPLOY_WORKFLOW_TAG]));
        }
      } catch (err) {
        tagError ??= `${region}: ${errText(err)}`;
      }
    }),
  );
  return { bindings: [...fromConfig, ...tags], ...(tagError ? { tagError } : {}) };
}

// Re-running a workflow that deploys to a protected env IS a deploy to that env: typed env id + reason + the protected
// permission. "Deploys" means bound to it by workflow file, or — unknown scope, treated conservatively — run on its
// branch. The workflow's name decides nothing (REVIEW R03).
export async function deployTarget(run: CiRun): Promise<DeployClass & { tagError?: string }> {
  const envs = await listEnvs();
  const { bindings, tagError } = await deployBindings(envs);
  const c = classify(run, bindings, envs);
  return tagError ? { ...c, tagError, why: `${c.why} · cluster tags unreadable (${tagError})` } : c;
}

// One classifier for many runs (deploy markers, the activity feed): envs and bindings are read once.
export async function deployClassifier(): Promise<(run: CiRun) => DeployClass> {
  const envs = await listEnvs();
  const { bindings } = await deployBindings(envs);
  return (run) => classify(run, bindings, envs);
}

// ---------- re-run (R03, R04) ----------

export interface RerunPlan {
  repo: string;
  run: number;
  workflow: string;
  workflowPath?: string;
  branch: string;
  sha: string;
  mode: RerunMode;
  jobs: "failed jobs" | "all jobs";
  scope: DeployClass["scope"];
  env?: string;
  envLabel?: string;
  protected: boolean;
  why: string;
  inputs: string;
  confirm: string; // what to type
  needsReason: boolean;
  needs: string; // role
  refused?: string;
}

export interface RerunOptions {
  repo: string;
  mode?: RerunMode;
  confirm?: string;
  reason?: string;
  actor?: MutationActor; // the operations registry's actor (token, agent); default: `who` as a person
}

// The re-run route's body: { mode?, confirm?, reason? } (failedOnly: true is the older spelling of mode "tests").
export function parseRerunBody(body: unknown): { mode: RerunMode; confirm?: string; reason?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be an object");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !["mode", "failedOnly", "confirm", "reason"].includes(k));
  if (extra.length) throw new HttpError(400, `unknown field(s): ${extra.join(", ")}`);
  const own = (k: string) => (Object.hasOwn(b, k) ? b[k] : undefined);
  const mode = own("mode");
  if (mode !== undefined && mode !== "tests" && mode !== "redeploy") throw new HttpError(400, 'mode must be "tests" or "redeploy"');
  const failedOnly = own("failedOnly");
  if (failedOnly !== undefined && typeof failedOnly !== "boolean") throw new HttpError(400, "failedOnly must be true or false");
  const confirm = own("confirm");
  if (confirm !== undefined && (typeof confirm !== "string" || confirm.length > 200)) throw new HttpError(400, "confirm must be a string");
  const reason = own("reason");
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) throw new HttpError(400, "reason must be a string ≤ 500 chars");
  return { mode: (mode as RerunMode | undefined) ?? (failedOnly === true ? "tests" : "redeploy"), ...(confirm !== undefined ? { confirm } : {}), ...(reason !== undefined ? { reason } : {}) };
}

// The whole re-run path in one place (master plan §3.3): classification, permission, the protected confirmation and the
// coordinator. Without `confirm` it only answers the plan (what it would re-run, where that deploys, what to type).
// The route and the ci.rerun operation both call it, so the two surfaces can't disagree.
export async function rerunCiRun(runId: number, o: RerunOptions, who: User, ip?: string): Promise<{ plan: RerunPlan } | { result: { ok: true; operationId: string; plan: RerunPlan } }> {
  if (!Number.isInteger(runId) || runId <= 0) throw new HttpError(400, "run id must be a positive number");
  const mode: RerunMode = o.mode ?? "redeploy";
  if (mode !== "tests" && mode !== "redeploy") throw new HttpError(400, 'mode must be "tests" or "redeploy"');
  if (o.reason !== undefined && (typeof o.reason !== "string" || o.reason.length > 500)) throw new HttpError(400, "reason must be a string ≤ 500 chars");
  const repo = await assertRepo(o.repo);
  const ci = await getCi();
  const run = await ci.run(repo, runId);
  const t = await deployTarget(run);
  const rules = rerunRules(t, mode);
  const plan: RerunPlan = {
    repo, run: run.id, workflow: run.workflow, ...(run.workflowPath ? { workflowPath: run.workflowPath } : {}), branch: run.branch, sha: run.sha, mode,
    jobs: mode === "tests" ? "failed jobs" : "all jobs", scope: t.scope, ...(t.env ? { env: t.env.id, envLabel: t.env.label } : {}), protected: t.protected,
    why: t.why, inputs: INPUTS_NOTE, confirm: rules.confirm, needsReason: rules.needsReason, needs: roleFor("ci:rerun", t.protected),
    ...(rules.refused ? { refused: rules.refused } : {}),
  };
  if (o.confirm === undefined) return { plan };

  if (run.status !== "completed") throw new HttpError(409, "run is still in progress");
  if (rules.refused) throw new HttpError(400, rules.refused);
  // Nothing marked this run as a deploy, but the cluster tags that could have weren't readable: refuse rather than guess.
  if (t.scope === "none" && t.tagError) throw new HttpError(503, `can't tell whether this run deploys: the ${DEPLOY_WORKFLOW_TAG} cluster tags couldn't be read (${t.tagError})`);
  if (!can(who, "ci:rerun", t.protected)) throw new HttpError(403, `your role (${who.role}) can't re-run this — needs ${plan.needs}${t.protectedEnv ? ` (it deploys to ${t.protectedEnv.label})` : ""}`);
  if (o.confirm !== rules.confirm) throw new HttpError(400, `confirmation text does not match (expected "${rules.confirm}")`);
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  if (rules.needsReason && reason.length < 3) throw new HttpError(400, `a reason is required for a deploy to ${t.protectedEnv?.label ?? t.env?.label ?? "a protected environment"}`);

  const actor: MutationActor = o.actor ?? { display: who.email, kind: "person", userId: who.id, ...(ip ? { ip } : {}) };
  const env = t.protectedEnv ?? t.env;
  const { operationId } = await mutate(
    {
      action: mode === "tests" ? "ci.rerun-failed" : "ci.rerun",
      actor,
      ...(env ? { env: { id: env.id, label: env.label, protected: t.protected, region: env.region } } : {}),
      target: `${repo}#${run.id}`,
      keys: [canonicalKey({ ci: { repo, workflow: workflowFile(run.workflowPath) ?? `workflow-name/${run.workflow}` } })],
      ...(reason ? { reason } : {}),
      params: { workflow: run.workflow, workflowPath: run.workflowPath, branch: run.branch, sha: run.sha, mode, scope: t.scope, deploysTo: env?.id, inputs: "not exposed by GitHub" },
    },
    async (h) => {
      // Under the workflow's key: read the run again (another re-run may have started it meanwhile), then act.
      const live = await ci.run(repo, run.id);
      if (live.status !== "completed") throw new HttpError(409, "run is running again — another re-run started it");
      await h.intent({ attempt: live.attempt });
      await ci.rerun(repo, run.id, mode === "tests");
      return { attempt: live.attempt };
    },
  );
  invalidate(`runs:${repo}`);
  invalidate(`run:${repo}:${run.id}`);
  invalidate(`jobs:${repo}:${run.id}`);
  return { result: { ok: true, operationId, plan } };
}

// ---------- migrations between two commits (R25) ----------

// true / false / "unknown" (+ why). A comparison GitHub truncated (300 files, or commits beyond the pages read) is
// checked by listing each migrations directory at both commits; anything it can't prove stays "unknown".
export async function migrationsChanged(repo: string, base: string, head: string, paths: string[]): Promise<{ changed: boolean | "unknown"; why?: string }> {
  if (!paths.length) return { changed: false };
  try {
    const ci = await getCi();
    const cmp = (await cached(`cmp:${repo}:${base}:${head}`, 10 * 60_000, () => ci.compare(repo, base, head))).value;
    const listDir = ci.listDir
      ? async (path: string, at: "base" | "head") => {
          const ref = at === "base" ? base : head;
          return (await cached(`ls:${repo}:${ref}:${path}`, 10 * 60_000, () => ci.listDir!(repo, path, ref))).value;
        }
      : undefined;
    return await decideMigrations(cmp, paths, listDir);
  } catch (e) {
    return { changed: "unknown", why: compareWhy(e) };
  }
}
