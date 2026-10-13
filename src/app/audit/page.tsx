"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Swap, useFresh } from "@/components/motion";
import { Chip, Empty, Segmented, Skeleton, TimeAgo, copy } from "@/components/ui";
import { auditRegion, stamp } from "@/lib/client/format";
import { useEnvList } from "@/lib/client/env";
import { regionLabel, useRegions } from "@/lib/client/region";
import type { AuditEntry, EnvInfo } from "@/lib/types";
import { DataTable, type Column } from "../_components/data-table";
import { SearchField, SelectField } from "../_components/fields";
import { Page, PageHeader } from "../_components/page-frame";
import { ScrollX } from "../_components/scroll-x";

// An entry may also say whether the change it records was verified (operations.verify, joined by the server).
type Entry = AuditEntry;

const RESULT: Record<NonNullable<AuditEntry["result"]>, { tone: "ok" | "bad" | "warn"; label: string; hint?: string }> = {
  ok: { tone: "ok", label: "ok" },
  error: { tone: "bad", label: "error" },
  // The request may or may not have reached AWS (a timeout after sending, a console restart mid-change).
  unknown: { tone: "warn", label: "unknown", hint: "AWS may or may not have made this change — check the resource before retrying" },
};

function Verification({ e }: { e: Entry }) {
  if (e.phase !== "result" || e.result !== "ok" || e.verify === undefined) return null;
  if (e.verify === "verified") return <Chip tone="ok">verified</Chip>;
  if (e.verify === "failed") return <span title={e.verifyDetail}><Chip tone="bad">did not stabilise</Chip></span>;
  return <Chip tone="accent">AWS accepted — verifying</Chip>;
}

// Card (narrow): action + result on top, the target, who · when, then the reason.
const columns = (envs: EnvInfo[] | undefined, multi: boolean, home?: string): Column<Entry>[] => {
  const env = (id: string) => envs?.find((x) => x.id === id);
  return [
    { key: "when", header: "When", slot: "meta", className: "whitespace-nowrap text-fg-2", cell: (e) => <span title={stamp(e.at)}><TimeAgo at={e.at} /></span> },
    { key: "who", header: "Who", slot: "meta", className: "@max-2xl:[overflow-wrap:anywhere]", cell: (e) => e.user },
    { key: "action", header: "Action", slot: "title", cell: (e) => <span className="inline-flex flex-wrap items-center gap-1.5"><Chip mono>{e.action}</Chip><span className="text-[12px] text-fg-3">{e.phase}</span></span> },
    {
      key: "target",
      header: "Target",
      slot: "line",
      cell: (e) => (
        <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 @min-2xl:flex-nowrap @min-2xl:whitespace-nowrap">
          <span className="font-mono text-xs @max-2xl:[overflow-wrap:anywhere]">{e.target}</span>
          {e.env && <Chip tone={env(e.env)?.protected ? "bad" : "muted"}>{env(e.env)?.label ?? e.env}</Chip>}
        </span>
      ),
    },
    ...(multi ? [{ key: "region", header: "Region", slot: "meta" as const, className: "whitespace-nowrap font-mono text-[13px] text-fg-2", cell: (e: Entry) => { const r = auditRegion(e, envs, home); return r ? <span title={regionLabel(r)}>{r}</span> : <span className="text-fg-3">—</span>; } }] : []),
    {
      key: "result",
      header: "Result",
      slot: "end",
      cell: (e) =>
        e.result && (
          <span className="inline-flex flex-wrap items-center justify-end gap-1">
            <span title={RESULT[e.result]?.hint}>
              <Chip tone={RESULT[e.result]?.tone ?? "bad"}>{RESULT[e.result]?.label ?? e.result}</Chip>
            </span>
            <Verification e={e} />
          </span>
        ),
    },
    {
      key: "op",
      header: "Operation",
      label: "operation",
      slot: "meta",
      className: "whitespace-nowrap",
      cell: (e) =>
        e.operationId ? (
          <button type="button" onClick={() => void copy(e.operationId!)} title={`Operation ${e.operationId} — click to copy`} className="font-mono text-[12.5px] text-fg-3 hover:text-fg pointer-coarse:min-h-10">
            {e.operationId.slice(0, 8)}
          </button>
        ) : null,
    },
    {
      key: "reason",
      header: "Reason / detail",
      slot: "line",
      // One line on the desktop table (full text on hover); wraps on cards, where there is no hover.
      className: "text-fg-2 @max-2xl:text-[13.5px] @min-2xl:max-w-[360px] @min-2xl:truncate",
      cell: (e) => {
        const hint = e.result === "unknown" ? RESULT.unknown.hint : undefined;
        const text = e.reason ?? e.detail ?? hint;
        return text && <span title={[e.reason, e.detail, hint].filter(Boolean).join(" · ")} className={!e.reason && !e.detail ? "text-degraded" : undefined}>{text}</span>;
      },
    },
  ];
};

export default function AuditPage() {
  const { data, error, isLoading } = useSWR<Entry[]>("/api/audit?limit=200", { refreshInterval: 15_000 });
  const [env, setEnv] = useState("all");
  const [region, setRegion] = useState("all");
  const envList = useEnvList().data;
  const regions = useRegions();
  const home = regions.data?.home;
  const [q, setQ] = useState("");
  const rows = useMemo(
    () =>
      (data ?? []).filter(
        (e) =>
          (env === "all" || e.env === env) &&
          (region === "all" || auditRegion(e, envList, home) === region) &&
          (!q || `${e.user} ${e.target} ${e.action} ${e.reason ?? ""} ${e.operationId ?? ""}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [data, env, region, envList, home, q],
  );
  // Stable row keys (no index: a new entry at the top would otherwise remount every row).
  const keys = useMemo(() => {
    const seen = new Map<string, number>();
    return rows.map((e) => {
      const k = `${e.at}-${e.phase}-${e.action}-${e.target}-${e.user}`;
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      return n ? `${k}#${n}` : k;
    });
  }, [rows]);
  const { fresh, gen } = useFresh(keys);
  const cols = useMemo(() => columns(envList, regions.multi, home), [envList, regions.multi, home]);
  return (
    <Page width="wide">
      <PageHeader
        title="Audit log"
        description="Every action: an intent entry before the AWS call, a result entry after. Actions are refused if the intent can't be written. A result of unknown means AWS may or may not have acted — check the resource before retrying."
        actions={
          <>
            <SearchField value={q} onChange={setQ} label="Filter the audit log" className="w-full sm:w-56" />
            {regions.multi && (
              <SelectField value={region} onChange={setRegion} label="Region">
                <option value="all">All regions</option>
                {regions.data?.regions.map((r) => <option key={r} value={r}>{regionLabel(r)}</option>)}
              </SelectField>
            )}
            <ScrollX>
              <Segmented id="audit-env" value={env} onChange={setEnv} options={[{ value: "all", label: "All" }, ...(envList ?? []).map((e) => ({ value: e.id, label: e.label }))]} />
            </ScrollX>
          </>
        }
      />
      <Swap id={isLoading ? "loading" : error ? "error" : !rows.length ? "empty" : `table-${env}-${region}-${gen}`} className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
        {isLoading ? (
          <div className="space-y-px p-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-11" />)}</div>
        ) : error ? (
          <Empty title="Could not read the audit log" hint={(error as Error).message} />
        ) : !rows.length ? (
          <Empty title={q || env !== "all" || region !== "all" ? "Nothing matches" : "No actions yet"} hint={q || env !== "all" || region !== "all" ? "Clear the filter to see every entry." : "Restarts, stops, rollbacks, box power and CI re-runs appear here."} />
        ) : (
          // Tables over 100 rows render without motion.
          <DataTable label="Audit log" rows={rows} rowKey={(_, i) => keys[i]} columns={cols} fresh={fresh} still={rows.length > 100} />
        )}
      </Swap>
    </Page>
  );
}
