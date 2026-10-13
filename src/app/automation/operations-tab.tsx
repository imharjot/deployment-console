"use client";
// The live operations catalog, as the signed-in person sees it: what an agent can call, the role it needs, its risk,
// its input schema and a copyable curl example. The same list (for a token's caller) is GET /api/ops.
import { ChevronRight, Check, Copy, ExternalLink, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Button, Chip, Empty, Skeleton, copy } from "@/components/ui";
import { RoleChip } from "@/components/user-menu";
import { exampleInput } from "@/lib/ops-schema";
import type { OpInfo } from "@/lib/server/ops";
import { SearchField } from "../_components/fields";
import { SectionTitle } from "../_components/page-frame";
import { RiskChip } from "./approvals-tab";

const AREA: Record<string, string> = {
  envs: "Environments", issues: "Issues", services: "Services", hosts: "Hosts", databases: "Databases", logs: "Logs", metrics: "Metrics",
  variables: "Environment variables", ci: "CI", audit: "Audit", releases: "Releases", approvals: "Approvals", costs: "Costs", tasks: "Tasks",
  cloud: "Cloud map", notes: "Notes", runs: "Agent runs", workflows: "Workflows", operations: "Operation records",
};

function curlFor(op: OpInfo) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const body = JSON.stringify({ input: exampleInput(op.input) });
  return `curl -sS -X POST "${origin}/api/ops/${op.name}" \\\n  -H "Authorization: Bearer $CONSOLE_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
}

export function OperationsTab() {
  const { data, error, isLoading } = useSWR<{ operations: OpInfo[] }>("/api/ops", { revalidateOnFocus: false });
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (data?.operations ?? []).filter((o) => !needle || `${o.name} ${o.title} ${o.description}`.toLowerCase().includes(needle));
    const m = new Map<string, OpInfo[]>();
    for (const o of list) m.set(o.area, [...(m.get(o.area) ?? []), o]);
    return [...m];
  }, [data, q]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[14px] leading-relaxed text-fg-3">
          Everything an agent can do. Call one with <code className="font-mono text-[13px] text-fg-2">POST /api/ops/&lt;name&gt;</code> and <code className="font-mono text-[13px] text-fg-2">{`{ "input": … }`}</code>, add <code className="font-mono text-[13px] text-fg-2">&quot;dryRun&quot;: true</code> for the plan only.
        </p>
        <div className="flex w-full flex-wrap items-center gap-2 text-[13px] text-fg-3 sm:w-auto">
          Tool definitions:
          {(["anthropic", "openai", "mcp"] as const).map((f) => (
            <a key={f} href={`/api/ops?format=${f}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg pointer-coarse:py-2.5">
              {f} <ExternalLink className="size-3" aria-hidden />
            </a>
          ))}
        </div>
      </div>
      <SearchField value={q} onChange={setQ} label="Filter operations" placeholder="Filter operations…" className="w-full sm:w-80" />
      {isLoading ? (
        <div className="grid gap-3 lg:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}</div>
      ) : error ? (
        <div className="rounded-2xl border border-line bg-panel shadow-card"><Empty title="Couldn't load operations" hint={(error as Error).message} /></div>
      ) : !groups.length ? (
        <div className="rounded-2xl border border-line bg-panel shadow-card"><Empty title="No operation matches" /></div>
      ) : (
        groups.map(([area, ops]) => (
          <section key={area} className="space-y-2.5" aria-label={AREA[area] ?? area}>
            <SectionTitle>{AREA[area] ?? area}</SectionTitle>
            <div className="grid gap-3 lg:grid-cols-2">
              {ops.map((o) => (
                <OpCard key={o.name} op={o} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function OpCard({ op }: { op: OpInfo }) {
  const [copied, setCopied] = useState(false);
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-line bg-panel p-4 shadow-card" aria-labelledby={`op-${op.tool}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`op-${op.tool}`} className="text-[15px] font-semibold leading-snug">{op.title}</h3>
          <div className="mt-0.5 font-mono text-[12.5px] text-fg-3 [overflow-wrap:anywhere]">{op.name}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <RiskChip risk={op.risk} />
          <RoleChip role={op.role} />
          {op.roleProtected !== op.role && (
            <Chip tone="muted" className="whitespace-nowrap">
              <Lock className="size-3" /> {op.roleProtected}
            </Chip>
          )}
          {!op.allowed && <Chip tone="muted">not for your role</Chip>}
        </div>
      </div>
      <p className="mt-2 text-[13.5px] leading-relaxed text-fg-2">{op.description}</p>
      <div className="mt-auto pt-3">
        <details className="group rounded-xl border border-line bg-panel-2/50">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-medium text-fg-3 hover:text-fg-2 pointer-coarse:py-3 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform duration-200 group-open:rotate-90" aria-hidden /> Input schema
          </summary>
          <pre className="max-h-72 overflow-auto px-3 pb-3 font-mono text-[12px] leading-relaxed text-fg-2">{JSON.stringify(op.input, null, 2)}</pre>
        </details>
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await copy(curlFor(op));
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy curl"}
          </Button>
        </div>
      </div>
    </article>
  );
}
