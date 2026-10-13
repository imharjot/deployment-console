"use client";
// Runs: what agents did, and what they are doing now. The strip on top is the release metrics (AGENT_ARCHITECTURE §9:
// verified completion, escalations, unknown outcomes, prevented violations, duplicate effects, invalidated approvals,
// estimated inference cost) — not how confident the answers sounded. Below, every run with its state, what it waits
// for and who pays; opening one (#runs/<id>) shows the full <RunView>, live.
import { ArrowLeft, Bot } from "lucide-react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Chip, Empty, Segmented, Skeleton, TimeAgo, cx } from "@/components/ui";
import { RunStateChip } from "@/components/agents/outcome-badges";
import { RUN_FILTERS, RUN_KIND, initiatorOf, isFinalRunState, metricTiles, runMatches, waitingText, type RunFilter } from "@/components/agents/rules";
import { RunView } from "@/components/agents/run-view";
import type { RunListItem, RunMetrics } from "@/components/agents/types";
import { ApiError } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { DataTable, type Column } from "../_components/data-table";
import { SearchField, SelectField } from "../_components/fields";
import { SectionTitle } from "../_components/page-frame";

export function RunsTab({ runId, admin }: { runId?: string; admin: boolean }) {
  if (runId)
    return (
      <div className="space-y-4">
        <a href="#runs" className="inline-flex items-center gap-1.5 text-[13.5px] text-fg-3 hover:text-fg-2 pointer-coarse:py-2">
          <ArrowLeft className="size-3.5" aria-hidden /> All runs
        </a>
        <RunView runId={runId} />
      </div>
    );
  return <RunsOverview admin={admin} />;
}

// The metrics and the list share one scope: your runs, or (admins) everyone's.
function RunsOverview({ admin }: { admin: boolean }) {
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const all = scope === "all" && admin;
  return (
    <div className="space-y-6">
      <MetricsStrip all={all} />
      <RunList admin={admin} scope={scope} setScope={setScope} />
    </div>
  );
}

function MetricsStrip({ all }: { all: boolean }) {
  const { data, error, isLoading } = useSWR<RunMetrics>(`/api/agents/metrics${all ? "?all=1" : ""}`, { refreshInterval: 60_000 });
  if (error) return null; // the list below says when runs aren't available
  return (
    <section aria-label="Agent release metrics" className="space-y-2">
      <SectionTitle>
        Release metrics{all ? " · everyone's runs" : " · your runs"}
        {data?.since ? <span className="ml-1.5 normal-case tracking-normal text-fg-3">since {stamp(data.since)}</span> : null}
      </SectionTitle>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line shadow-card sm:grid-cols-4">
        {isLoading || !data
          ? Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="bg-panel p-3">
                <Skeleton className="h-10" />
              </div>
            ))
          : metricTiles(data).map((t) => (
              <div key={t.key} className="min-w-0 bg-panel px-3.5 py-3" title={t.hint}>
                <dt className="truncate text-[12.5px] text-fg-3">{t.label}</dt>
                <dd className={cx("mt-0.5 text-[20px] font-semibold tabular-nums leading-tight", t.tone === "bad" ? "text-down" : t.tone === "warn" ? "text-degraded" : "text-fg")}>{t.value}</dd>
                <dd className="sr-only">{t.hint}</dd>
              </div>
            ))}
      </dl>
    </section>
  );
}

const columns: Column<RunListItem>[] = [
  {
    key: "run",
    header: "Run",
    slot: "title",
    className: "@min-2xl:w-[46%]",
    cell: (r) => {
      const w = waitingText(r);
      return (
        <div className="min-w-0">
          <a href={`#runs/${r.id}`} className="line-clamp-2 font-medium text-fg [overflow-wrap:anywhere] hover:underline" title={r.title ?? undefined}>
            {r.title || "Untitled run"}
          </a>
          <div className="mt-0.5 text-[12.5px] text-fg-3">
            <span className="font-mono">{r.id.slice(0, 8)}</span>
            {w && !isFinalRunState(r.state) ? <span> · waiting for {w}</span> : r.error ? <span className="text-down"> · {r.error}</span> : null}
          </div>
        </div>
      );
    },
  },
  {
    key: "state",
    header: "State",
    slot: "end",
    className: "whitespace-nowrap",
    cell: (r) => <RunStateChip state={r.state} />,
  },
  { key: "kind", header: "Kind", label: "kind", slot: "meta", className: "whitespace-nowrap text-fg-2", cell: (r) => RUN_KIND[r.kind] ?? r.kind },
  {
    key: "payer",
    header: "Connection · pays",
    label: "pays",
    slot: "meta",
    className: "text-fg-2 @min-2xl:max-w-[220px]",
    cell: (r) => (r.connection ? <span className="block @min-2xl:truncate" title={r.connection.payer}>{r.connection.label ?? r.connection.id}{r.connection.payer ? ` · ${r.connection.payer}` : ""}</span> : r.kind === "external" ? "the client's own" : "none"),
  },
  { key: "by", header: "Started by", label: "by", slot: "meta", className: "text-fg-2 @max-2xl:[overflow-wrap:anywhere]", cell: (r) => initiatorOf(r) ?? (r.kind === "workflow" ? "trigger" : "—") },
  { key: "updated", header: "Updated", slot: "meta", className: "whitespace-nowrap text-fg-2", cell: (r) => <span title={stamp(r.updatedAt)}><TimeAgo at={r.updatedAt} /></span> },
];

function RunList({ admin, scope, setScope }: { admin: boolean; scope: "mine" | "all"; setScope(s: "mine" | "all"): void }) {
  const [filter, setFilter] = useState<RunFilter>("all");
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const key = `/api/agents/runs?limit=200${scope === "all" && admin ? "&all=1" : ""}`;
  const { data, error, isLoading } = useSWR<{ runs: RunListItem[] }>(key, { refreshInterval: 20_000 });
  const all = useMemo(() => data?.runs ?? [], [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => runMatches(r, filter) && (kind === "all" || r.kind === kind) && (!needle || `${r.title ?? ""} ${r.id} ${initiatorOf(r) ?? ""} ${r.connection?.label ?? ""}`.toLowerCase().includes(needle)));
  }, [all, filter, kind, q]);
  const counts = useMemo(() => Object.fromEntries(RUN_FILTERS.map((f) => [f.value, all.filter((r) => runMatches(r, f.value)).length])), [all]);
  const unavailable = error instanceof ApiError && error.status === 404;

  return (
    <section className="space-y-3" aria-label="Runs">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          id="run-filter"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={RUN_FILTERS.map((f) => ({
            value: f.value,
            label: (
              <span className="inline-flex items-center gap-1">
                {f.label}
                <span className="tabular-nums text-fg-3">{counts[f.value] ?? 0}</span>
              </span>
            ),
          }))}
        />
        <SelectField value={kind} onChange={setKind} label="Kind of run" className="w-[150px]">
          <option value="all">All kinds</option>
          <option value="assistant">Assistant</option>
          <option value="workflow">Workflow</option>
          <option value="external">External agent</option>
        </SelectField>
        {admin && <Segmented id="run-scope" size="sm" value={scope} onChange={setScope} options={[{ value: "mine", label: "Mine" }, { value: "all", label: "Everyone" }]} />}
        <SearchField value={q} onChange={setQ} label="Filter runs" placeholder="Filter runs…" className="w-full sm:ml-auto sm:w-64" />
      </div>
      <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
        {isLoading ? (
          <div className="space-y-px p-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : unavailable ? (
          <Empty icon={<Bot className="size-5" />} title="Runs aren't available on this console yet" hint="The agent runner hasn't been installed on this server. Approvals, tokens and connections still work." />
        ) : error ? (
          <Empty title="Couldn't load runs" hint={(error as Error).message} />
        ) : rows.length ? (
          <DataTable label="Agent runs" rows={rows} rowKey={(r) => r.id} columns={columns} />
        ) : all.length ? (
          <Empty title="No run matches" hint={`${all.length} run${all.length === 1 ? "" : "s"} in all — clear a filter to see them.`} />
        ) : (
          <Empty
            icon={<Bot className="size-5" />}
            title="No runs yet"
            hint={
              <>
                Ask the assistant about a service, run a workflow, or <a href="#connect" className="underline decoration-line-strong underline-offset-2">connect your own agent</a>. Every run shows up here.
              </>
            }
          />
        )}
      </div>
      {!!rows.length && rows.some((r) => r.state === "outcome_unknown") && (
        <p className="flex items-center gap-1.5 text-[13px] text-fg-3">
          <Chip tone="bad">Outcome unknown</Chip> runs sent a change whose result AWS didn&apos;t confirm. Open one before asking again.
        </p>
      )}
    </section>
  );
}
