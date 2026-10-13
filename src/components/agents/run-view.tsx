"use client";
// One agent run, as a person follows it (AGENT_ARCHITECTURE §10): who asked, who it acts for, which agent, which
// connection and who pays, its scope; the evidence it read (with ages), the changes it proposed as plan cards, what
// actually happened — "AI completed", "AWS accepted" and "verified healthy" as separate badges — what it is waiting
// for, its budget, and a Stop button. It follows the run live (/api/events?run=, replayed after a reconnect) and
// announces state changes to screen readers. `compact` is the assistant drawer's version: the answer, the plan and the
// evidence first, the bookkeeping folded away.
import { Bell, Bot, Check, ChevronRight, CircleStop, FilePen, GitBranch, HeartPulse, Hourglass, Play, Radio, Search, UserCheck, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, Skeleton, TimeAgo, cx, useNow } from "@/components/ui";
import { useMe } from "@/components/user-menu";
import { ApiError, patchJson, postJson } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { BudgetMeter } from "./budget-meter";
import { EvidenceList } from "./evidence-list";
import { OutcomeBadges, RunStateChip } from "./outcome-badges";
import { Cited, PlanCard } from "./plan-card";
import { MODE_LABEL, RUN_KIND, initiatorOf, isFinalRunState, liveLabel, outcomeContext, outcomeUnknownGuidance, runStateInfo, scopeText, shortHash, verifyText, waitingText } from "./rules";
import type { ProposalView, RunDetail, RunStep } from "./types";
import { useRun } from "./use-run";

const STEP_ICON: Record<string, LucideIcon> = {
  model: Bot, tool: Search, propose: FilePen, approval: UserCheck, execute: Play, verify: HeartPulse, wait: Hourglass, condition: GitBranch, notify: Bell,
};
const STEP_STATE: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "muted" | "accent" }> = {
  queued: { label: "queued", tone: "muted" },
  leased: { label: "running", tone: "accent" },
  waiting: { label: "waiting", tone: "accent" },
  succeeded: { label: "done", tone: "ok" },
  failed: { label: "failed", tone: "bad" },
  cancelled: { label: "cancelled", tone: "muted" },
  outcome_unknown: { label: "outcome unknown", tone: "bad" },
  skipped: { label: "skipped", tone: "muted" },
};

export function RunView({ runId, compact, proposalActions, className }: {
  runId: string;
  compact?: boolean;
  // Buttons under a proposal (the drawer's inline approve / reject). Default: a link to it in Approvals.
  proposalActions?: (p: ProposalView) => ReactNode;
  className?: string;
}) {
  const { data: run, error, isLoading, live, mutate } = useRun(runId);
  if (isLoading && !run) return <Skeleton className={cx("h-72 rounded-2xl", className)} />;
  if (error && !run) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <div className={cx("rounded-2xl border border-line bg-panel shadow-card", className)}>
        <Empty title={missing ? "No such run" : "Couldn't load this run"} hint={missing ? "It may have been started on another console, or the runs API isn't available here yet." : (error as Error).message} />
      </div>
    );
  }
  if (!run) return null;
  return <RunBody run={run} live={live} compact={compact} proposalActions={proposalActions} refresh={() => void mutate()} className={className} />;
}

function RunBody({ run, live, compact, proposalActions, refresh, className }: {
  run: RunDetail;
  live: ReturnType<typeof useRun>["live"];
  compact?: boolean;
  proposalActions?: (p: ProposalView) => ReactNode;
  refresh: () => void;
  className?: string;
}) {
  const st = runStateInfo(run.state);
  const final = isFinalRunState(run.state);
  const waiting = waitingText(run);
  const unknown = outcomeUnknownGuidance(run);
  const maxAge = run.evidenceMaxAgeSeconds; // the run's policy limit: older evidence is marked
  const proposals = run.proposals ?? [];
  const steps = [...(run.steps ?? [])].sort((a, b) => a.seq - b.seq);
  const shownSteps = compact ? steps.slice(-6) : steps;
  const delegator = run.principal?.delegatorEmail ?? run.principal?.delegator;
  const answer = typeof run.answer === "string" ? run.answer : run.answer?.text;
  const cutOff = typeof run.answer === "object" && !!run.answer?.incomplete;
  const requester = initiatorOf(run);
  const agentName = run.agent?.name ?? run.agent?.id ?? run.principal?.agentId ?? run.workflow?.name ?? run.workflow?.id ?? run.principal?.workflowId;
  const mode = run.mode ?? run.principal?.mode;
  // Only the person it acts for, or an admin, may stop it (the cancel route answers 403 to anyone else).
  const me = useMe().data;
  const mayStop = !!me && (me.perms.includes("admin") || (!!requester && requester === me.user.email));

  return (
    <section aria-labelledby={`run-${run.id}`} className={cx("space-y-4", className)}>
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="eyebrow mb-1 flex flex-wrap items-center gap-x-2">
            <span>{RUN_KIND[run.kind] ?? run.kind} run</span>
            <span className="font-mono normal-case tracking-normal text-fg-3">{run.id.slice(0, 8)}</span>
          </div>
          <h2 id={`run-${run.id}`} className={cx("font-semibold leading-snug [overflow-wrap:anywhere]", compact ? "text-[15px]" : "text-[17px]")}>{run.title || "Untitled run"}</h2>
          {/* The run's state is announced as it changes (aria-live), with what it waits for. */}
          <div role="status" aria-live="polite" className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-fg-3">
            <RunStateChip state={run.state} />
            {waiting && !final && <span>waiting for {waiting}</span>}
            {run.error && <span className="text-down [overflow-wrap:anywhere]">{run.error}</span>}
            <span className="sr-only">{st.hint}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cx("inline-flex items-center gap-1 text-[12.5px]", live === "live" && !final ? "text-up" : "text-fg-3")} title="Updates arrive from the event stream; after a reconnect the missed ones are replayed">
            <Radio className={cx("size-3", live === "live" && !final && "animate-pulse")} aria-hidden /> {liveLabel(live, final)}
          </span>
          {!final && mayStop && <StopButton run={run} onStopped={refresh} />}
        </div>
      </header>

      {run.outcome && <OutcomeBadges outcome={run.outcome} context={outcomeContext(run)} />}
      {unknown && (
        <p role="note" className="rounded-xl border border-down/25 bg-down/6 px-3 py-2 text-[13.5px] leading-relaxed text-down">
          <b className="font-semibold">Outcome unknown.</b> {unknown}
        </p>
      )}
      {run.cancelRequestedAt && !final && (
        <p role="note" className="rounded-xl border border-line bg-panel-2 px-3 py-2 text-[13.5px] text-fg-2">
          Stop requested <TimeAgo at={run.cancelRequestedAt} />: no new steps start. Changes AWS already accepted keep being checked, and this run says how they end.
        </p>
      )}

      {!final && run.workflow?.id && <ReviewPrompt run={run} workflowId={run.workflow.id} onDone={refresh} />}

      {!compact && (
        <dl className="grid gap-x-6 gap-y-2 rounded-2xl border border-line bg-panel px-4 py-3 text-[13.5px] shadow-card sm:grid-cols-2">
          <Fact label="Requested by">{requester ?? (run.kind === "workflow" ? "a workflow trigger" : "—")}</Fact>
          <Fact label="Acts for">{delegator ?? "—"}{delegator && requester && delegator !== requester ? " (the person whose role it uses)" : ""}</Fact>
          <Fact label="Agent">
            {agentName ?? (run.kind === "external" ? "a connected MCP client" : run.kind === "assistant" ? "the assistant" : "—")}
            {mode && (
              <Chip tone={MODE_LABEL[mode]?.tone} className="ml-1.5 align-[1px]">
                {MODE_LABEL[mode]?.label ?? mode}
              </Chip>
            )}
          </Fact>
          <Fact label="Connection">
            {run.connection ? (
              <>
                {run.connection.label ?? run.connection.id}
                {run.connection.payer && <span className="block text-[12.5px] text-fg-3">Pays: {run.connection.payer}</span>}
              </>
            ) : run.kind === "external" ? (
              <>
                the client&apos;s own
                <span className="block text-[12.5px] text-fg-3">Pays: its own subscription or API key — the console never sees that login</span>
              </>
            ) : (
              "none (deterministic, no model)"
            )}
          </Fact>
          <Fact label="Scope">{scopeText(run.scope)}</Fact>
          <Fact label="Policy">
            <span className="font-mono text-[12.5px]" title={run.policyHash ?? run.principal?.policyHash ?? undefined}>{shortHash(run.policyHash ?? run.principal?.policyHash)}</span>
          </Fact>
          <Fact label="Started">
            <span title={stamp(run.createdAt)}><TimeAgo at={run.createdAt} /></span>
            {run.finishedAt ? <> · finished <TimeAgo at={run.finishedAt} /></> : null}
          </Fact>
        </dl>
      )}
      {compact && run.connection?.payer && <p className="text-[12.5px] text-fg-3">Connection {run.connection.label ?? run.connection.id} · pays: {run.connection.payer}</p>}

      <BudgetMeter budget={run.budget} usage={run.usage} startedAt={run.createdAt} finishedAt={run.finishedAt ?? (final ? run.updatedAt : undefined)} compact={compact} />

      {answer && (
        <div className="rounded-2xl border border-line bg-panel px-4 py-3 shadow-card">
          <div className="eyebrow mb-1.5">Answer{cutOff ? " (cut off before it finished)" : ""}</div>
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-fg [overflow-wrap:anywhere]">
            <Cited text={answer} runId={run.id} known={new Set((run.evidence ?? []).map((e) => e.id))} />
          </p>
        </div>
      )}

      {proposals.length > 0 && (
        <div className="space-y-3">
          {proposals.map((p) => (
            <PlanCard
              key={p.grantId}
              proposal={p}
              evidence={run.evidence}
              runId={run.id}
              maxAgeSeconds={maxAge}
              compact={compact}
              actions={proposalActions ? proposalActions(p) : p.state === "pending" ? <ReviewLink /> : undefined}
            />
          ))}
        </div>
      )}

      {!!run.children?.length && (
        <p className="text-[13.5px] text-fg-2">
          Child runs (sharing this run&apos;s budget):{" "}
          {run.children.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              <a href={`/automation#runs/${c.id}`} className="font-mono text-[12.5px] underline decoration-line-strong underline-offset-2 hover:text-fg">{c.id.slice(0, 8)}</a> ({runStateInfo(c.state).label.toLowerCase()})
            </span>
          ))}
        </p>
      )}

      {!!run.operations?.length && (
        <div>
          <h3 className="eyebrow mb-1.5">Changes sent to AWS</h3>
          <ul className="space-y-1">
            {run.operations.map((o) => {
              const v = verifyText(o);
              return (
                <li key={o.id} className="flex flex-wrap items-center gap-2 text-[13.5px]">
                  <span className="font-mono text-[12.5px] text-fg-3">{o.id.slice(0, 8)}</span>
                  {o.action && <Chip mono>{o.action}</Chip>}
                  <Chip tone={v.tone}>{v.text}</Chip>
                  {o.error && <span className="text-down [overflow-wrap:anywhere]">{o.error}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {compact ? (
        <details className="group rounded-xl border border-line bg-panel-2/40">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-medium text-fg-3 hover:text-fg-2 pointer-coarse:py-3 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform duration-200 group-open:rotate-90" aria-hidden /> Evidence ({run.evidence?.length ?? 0}) and steps
          </summary>
          <div className="space-y-3 px-3 pb-3">
            <EvidenceList runId={run.id} items={run.evidence} maxAgeSeconds={maxAge} compact />
            <Timeline steps={shownSteps} more={steps.length - shownSteps.length} />
          </div>
        </details>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="eyebrow mb-1.5">Evidence</h3>
            <EvidenceList runId={run.id} items={run.evidence} maxAgeSeconds={maxAge} />
          </div>
          <div className="min-w-0">
            <h3 className="eyebrow mb-1.5">Steps</h3>
            <Timeline steps={shownSteps} more={0} />
          </div>
        </div>
      )}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-fg-3">{label}</dt>
      <dd className="text-fg-2 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function ReviewLink() {
  return (
    <Link href="/automation#approvals" className="press inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 text-[13.5px] font-medium text-fg shadow-card hover:border-line-strong hover:bg-panel-2 pointer-coarse:h-10">
      <UserCheck className="size-3.5" aria-hidden /> Review in Approvals
    </Link>
  );
}

function Timeline({ steps, more }: { steps: RunStep[]; more: number }) {
  if (!steps.length) return <p className="text-[13.5px] text-fg-3">No steps yet.</p>;
  return (
    <ol aria-label="Steps" className="relative space-y-2 border-l border-line pl-4">
      {more > 0 && <li className="text-[12.5px] text-fg-3">{more} earlier step{more === 1 ? "" : "s"}</li>}
      {steps.map((s) => {
        const Icon = STEP_ICON[s.kind] ?? ChevronRight;
        const state = STEP_STATE[s.state] ?? { label: s.state, tone: "muted" as const };
        return (
          <li key={s.id} className="relative">
            <span className="absolute -left-[25px] top-0.5 grid size-[17px] place-items-center rounded-full border border-line bg-panel text-fg-3" aria-hidden>
              <Icon className="size-2.5" />
            </span>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-[13.5px] font-medium capitalize text-fg-2">{s.kind}</span>
              <span className="min-w-0 text-[13.5px] text-fg-2 [overflow-wrap:anywhere]">{s.summary ?? s.name ?? ""}</span>
              <Chip tone={state.tone}>{state.label}</Chip>
              {(s.attempt ?? 1) > 1 && <span className="text-[12px] text-fg-3">attempt {s.attempt}</span>}
              {s.updatedAt && (
                <span className="text-[12px] text-fg-3" title={stamp(s.updatedAt)}>
                  <TimeAgo at={s.updatedAt} />
                </span>
              )}
            </div>
            {s.evidence?.length || s.evidenceId ? <div className="mt-0.5 font-mono text-[12px] text-fg-3">→ {s.evidence?.length ? s.evidence.join(", ") : s.evidenceId}</div> : null}
            {s.error && <div className="mt-0.5 text-[13px] text-down [overflow-wrap:anywhere]">{s.error}</div>}
          </li>
        );
      })}
    </ol>
  );
}

// A workflow run paused for a person: services that match its selector now but weren't in the published preview, or
// an approval step's message. Continue or cancel before the deadline; after it the run is cancelled and nothing is done.
function ReviewPrompt({ run, workflowId, onDone }: { run: RunDetail; workflowId: string; onDone: () => void }) {
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState<"continue" | "cancel" | null>(null);
  const step = (run.steps ?? []).find((s) => s.state === "waiting" && s.review);
  if (!step?.review) return null;
  const r = step.review;
  const left = r.expiresAt && now ? Math.max(0, Math.ceil((r.expiresAt - now) / 60_000)) : undefined;
  const answer = async (decision: "continue" | "cancel") => {
    setBusy(decision);
    try {
      await patchJson(`/api/agents/workflows/${encodeURIComponent(workflowId)}`, { action: "review", runId: run.id, decision });
      toast.push({ tone: "ok", title: decision === "continue" ? "The run continues" : "The run is cancelled" });
    } catch (e) {
      const expired = e instanceof ApiError && e.code === "review_expired";
      toast.push({ tone: "error", title: expired ? "Too late to continue" : "Couldn't record the review", body: (e as Error).message });
    } finally {
      setBusy(null);
      onDone();
    }
  };
  return (
    <div role="region" aria-label="Review needed" className="rounded-xl border border-accent/40 bg-accent/8 px-3 py-2.5 text-[13.5px] leading-relaxed text-fg-2">
      <b className="font-semibold text-fg">This run waits for your review.</b> {r.message}
      {!!r.additions?.length && (
        <div className="mt-1">
          New, never acted on: <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">{r.additions.join(", ")}</span>
        </div>
      )}
      {!!r.removals?.length && (
        <div className="mt-1">
          No longer matching: <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">{r.removals.join(", ")}</span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={!!busy || left === 0} onClick={() => void answer("continue")}>
          <Check className="size-3.5" /> Continue
        </Button>
        <Button size="sm" disabled={!!busy} onClick={() => void answer("cancel")}>
          <CircleStop className="size-3.5" /> Cancel run
        </Button>
        {r.expiresAt && (
          <span className="text-[12.5px] text-fg-3" title={stamp(r.expiresAt)}>
            {left === 0 ? "The review window has closed: the run is being cancelled." : left !== undefined ? `Answer within ${left} min, or the run is cancelled and nothing is done.` : null}
          </span>
        )}
      </div>
    </div>
  );
}

function StopButton({ run, onStopped }: { run: RunDetail; onStopped: () => void }) {
  const ask = useConfirm();
  const toast = useToast();
  return (
    <Button
      variant="danger"
      size="sm"
      disabled={!!run.cancelRequestedAt}
      title={run.cancelRequestedAt ? "Stop already requested" : "Stop this run"}
      onClick={() =>
        ask({
          env: "",
          title: "Stop this run?",
          description: "No new steps start, and pending approval requests are withdrawn. Changes AWS already accepted can't be called back: the console keeps checking them and the run says how they end.",
          danger: true,
          expected: "yes",
          confirmLabel: "Stop run",
          run: async () => {
            const r = await postJson<{ note?: string }>(`/api/agents/runs/${encodeURIComponent(run.id)}/cancel`, {});
            toast.push({ tone: "ok", title: "Run stopped", body: r?.note ?? run.title ?? undefined }, r?.note ? 10_000 : undefined);
            onStopped();
          },
        })
      }
    >
      <CircleStop className="size-3.5" /> Stop
    </Button>
  );
}
