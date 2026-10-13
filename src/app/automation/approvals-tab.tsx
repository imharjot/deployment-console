"use client";
// Approvals: changes agents asked for, waiting for a person. Two kinds of requester:
// - an API token (dc_): approving runs the operation as you (the audit log records "<you> approving token <name>");
// - an agent run (assistant, workflow or a connected agent): approving binds the exact plan shown (its hash) and lets
//   the run make that change as the agent — acting for the person it delegates for, never as you. The card shows the
//   plan as a <PlanCard> (what, where, why, evidence, how success is judged), the grant's targets, hash and expiry, and
//   who asked versus who it acts for. If anything in the plan changes before it runs, the request is invalidated and
//   says why. Agent requests need a typed confirmation and a reason.
import { AnimatePresence } from "motion/react";
import { AlertTriangle, Bot, Check, ChevronRight, Clock, Lock, X } from "lucide-react";
import useSWR, { useSWRConfig } from "swr";
import { useConfirm } from "@/components/confirm";
import { Row, Swap } from "@/components/motion";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, Skeleton, TimeAgo, cx, useNow } from "@/components/ui";
import { postJson } from "@/lib/client/api";
import { useEnvInfo } from "@/lib/client/env";
import { stamp, summarizeResult } from "@/lib/client/format";
import type { ApprovalView } from "@/lib/server/ops";
import { PlanCard } from "@/components/agents/plan-card";
import { invalidationText, plansMigrations } from "@/components/agents/rules";
import type { ProposalView, RunDetail } from "@/components/agents/types";
import { fetchRun, runKey } from "@/components/agents/use-run";
import { DataTable, type Column } from "../_components/data-table";
import { SectionTitle } from "../_components/page-frame";

const STATUS_TONE: Record<ApprovalView["status"], "ok" | "warn" | "bad" | "muted" | "accent"> = {
  pending: "accent", approved: "warn", done: "ok", failed: "bad", rejected: "muted", expired: "muted",
};

export function RiskChip({ risk }: { risk: string }) {
  return <Chip tone={risk === "danger" ? "bad" : risk === "change" ? "warn" : "muted"}>{risk}</Chip>;
}

// A time in the future ("in 23h"); TimeAgo only speaks about the past.
export function Until({ at }: { at: number }) {
  const n = useNow();
  const ms = at - n;
  const text = !n ? "—" : ms <= 0 ? "now" : ms < 3_600_000 ? `in ${Math.ceil(ms / 60_000)}m` : ms < 86_400_000 ? `in ${Math.floor(ms / 3_600_000)}h` : `in ${Math.floor(ms / 86_400_000)}d`;
  return (
    <time suppressHydrationWarning title={stamp(at)}>
      {text}
    </time>
  );
}

export const refreshApprovals = (k: unknown) => typeof k === "string" && k.startsWith("/api/approvals");

export function ApprovalsTab() {
  const pending = useSWR<{ approvals: ApprovalView[] }>("/api/approvals?status=pending", { refreshInterval: 30_000 });
  const history = useSWR<{ approvals: ApprovalView[] }>("/api/approvals?status=all&limit=60", { refreshInterval: 60_000 });
  const done = (history.data?.approvals ?? []).filter((a) => a.status !== "pending");
  // A request whose agent grant expired (or whose run ended) is still "pending" in the store until someone looks; its
  // view already says expired, so it belongs to the history, not to the decisions waiting.
  const waiting = (pending.data?.approvals ?? []).filter((a) => a.status === "pending");

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionTitle>Waiting for a decision</SectionTitle>
        <Swap id={pending.isLoading ? "load" : pending.error ? "err" : waiting.length ? "list" : "empty"}>
          {pending.isLoading ? (
            <div className="space-y-3">{Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}</div>
          ) : pending.error ? (
            <div className="rounded-2xl border border-line bg-panel shadow-card"><Empty title="Couldn't load approvals" hint={(pending.error as Error).message} /></div>
          ) : waiting.length ? (
            <ul className="space-y-3">
              <AnimatePresence initial={false}>
                {waiting.map((a, i) => (
                  <Row key={a.id} index={i}>
                    <PendingCard a={a} />
                  </Row>
                ))}
              </AnimatePresence>
            </ul>
          ) : (
            <div className="rounded-2xl border border-line bg-panel shadow-card">
              <Empty icon={<Check className="size-5" />} title="Nothing waiting" hint="When an agent using a propose or act token asks for a change, it waits here until someone approves or rejects it. Requests expire after 24 hours." />
            </div>
          )}
        </Swap>
      </section>

      <section className="space-y-3">
        <SectionTitle>History</SectionTitle>
        <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
          {history.isLoading ? (
            <div className="space-y-px p-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : done.length ? (
            <DataTable label="Decided approval requests" rows={done} rowKey={(a) => a.id} columns={historyColumns} />
          ) : (
            <Empty title="No decisions yet" />
          )}
        </div>
      </section>
    </div>
  );
}

function PendingCard({ a }: { a: ApprovalView }) {
  return a.run ? <AgentPendingCard a={a} /> : <TokenPendingCard a={a} />;
}

function TokenPendingCard({ a }: { a: ApprovalView }) {
  const ask = useConfirm();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const plan = a.plan;
  const who = a.token.name ? `token "${a.token.name}"` : "a deleted token";
  const why = a.canDecide ? undefined : "Your role can't run this operation here";
  const envLabel = useEnvInfo(a.env ?? "")?.label ?? a.env ?? undefined; // the approval stores the id; people know the label

  const approve = () =>
    ask({
      env: a.env ?? "",
      protectedEnv: a.protected,
      envLabel,
      title: `Approve: ${plan?.summary ?? a.title}?`,
      description: (
        <>
          It runs now, as you. The audit log records <b className="font-medium text-fg">you approving {who}</b>
          {a.owner.email ? <> (owned by {a.owner.email})</> : null}.
          {plan?.warnings?.length ? <span className="mt-2 block text-degraded">{plan.warnings.join(" · ")}</span> : null}
        </>
      ),
      danger: a.risk === "danger",
      expected: a.confirm,
      needReason: a.needsReason,
      confirmLabel: "Approve and run",
      run: async ({ confirm, reason }) => {
        const r = await postJson<{ approval: ApprovalView; error?: string }>(`/api/approvals/${a.id}`, { decision: "approve", confirm, reason });
        if (r.error) toast.push({ tone: "error", title: "Approved, but it failed", body: r.error }, 10_000);
        else toast.push({ tone: "ok", title: "Approved and run", body: summarizeResult(r.approval?.result) ?? plan?.summary ?? a.title });
        await mutate(refreshApprovals);
      },
    });

  const reject = () =>
    ask({
      env: a.env ?? "",
      title: "Reject this request?",
      description: <>Nothing runs. {who[0].toUpperCase() + who.slice(1)} can read your reason when it checks the request.</>,
      danger: true,
      expected: "yes",
      needReason: true,
      confirmLabel: "Reject",
      run: async ({ reason }) => {
        await postJson(`/api/approvals/${a.id}`, { decision: "reject", reason });
        toast.push({ tone: "ok", title: "Request rejected" });
        await mutate(refreshApprovals);
      },
    });

  return (
    <article className="rounded-2xl border border-line bg-panel shadow-card" aria-labelledby={`ap-${a.id}`}>
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-line px-4 py-3.5 sm:px-5">
        <div className="grid size-8 flex-none place-items-center rounded-lg border border-line bg-panel-2 text-fg-3" aria-hidden>
          <Bot className="size-4" />
        </div>
        <div className="min-w-0 flex-1 basis-56">
          <h3 id={`ap-${a.id}`} className="text-[15px] font-semibold leading-snug">{plan?.summary ?? a.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-3">
            <Chip mono>{a.op}</Chip>
            <RiskChip risk={a.risk} />
            {a.env && (
              <Chip tone={a.protected ? "bad" : "muted"}>
                {a.protected && <Lock className="size-3" />} {a.env}
              </Chip>
            )}
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" /> <TimeAgo at={a.createdAt} /> · expires <Until at={a.expiresAt} />
            </span>
          </div>
        </div>
      </header>
      <div className="space-y-3 px-4 py-3.5 text-[14px] sm:px-5">
        {!!plan?.changes?.length && (
          <ul className="space-y-1">
            {plan.changes.map((c, i) => (
              <li key={i} className="flex gap-2 leading-relaxed text-fg-2">
                <ChevronRight className="mt-[3px] size-3.5 flex-none text-fg-3" aria-hidden />
                <span className="min-w-0 [overflow-wrap:anywhere]">{c}</span>
              </li>
            ))}
          </ul>
        )}
        {!!plan?.warnings?.length && (
          <ul className="space-y-1 rounded-xl border border-degraded/25 bg-degraded/6 px-3 py-2">
            {plan.warnings.map((w, i) => (
              <li key={i} className="flex gap-2 text-[13.5px] leading-relaxed text-degraded">
                <AlertTriangle className="mt-[3px] size-3.5 flex-none" aria-hidden /> <span className="min-w-0">{w}</span>
              </li>
            ))}
          </ul>
        )}
        {plan?.estimate && (
          <p className="text-[13.5px] text-fg-2">
            Estimated cost: <b className="font-semibold tabular-nums text-fg">${plan.estimate.monthlyUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}/month</b>
            <span className="text-fg-3"> · {plan.estimate.note}</span>
          </p>
        )}
        <details className="group rounded-xl border border-line bg-panel-2/50">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-medium text-fg-3 hover:text-fg-2 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform duration-200 group-open:rotate-90" aria-hidden /> Request input
          </summary>
          <pre className="max-h-64 overflow-auto px-3 pb-3 font-mono text-[12.5px] leading-relaxed text-fg-2">{JSON.stringify(a.input, null, 2)}</pre>
        </details>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-5">
        <div className="min-w-0 text-[13px] text-fg-3">
          Requested by <span className="font-mono text-fg-2">{a.token.name ?? "deleted token"}</span>
          {a.owner.email && <> · owner {a.owner.email}</>}
          {a.confirm !== "yes" && (
            <>
              {" "}· approving needs <code className="rounded border border-line bg-panel-2 px-1 font-mono text-[12px] text-fg-2">{a.confirm}</code>
            </>
          )}
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button variant="secondary" onClick={reject} disabled={!a.canDecide} title={why} className="flex-1 sm:flex-none max-sm:h-11">
            <X className="size-4" /> Reject
          </Button>
          <Button variant={a.risk === "danger" ? "danger" : "primary"} onClick={approve} disabled={!a.canDecide} title={why} className="flex-1 sm:flex-none max-sm:h-11">
            <Check className="size-4" /> Approve
          </Button>
        </div>
      </footer>
    </article>
  );
}

const historyColumns: Column<ApprovalView>[] = [
  { key: "when", header: "Requested", slot: "meta", className: "whitespace-nowrap text-fg-2", cell: (a) => <span title={stamp(a.createdAt)}><TimeAgo at={a.createdAt} /></span> },
  {
    key: "what",
    header: "Request",
    slot: "title",
    cell: (a) => (
      <div className="min-w-0">
        <div className="truncate font-medium @max-2xl:whitespace-normal">{a.plan?.summary ?? a.title}</div>
        <div className="mt-0.5 font-mono text-[12px] text-fg-3">{a.op}</div>
      </div>
    ),
  },
  {
    key: "status",
    header: "Status",
    slot: "end",
    cell: (a) => (invalidationText(a.detail) ? <Chip tone="bad">invalidated</Chip> : <Chip tone={STATUS_TONE[a.status]}>{a.status}</Chip>),
  },
  {
    key: "token",
    header: "Requested by",
    label: "by",
    slot: "meta",
    className: "text-[13px] text-fg-2",
    cell: (a) =>
      a.run ? (
        <a href={`#runs/${a.run.id}`} className="hover:underline" title={a.owner.email ? `acting for ${a.owner.email}` : undefined}>
          agent run {a.run.id.slice(0, 8)}
        </a>
      ) : (
        <span className="font-mono">{a.token.name ?? "deleted"}</span>
      ),
  },
  { key: "decided", header: "Decided by", label: "decided by", slot: "meta", className: "text-fg-2 @max-2xl:[overflow-wrap:anywhere]", cell: (a) => a.decidedBy },
  {
    key: "detail",
    header: "Outcome",
    slot: "line",
    className: cx("text-[13.5px] text-fg-2"),
    cell: (a) => <Outcome a={a} />,
  },
];

// The outcome in a line (F45); the raw result stays one click away, never the first thing shown.
function Outcome({ a }: { a: ApprovalView }) {
  const why = invalidationText(a.detail);
  const line = why ? `Invalidated — ${why}. Nothing ran; the agent has to ask again.` : a.detail ?? summarizeResult(a.result) ?? (a.status === "rejected" ? "not run" : a.status === "expired" ? "expired before anyone decided" : a.run && a.status === "approved" ? "approved — the agent's run is making the change" : undefined);
  const raw = a.result !== undefined && a.result !== null && typeof a.result === "object" ? JSON.stringify(a.result, null, 2) : undefined;
  if (!line && !raw) return null;
  return (
    <div className="min-w-0 @min-2xl:max-w-[320px]">
      {line && <div className="[overflow-wrap:anywhere] @min-2xl:truncate" title={line}>{line}</div>}
      {raw && (
        <details className="group mt-0.5">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-fg-3 hover:text-fg-2 pointer-coarse:min-h-9 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 transition-transform duration-200 group-open:rotate-90" aria-hidden /> Details
          </summary>
          <pre className="mt-1 max-h-48 max-w-full overflow-auto rounded-lg border border-line bg-panel-2 p-2 font-mono text-[12px] leading-relaxed text-fg-2">{raw}</pre>
        </details>
      )}
    </div>
  );
}

// An agent's request: the plan card from its run (with the grant's targets, plan hash and expiry), who asked and who it
// acts for, and approve / reject with a typed confirmation and a reason. Approving never runs it as you: the run makes
// the change as the agent, after the console re-plans and finds the exact same plan.
function AgentPendingCard({ a }: { a: ApprovalView }) {
  const ask = useConfirm();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const runId = a.run!.id;
  const { data: run } = useSWR<RunDetail>(runKey(runId), fetchRun, { refreshInterval: 30_000, shouldRetryOnError: false });
  const envLabel = useEnvInfo(a.env ?? "")?.label ?? a.env ?? undefined;
  const found = run?.proposals?.find((p) => p.approvalId === a.id || (!!a.run?.grantId && p.grantId === a.run.grantId));
  // Without the runs API (or before the run is read), the request itself still says what it would change.
  const proposal: ProposalView = found ?? {
    grantId: a.run?.grantId ?? a.id, approvalId: a.id, op: a.op, targets: [], planHash: "", plan: a.plan, expiresAt: a.expiresAt, state: a.status, env: a.env,
  };
  const why = a.canDecide ? undefined : "Your role can't make this change here";
  const migrations = plansMigrations(a.plan);
  const typed = a.confirm !== "yes" ? a.confirm : "approve";
  const agentName = run?.title ?? `agent run ${runId.slice(0, 8)}`;

  const approve = () =>
    ask({
      env: a.env ?? "",
      protectedEnv: a.protected,
      envLabel,
      title: `Approve: ${a.plan?.summary ?? a.title}?`,
      description: (
        <>
          This doesn&apos;t run as you. Approving lets <b className="font-medium text-fg">{agentName}</b> make exactly this change, as the agent acting for{" "}
          <b className="font-medium text-fg">{a.owner.email ?? "its delegator"}</b>. The console re-plans first: if anything differs from the plan you see, the request is invalidated instead.
        </>
      ),
      warnings: a.plan?.warnings,
      danger: a.risk === "danger",
      expected: typed,
      needReason: true,
      migrations: migrations ? true : undefined,
      verifies: proposal.verifies,
      confirmLabel: "Approve",
      run: async ({ reason, migrationAck }) => {
        await postJson(`/api/approvals/${a.id}`, { decision: "approve", confirm: a.confirm !== "yes" ? a.confirm : "yes", reason, ...(migrations ? { migrationAck: migrationAck === true } : {}) });
        toast.push({ tone: "ok", title: "Approved", body: "The agent's run makes the change next; follow it in Runs." });
        await mutate(refreshApprovals);
        await mutate(runKey(runId));
      },
    });

  const reject = () =>
    ask({
      env: a.env ?? "",
      title: "Reject this request?",
      description: <>Nothing runs. The agent reads your reason and its run goes on without this change.</>,
      danger: true,
      expected: "reject",
      needReason: true,
      confirmLabel: "Reject",
      run: async ({ reason }) => {
        await postJson(`/api/approvals/${a.id}`, { decision: "reject", reason });
        toast.push({ tone: "ok", title: "Request rejected" });
        await mutate(refreshApprovals);
      },
    });

  return (
    <div className="space-y-2">
      <PlanCard
        proposal={proposal}
        evidence={run?.evidence}
        runId={runId}
        actions={
          <>
            <div className="mr-auto min-w-0 text-[13px] leading-relaxed text-fg-3">
              Asked by{" "}
              <a href={`#runs/${runId}`} className="text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg">
                {agentName}
              </a>
              {a.owner.email && <> · acts for {a.owner.email}</>}
              {a.env && (
                <>
                  {" "}·{" "}
                  <Chip tone={a.protected ? "bad" : "muted"}>
                    {a.protected && <Lock className="size-3" />} {a.env}
                  </Chip>
                </>
              )}{" "}
              · <RiskChip risk={a.risk} /> · requested <TimeAgo at={a.createdAt} />
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button variant="secondary" onClick={reject} disabled={!a.canDecide} title={why} className="flex-1 sm:flex-none max-sm:h-11">
                <X className="size-4" /> Reject
              </Button>
              <Button variant={a.risk === "danger" ? "danger" : "primary"} onClick={approve} disabled={!a.canDecide} title={why} className="flex-1 sm:flex-none max-sm:h-11">
                <Check className="size-4" /> Approve
              </Button>
            </div>
          </>
        }
      />
    </div>
  );
}
