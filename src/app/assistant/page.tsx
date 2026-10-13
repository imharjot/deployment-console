"use client";
// /assistant: my questions to the assistant, newest first, and one of them in full (`?run=<id>`). Each question is an
// incident-investigator run: replay what it read and found (evidence with ages, the answer's citations, every step,
// proposals and the AI / AWS / health outcomes, in the Automation UI's <RunView>), approve or reject what it proposed,
// or resume it in the drawer, where it keeps streaming. "Ask a question" opens the drawer.
import { ArrowLeft, MessageSquareText, PanelRightOpen, Sparkles } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import useSWR from "swr";
import { RunStateChip } from "@/components/agents/outcome-badges";
import { RunView } from "@/components/agents/run-view";
import { RunBoundary } from "@/components/assistant/boundary";
import { ProposalDecision } from "@/components/assistant/decide";
import { myAssistantRuns, normalizeRunList, type RunListItem } from "@/components/assistant/model";
import { OFF_TEXT, useAgentsStatus } from "@/components/assistant/status";
import { openAssistant, resume } from "@/components/assistant/store";
import { Swap } from "@/components/motion";
import { Button, Empty, Skeleton, TimeAgo, cx } from "@/components/ui";
import { useMe } from "@/components/user-menu";
import { ApiError, getJson } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { Page, PageHeader, SectionTitle } from "../_components/page-frame";

// Only assistant runs, so workflow runs never crowd them out of the newest 50.
const runsKey = ["assistant-runs", "/api/agents/runs?kind=assistant"] as const;
const fetchRuns = async ([, url]: readonly [string, string]) => normalizeRunList(await getJson<unknown>(url));

export default function AssistantPage() {
  return (
    <Suspense>
      <Assistant />
    </Suspense>
  );
}

function Assistant() {
  const param = useSearchParams().get("run");
  const selected = param && /^[A-Za-z0-9_-]{1,100}$/.test(param) ? param : undefined;
  const me = useMe().data;
  const { off } = useAgentsStatus();
  const { data, error, isLoading } = useSWR(runsKey, fetchRuns, { refreshInterval: 15_000, keepPreviousData: true });
  const runs = myAssistantRuns(data ?? [], me ? { email: me.email ?? me.user?.email, id: me.user?.id } : undefined);
  const current = runs.find((r) => r.id === selected);

  return (
    <Page width="wide">
      <PageHeader
        title="Assistant"
        description="Your questions and what the assistant found. Each answer cites the evidence it read through the console's own operations, and any change it proposes waits for a person to approve."
        actions={
          <Button variant="primary" onClick={() => openAssistant()} disabled={off} title={off ? OFF_TEXT : "Ask a question (g i)"} className="max-sm:h-10 max-sm:flex-1">
            <Sparkles className="size-4" strokeWidth={1.75} /> Ask a question
          </Button>
        }
      />
      {off && (
        <p role="note" className="rounded-xl border border-degraded/25 bg-degraded/6 px-4 py-2.5 text-[14px] leading-relaxed text-fg-2">
          {OFF_TEXT} Earlier runs stay readable here.
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
        <section aria-labelledby="runs-title" className={cx("min-w-0 space-y-3", selected && "max-lg:hidden")}>
          <SectionTitle className="flex items-center justify-between">
            <span id="runs-title">My recent questions</span>
          </SectionTitle>
          <Swap id={isLoading && !data ? "load" : error && !data ? "err" : runs.length ? "list" : "empty"}>
            {isLoading && !data ? (
              <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
            ) : error && !data ? (
              <div className="rounded-2xl border border-line bg-panel shadow-card">
                <Empty
                  title="Couldn't load your runs"
                  hint={error instanceof ApiError && error.status === 404 ? "The runs API isn't available on this console yet." : (error as Error).message}
                />
              </div>
            ) : runs.length ? (
              <ul className="space-y-1.5">
                {runs.map((r) => (
                  <RunRow key={r.id} r={r} active={r.id === selected} />
                ))}
              </ul>
            ) : (
              <div className="rounded-2xl border border-line bg-panel shadow-card">
                <Empty icon={<MessageSquareText className="size-5" />} title="No questions yet" hint="Ask from the header, press g i, or use “Why is this unhealthy?” on a resource that isn't ok." />
              </div>
            )}
          </Swap>
        </section>

        <section aria-label="Selected run" className={cx("min-w-0", !selected && "max-lg:hidden")}>
          {selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Link href="/assistant" className="press inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[14px] font-medium text-fg-2 hover:bg-panel-2 hover:text-fg lg:hidden pointer-coarse:h-10">
                  <ArrowLeft className="size-4" /> All questions
                </Link>
                <div className="ml-auto flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => resume({ id: selected, question: current?.title ?? "An earlier question", resourceKey: current?.resourceKey })} title="Open this run in the drawer, where it keeps streaming">
                    <PanelRightOpen className="size-3.5" /> Continue in the drawer
                  </Button>
                  <Link href={`/automation#runs/${encodeURIComponent(selected)}`} className="press inline-flex h-7 items-center rounded-lg px-2.5 text-xs font-medium text-fg-2 hover:bg-panel-2 hover:text-fg pointer-coarse:h-9">
                    Open in Automation
                  </Link>
                </div>
              </div>
              <RunBoundary key={selected} runId={selected}>
                <RunView runId={selected} proposalActions={(p) => <ProposalDecision proposal={p} runId={selected} />} />
              </RunBoundary>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-line-strong">
              <Empty icon={<Sparkles className="size-5" />} title="Pick a question to replay it" hint="The evidence it read, its answer, what it proposed and how it ended." />
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}

function RunRow({ r, active }: { r: RunListItem; active: boolean }) {
  return (
    <li>
      <Link
        href={`/assistant?run=${encodeURIComponent(r.id)}`}
        aria-current={active ? "page" : undefined}
        className={cx(
          "press block rounded-xl border px-3.5 py-2.5 [--press-scale:0.985]",
          active ? "border-accent/45 bg-panel shadow-card" : "border-line bg-panel hover:border-line-strong hover:bg-panel-2",
        )}
      >
        <div className="line-clamp-2 text-[14px] font-medium leading-snug [overflow-wrap:anywhere]">{r.title ?? "Untitled question"}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-fg-3">
          <RunStateChip state={r.state} />
          {r.createdAt && (
            <span title={stamp(r.createdAt)}>
              <TimeAgo at={r.createdAt} />
            </span>
          )}
          {r.connection?.label && <span className="min-w-0 truncate">· {r.connection.label}</span>}
        </div>
      </Link>
    </li>
  );
}
