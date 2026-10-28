"use client";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, CircleDashed, ExternalLink, GitBranch, Loader2, Lock, MinusCircle, RotateCw, Rocket, X, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useConfirm } from "@/components/confirm";
import { FreshnessBanner } from "@/components/freshness-banner";
import { Row, Sheet, Swap, spring, useFresh } from "@/components/motion";
import { StaticLog } from "@/components/logs/log-viewer";
import { CreateTicketButton, ciTicket } from "@/components/ticket-button";
import { useToast } from "@/components/toast";
import { useMe } from "@/components/user-menu";
import { Button, Chip, Empty, IconButton, Segmented, Skeleton, TimeAgo, cx, useNow } from "@/components/ui";
import { ApiError, postJson } from "@/lib/client/api";
import { loadedAt, trackedJson, useEnv, useEnvList } from "@/lib/client/env";
import { duration, keptFreshness, repoName, shortSha } from "@/lib/client/format";
import { roleFor } from "@/lib/rbac";
import type { CiJob, CiRun, TestReport } from "@/lib/types";
import { Page, PageHeader, SectionTitle, TAP } from "../_components/page-frame";
import { ScrollX } from "../_components/scroll-x";

// What the run detail says about deploying (R03, server/ci.ts DeployView): the resolved environment, how sure that
// is, and what each re-run mode needs. The server checks all of it again on the re-run itself.
interface DeployView {
  scope: "bound" | "protected-branch-unknown" | "none";
  env?: string;
  envLabel?: string;
  protected: boolean;
  why: string;
  inputs: string;
  confirm: string;
  needsReason: boolean;
  needs: string;
  testsRefused?: string;
}
type RunDetail = { run: CiRun; jobs: CiJob[]; tests: TestReport | null; testsError?: string; deploy?: DeployView; deployError?: string };

// GitHub isn't connected (503 not_configured, F37): say so and link the setup instead of an error.
const notConnected = (e: unknown) => e instanceof ApiError && (e.code === "not_configured" || (e.status === 503 && !e.code));
function ConnectGitHub({ message, setup }: { message?: string; setup?: string }) {
  return (
    <Empty
      icon={<GitBranch className="size-5" />}
      title="Connect GitHub to see runs"
      hint={
        <>
          {message ? <>{message}. </> : null}
          Set a GitHub token for the console to list workflow runs, steps, logs and test results.{" "}
          <Link href={setup?.startsWith("/") ? setup : "/docs/github"} className="text-accent hover:underline">How to connect GitHub</Link>
        </>
      }
    />
  );
}

// "deploys to Production" / "unknown scope — treated as Production" / "doesn't deploy".
function scopeText(d: DeployView) {
  const env = d.envLabel ?? d.env ?? "an environment";
  return d.scope === "bound" ? `deploys to ${env}` : d.scope === "protected-branch-unknown" ? `unknown scope — treated as ${env}` : "doesn't deploy";
}

function StatusIcon({ status, conclusion, className }: { status: string; conclusion: string | null; className?: string }) {
  const c = cx("size-4 flex-none", className);
  if (status !== "completed") return status === "queued" ? <CircleDashed className={cx(c, "text-fg-3")} /> : <Loader2 className={cx(c, "animate-spin text-deploying")} />;
  if (conclusion === "success") return <CheckCircle2 className={cx(c, "text-up")} />;
  if (conclusion === "failure" || conclusion === "timed_out") return <XCircle className={cx(c, "text-down")} />;
  return <MinusCircle className={cx(c, "text-fg-3")} />;
}

export default function CiPage() {
  const { env } = useEnv();
  const envs = useEnvList().data;
  const repos = useSWR<string[]>("/api/ci/repos", { refreshInterval: 60_000 });
  const REPOS = repos.data ?? [];
  const [picked, setRepo] = useState<string>();
  const repo = picked && REPOS.includes(picked) ? picked : REPOS[0];
  // Branch filter defaults to the branch that deploys to the selected env (tag console:branch / config).
  const branches = [...new Set((envs ?? []).map((e) => e.branch).filter(Boolean) as string[])];
  const [branchByEnv, setBranchByEnv] = useState<Record<string, string>>({});
  const branch = branchByEnv[env] ?? envs?.find((e) => e.id === env)?.branch ?? "all";
  const setBranch = (b: string) => setBranchByEnv((m) => ({ ...m, [env]: b }));
  const [open, setOpen] = useState<CiRun | null>(null);

  const url = repo ? `/api/ci/runs?repo=${encodeURIComponent(repo)}${branch !== "all" ? `&branch=${branch}` : ""}` : null;
  const { data, error, isLoading, mutate } = useSWR<CiRun[]>(url, trackedJson, { refreshInterval: 10_000, keepPreviousData: true });
  const { fresh, gen } = useFresh(data?.map((r) => String(r.id)));
  const kept = keptFreshness({ data, error, loadedAt: loadedAt(url), source: "GitHub", staleAfterMs: 60_000 });
  const disconnected = notConnected(error) || notConnected(repos.error);
  // Discovery mapped no service to a repository: there is nothing to ask GitHub about yet (not "no runs").
  const noRepos = !disconnected && repos.data !== undefined && repos.data.length === 0;

  return (
    <Page width="wide">
      <PageHeader
        title="CI"
        description="GitHub Actions runs, steps and test results"
        actions={
          <ScrollX>
            <Segmented id="branch" value={branch} onChange={setBranch} options={[...branches.map((b) => ({ value: b, label: b })), { value: "all", label: "all branches" }]} />
          </ScrollX>
        }
      />

      <div role="tablist" aria-label="Repository" className="isolate -mt-1 flex flex-wrap gap-1.5">
        {REPOS.map((r) => (
          <button key={r} role="tab" aria-selected={repo === r} onClick={() => setRepo(r)} className={cx("group relative rounded-lg px-3 py-1.5 text-[14px] font-medium transition-colors duration-200 pointer-coarse:py-2.5", repo === r ? "text-fg" : "text-fg-3 hover:bg-panel-3/50 hover:text-fg-2")}>
            {repo === r && <motion.span layoutId="ci-repo" className="absolute inset-0 -z-10 rounded-lg border border-line bg-panel shadow-card" transition={spring} />}
            <span className="press-content inline-block">{repoName(r)}</span>
          </button>
        ))}
      </div>

      {/* A different dataset (repo/branch switch) crossfades as a whole; new runs expand in individually. */}
      {!disconnected && <FreshnessBanner f={kept} onRetry={() => void mutate()} />}

      <Swap id={disconnected ? "github" : noRepos ? "no-repos" : (isLoading || repos.isLoading) && !data ? "loading" : error && !data ? "error" : !data?.length ? "empty" : `list-${gen}`} className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
        {disconnected ? (
          <ConnectGitHub message={((error ?? repos.error) as Error | undefined)?.message} setup={((error ?? repos.error) as ApiError | undefined)?.setup} />
        ) : noRepos ? (
          <Empty
            title="No repositories mapped yet"
            hint="CI shows GitHub Actions runs for the repositories your services map to. Tag a service console:repo=owner/name (or set services.<name>.repo in console.config.json), and set GITHUB_TOKEN so the console can read the runs."
          />
        ) : (isLoading || repos.isLoading) && !data ? (
          <div className="space-y-px p-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : error && !data ? (
          <Empty title="Could not load runs" hint={(error as Error).message} />
        ) : !data?.length ? (
          <Empty title="No runs on this branch" />
        ) : (
          <ul className="divide-y divide-line">
            <AnimatePresence>
              {data.map((r, i) => (
                <Row key={r.id} index={i} fresh={fresh.has(String(r.id))} still={data.length > 100}>
                  {/* Phones: time and duration join the meta line; from sm they get their own columns. */}
                  <button onClick={() => setOpen(r)} className="grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-panel-2 focus-visible:outline-offset-[-2px] active:bg-panel-3/70 sm:grid-cols-[20px_minmax(0,1fr)_140px_120px_90px]">
                    <StatusIcon status={r.status} conclusion={r.conclusion} />
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-medium">{r.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-3">
                        <Chip>{r.workflow}</Chip>
                        <span className="font-mono">{shortSha(r.sha)}</span>
                        <span>{r.branch}</span>
                        <span>{r.actor}</span>
                        {r.attempt > 1 && <Chip tone="accent">attempt {r.attempt}</Chip>}
                        <span className="sm:hidden">
                          <TimeAgo at={r.createdAt} /> · <RunDuration run={r} />
                        </span>
                      </div>
                    </div>
                    <span className="hidden text-xs text-fg-3 sm:block">
                      <TimeAgo at={r.createdAt} />
                    </span>
                    <span className="hidden font-mono text-xs text-fg-3 tabular-nums sm:block"><RunDuration run={r} /></span>
                    <span className="text-right text-xs capitalize text-fg-2">{r.status === "completed" ? r.conclusion : r.status.replace("_", " ")}</span>
                  </button>
                </Row>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Swap>

      <AnimatePresence>{open && <RunDrawer key={open.id} repo={repo} run={open} onClose={() => setOpen(null)} />}</AnimatePresence>
    </Page>
  );
}

function RunDuration({ run }: { run: CiRun }) {
  return run.status === "completed" ? <>{duration(Date.parse(run.updatedAt) - Date.parse(run.createdAt))}</> : <LiveDuration from={run.createdAt} />;
}

function LiveDuration({ from }: { from: string }) {
  const n = useNow();
  return <>{n ? duration(n - Date.parse(from)) : "—"}</>;
}

function RunDrawer({ repo, run, onClose }: { repo: string; run: CiRun; onClose(): void }) {
  const url = `/api/ci/runs/${run.id}?repo=${encodeURIComponent(repo)}`;
  const { data } = useSWR<RunDetail>(url, {
    refreshInterval: (d) => (d?.run.status === "completed" ? 0 : 4_000),
  });
  const [picked, setJob] = useState<number | null>(null);
  const r = data?.run ?? run;
  const jobs = data?.jobs;
  const now = useNow();
  // Default to the failed job, else the running one, else the first — until the user picks.
  const job = picked ?? (jobs?.length ? (jobs.find((j) => j.conclusion === "failure") ?? jobs.find((j) => j.status === "in_progress") ?? jobs[0]).id : null);
  const ask = useConfirm();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const envs = useEnvList().data;
  // Where a re-run deploys comes from the server (R03): the workflow file's binding, else the branch of a protected
  // environment ("unknown scope"), never the workflow's name. An older server without it: the strictest reading.
  const fallback = envs?.find((e) => e.protected && e.branch === r.branch);
  const deploy: DeployView | undefined = data?.deploy;
  const prot = deploy ? deploy.protected : !!fallback;
  const me = useMe().data;
  const denied = me && !me.perms.includes(prot ? "ci:rerun:protected" : "ci:rerun") ? `needs ${deploy?.needs ?? roleFor("ci:rerun", prot)} role` : undefined;
  const busy = r.status !== "completed" ? "the run is still going" : undefined;

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[role=dialog][aria-modal]") && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const rerun = (mode: "tests" | "redeploy") => {
    const target = deploy?.env ?? fallback?.id;
    const label = deploy?.envLabel ?? fallback?.label ?? target;
    const where = deploy ? scopeText(deploy) : fallback ? `may deploy to ${fallback.label} (its branch)` : "doesn't deploy";
    ask({
      env: target ?? r.branch,
      protectedEnv: prot,
      envLabel: label,
      title: `${mode === "tests" ? "Re-run failed tests" : deploy?.scope === "none" ? "Re-run all jobs" : "Redeploy"} · ${r.workflow}`,
      description: (
        <>
          {mode === "tests" ? "Re-runs the failed jobs" : "Re-runs every job"} of {r.workflow} on {r.branch} at <span className="font-mono">{shortSha(r.sha)}</span>.
          <span className="mt-2 block">
            <b className={cx("font-medium", prot ? "text-down" : "text-fg")}>This run {where}.</b> {deploy?.why}
          </span>
          {deploy?.inputs && <span className="mt-1 block text-fg-3">Inputs: {deploy.inputs}</span>}
        </>
      ),
      warnings: deploy?.scope === "protected-branch-unknown" ? [`Nothing binds ${r.workflow} to an environment, but it ran on ${label}'s branch: it is treated as a deploy there.`] : undefined,
      danger: prot && mode === "redeploy",
      expected: deploy ? deploy.confirm : (fallback?.id ?? "yes"),
      needReason: deploy ? deploy.needsReason : prot,
      confirmLabel: mode === "tests" ? "Re-run failed" : deploy?.scope === "none" ? "Re-run" : "Redeploy",
      run: async (input) => {
        await postJson(`/api/ci/runs/${r.id}/rerun?repo=${encodeURIComponent(repo)}`, { mode, confirm: input.confirm, reason: input.reason });
        toast.push({ tone: "ok", title: "Re-run requested", body: `${repoName(repo)} · ${r.workflow}${target && prot ? ` · ${label}` : ""}` });
        mutate((k) => typeof k === "string" && k.startsWith("/api/ci/"));
      },
    });
  };

  const span = useMemo(() => {
    const all = (jobs ?? []).flatMap((j) => j.steps).filter((s) => s.startedAt);
    const t0 = Math.min(...all.map((s) => Date.parse(s.startedAt!)));
    const t1 = Math.max(...all.map((s) => (s.completedAt ? Date.parse(s.completedAt) : now)));
    return { t0, len: Math.max(1, t1 - t0) };
  }, [jobs, now]);

  return (
    // Full screen on phones; a wide sheet from sm.
    <Sheet onClose={onClose} aria-label={`CI run ${r.title}`} className="flex h-full w-full flex-col overflow-hidden border-line bg-panel shadow-float sm:w-[min(1100px,96vw)] sm:rounded-l-2xl sm:border-l">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-3 border-b border-line px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
        <StatusIcon status={r.status} conclusion={r.conclusion} className="mt-1 !size-5" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[24px] leading-tight sm:truncate">{r.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-3">
            <Chip>{r.workflow}</Chip>
            <span className="font-mono">{shortSha(r.sha)}</span>
            <span>{r.branch}</span>
            <span>{r.actor}</span>
            <TimeAgo at={r.createdAt} />
            <a href={r.url} target="_blank" rel="noreferrer" className={cx("inline-flex items-center gap-1 hover:text-fg", TAP)}>
              GitHub <ExternalLink className="size-3" />
            </a>
          </div>
          {deploy ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
              <Chip tone={deploy.scope === "none" ? "muted" : deploy.protected ? "bad" : "accent"}>
                {deploy.protected ? <Lock className="size-3" /> : deploy.scope !== "none" ? <Rocket className="size-3" /> : null} {scopeText(deploy)}
              </Chip>
              <span className="min-w-0 text-fg-3 [overflow-wrap:anywhere]">{deploy.why}</span>
            </div>
          ) : data?.deployError ? (
            <div className="mt-2 text-[13px] text-degraded">Couldn&apos;t work out where this run deploys ({data.deployError}) — treated as a deploy to a protected environment.</div>
          ) : null}
        </div>
        <IconButton label="Close (Esc)" onClick={onClose} className="-mr-1 sm:order-last">
          <X className="size-4" />
        </IconButton>
        {/* Actions sit under the title on phones, beside it from sm. */}
        <div className="flex basis-full flex-wrap gap-2 pl-8 sm:basis-auto sm:pl-0">
          {r.conclusion === "failure" && (
            <Button size="sm" onClick={() => rerun("tests")} disabled={!!busy || !!denied || !!deploy?.testsRefused} tip={busy ?? denied ?? deploy?.testsRefused ?? "Re-run only the jobs that failed"}>
              <RotateCw className="size-3.5" /> Re-run failed tests
            </Button>
          )}
          <Button size="sm" onClick={() => rerun("redeploy")} disabled={!!busy || !!denied} tip={busy ?? denied ?? (deploy ? `Re-runs every job: ${scopeText(deploy)}` : undefined)} className={cx(prot && "enabled:hover:!border-down/50 enabled:hover:!text-down")}>
            {deploy?.scope === "none" ? <RotateCw className="size-3.5" /> : <Rocket className="size-3.5" />} {deploy?.scope === "none" ? "Re-run all" : "Redeploy"}
          </Button>
          {(r.conclusion === "failure" || r.conclusion === "timed_out") && <CreateTicketButton {...ciTicket(r, jobs, data?.tests)} target={`${repo}#${r.id}`} />}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <div className="space-y-3">
            {!jobs && <Skeleton className="h-32" />}
            {jobs?.map((j) => (
              <div key={j.id} className={cx("rounded-xl border p-3 transition-colors duration-200", job === j.id ? "border-accent/50 bg-accent-soft/40" : "border-line hover:border-line-strong")}>
                <button className="flex w-full items-center gap-2 text-left pointer-coarse:min-h-9" onClick={() => setJob(j.id)} aria-pressed={job === j.id}>
                  <StatusIcon status={j.status} conclusion={j.conclusion} />
                  <span className="flex-1 truncate text-[14px] font-medium">{j.name}</span>
                  <span className="font-mono text-[12px] text-fg-3">{j.completedAt && j.startedAt ? duration(Date.parse(j.completedAt) - Date.parse(j.startedAt)) : ""}</span>
                </button>
                <div className="mt-2.5 space-y-1">
                  {j.steps.map((s) => {
                    const st = s.startedAt ? Date.parse(s.startedAt) : null;
                    const en = s.completedAt ? Date.parse(s.completedAt) : st ? now : null;
                    const left = st ? ((st - span.t0) / span.len) * 100 : 0;
                    const width = st && en ? Math.max(0.6, ((en - st) / span.len) * 100) : 0;
                    const color = s.conclusion === "failure" ? "bg-down" : s.conclusion === "skipped" ? "bg-line-strong" : s.status === "in_progress" ? "bg-deploying" : s.status === "completed" ? "bg-up/70" : "bg-transparent";
                    return (
                      <div key={s.number} className="grid grid-cols-[16px_minmax(0,1fr)_30%] items-center gap-2 text-[13px] sm:grid-cols-[16px_minmax(0,220px)_1fr]">
                        <StatusIcon status={s.status} conclusion={s.conclusion} className="!size-3.5" />
                        <span className={cx("truncate", s.conclusion === "failure" ? "text-down" : s.status === "queued" ? "text-fg-3" : "text-fg-2")}>{s.name}</span>
                        <div className="relative h-2 rounded-full bg-panel-3">
                          <motion.div className={cx("absolute inset-y-0 rounded-full transition-colors duration-300", color, s.status === "in_progress" && "animate-pulse")} initial={false} animate={{ left: `${left}%`, width: `${width}%` }} transition={spring} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <Tests data={data} status={r.status} />
        </div>
        <div className="flex h-[60dvh] flex-col overflow-hidden rounded-xl border border-line sm:h-[440px]">
          <div className="truncate border-b border-line px-3 py-2 text-xs text-fg-3">Job log {job ? `· ${jobs?.find((j) => j.id === job)?.name ?? ""}` : ""} (last 2,000 lines)</div>
          {job ? <JobLog repo={repo} jobId={job} live={r.status !== "completed"} /> : <Empty title="Select a job" />}
        </div>
      </div>
    </Sheet>
  );
}

function Tests({ data, status }: { data?: { tests: TestReport | null; testsError?: string }; status: string }) {
  const t = data?.tests;
  return (
    <div className="rounded-xl border border-line p-4">
      <SectionTitle className="mb-3">Tests</SectionTitle>
      {status !== "completed" ? (
        <div className="flex items-center gap-2 text-xs text-fg-3"><Loader2 className="size-3.5 animate-spin" /> results after the run completes</div>
      ) : data?.testsError ? (
        <div className="text-xs text-down">{data.testsError}</div>
      ) : !t ? (
        <div className="text-xs text-fg-3">No JUnit report on this run. Upload a <code className="font-mono">junit-*</code> artifact to see per-test results.</div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-panel-2 py-2"><div className="font-display text-2xl tabular-nums">{t.total}</div><div className="text-[11px] text-fg-3">total</div></div>
            <div className={cx("rounded-lg py-2", t.failed ? "bg-down/10 text-down" : "bg-up/10 text-up")}><div className="font-display text-2xl tabular-nums">{t.failed}</div><div className="text-[11px] opacity-80">failed</div></div>
            <div className="rounded-lg bg-panel-2 py-2"><div className="font-display text-2xl tabular-nums">{t.skipped}</div><div className="text-[11px] text-fg-3">skipped</div></div>
          </div>
          <div className="text-[12px] text-fg-3">{t.seconds}s · {t.files.length} report file(s)</div>
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {t.failures.map((f, i) => (
              <li key={i} className="rounded-lg border border-down/25 bg-down/6 p-2">
                <div className="text-[13px] font-medium text-down">{f.name}</div>
                <div className="truncate text-[11px] text-fg-3">{f.suite}</div>
                {f.failure && <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] text-fg-2">{f.failure}</pre>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function JobLog({ repo, jobId, live }: { repo: string; jobId: number; live: boolean }) {
  const { data, error } = useSWR<{ lines: string[]; total: number }>(`/api/ci/jobs/${jobId}/log?repo=${encodeURIComponent(repo)}`, { refreshInterval: live ? 5_000 : 0 });
  if (error) return <Empty title="Log not available yet" hint={(error as Error).message} />;
  if (!data) return <div className="p-3"><Skeleton className="h-40" /></div>;
  return <StaticLog lines={data.lines} />;
}
