"use client";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ChevronDown, Cloud, Database, FileJson, GitBranch, Globe, HardDrive, Loader2, Map as MapIcon, Network, RefreshCw, ScrollText, SearchX, Server, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { enter } from "@/components/motion";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, Skeleton, TimeAgo, cx } from "@/components/ui";
import { postJson } from "@/lib/client/api";
import type { InventoryView } from "@/lib/inventory/types";
import { DataTable, type Column } from "../../_components/data-table";
import { TAP } from "../../_components/page-frame";

interface Svc {
  id: string;
  name: string;
  repo?: string;
  repoSource?: "tag" | "config" | "guess";
  infra: boolean;
  hidden: boolean;
  self: boolean;
  logs?: { group: string; prefix?: string; container: string };
  healthcheck?: string;
  proxy: boolean;
  platform?: string; // compose envs: a declared workload, not an ECS service
}
interface Env {
  id: string;
  label: string;
  protected: boolean;
  region: string;
  cluster: string;
  kind: string;
  host?: string; // compose envs: the box's instance id
  branch?: string;
  source: "discovered" | "config";
  services: Svc[];
  hosts: { id: string; name: string; state: string; type: string; asg?: string }[];
  databases: { id: string; engine: string; status: string }[];
  caches: { id: string; engine: string; status: string }[];
  edges: { from: string; to: string; label: string; source: string }[];
  ingress?: string;
  warnings: string[];
}
interface Warning {
  scope: string;
  message: string;
  hint?: string;
  kind: "environment" | "database" | "cache" | "region" | "healthcheck";
  env?: string;
  region?: string;
}
interface Discovery {
  source: "aws" | "mock";
  region: string;
  regions?: string[];
  regionsInfo?: { region: string; home: boolean; envs: number; error?: string }[];
  scannedAt: number;
  config: { file: string | null; errors: string[]; failClosed?: boolean; stale?: boolean };
  errors: string[];
  warnings?: Warning[];
  envs: Env[];
  unassigned: { databases: string[]; caches: string[] };
}

// What console.config.json names that the account doesn't have; health-check problems show on their env's card.
const CONFIG_KINDS = new Set<Warning["kind"]>(["environment", "database", "cache", "region"]);

export default function EnvironmentsSettings() {
  const { data, error, isLoading } = useSWR<Discovery>("/api/discovery", { refreshInterval: 60_000, keepPreviousData: true });
  const me = useSWR<{ perms: string[] }>("/api/me").data;
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const rescan = async () => {
    setBusy(true);
    try {
      await postJson("/api/discovery", {});
      await mutate((k) => typeof k === "string" && (k.startsWith("/api/discovery") || k.startsWith("/api/envs") || k.startsWith("/api/overview")));
      toast.push({ tone: "ok", title: "Re-scanned", body: "Discovery refreshed from AWS." });
    } catch (e) {
      toast.push({ tone: "error", title: "Re-scan failed", body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Empty title="Could not load discovery" hint={(error as Error).message} />;
  if (isLoading || !data) return <div className="space-y-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}</div>;

  const warnings = data.warnings ?? [];
  const missing = warnings.filter((w) => CONFIG_KINDS.has(w.kind));
  // "Everything … was discovered" only when nothing anywhere says otherwise.
  const clean = !warnings.length && !data.errors.length && !data.config.errors.length;
  const regions = data.regionsInfo ?? [{ region: data.region, home: true, envs: data.envs.length }];
  const byRegion = regions.length > 1;
  let n = 0;

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-line bg-panel p-4 shadow-card">
        <Fact icon={Cloud} label="Source" value={data.source === "mock" ? "Demo account (simulated)" : `AWS · ${data.region}`} />
        {byRegion && <Fact icon={Globe} label="Regions" value={regions.map((r) => r.region).join(", ")} mono />}
        <Fact icon={RefreshCw} label="Last scan" value={<TimeAgo at={data.scannedAt} />} />
        <Fact icon={FileJson} label="Config file" value={data.config.file ?? "none (pure discovery)"} mono />
        <div className="ml-auto flex items-center gap-2">
          <Link href="/docs/discovery" className={cx("text-xs text-accent hover:underline", TAP)}>How discovery works</Link>
          {me?.perms.includes("admin") && (
            <Button size="sm" onClick={rescan} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Re-scan now
            </Button>
          )}
        </div>
        {data.config.failClosed && (
          <p className="flex w-full gap-2 rounded-xl border border-down/30 bg-down/8 p-3 text-xs text-down">
            <ShieldAlert className="mt-px size-3.5 flex-none" />
            The config file can&apos;t be read, so the console fails closed: every environment is treated as protected and provisioning is off until the file is fixed.
          </p>
        )}
        {data.config.stale && (
          <p className="flex w-full gap-2 rounded-xl border border-degraded/30 bg-degraded/8 p-3 text-xs text-degraded">
            <AlertTriangle className="mt-px size-3.5 flex-none" />
            The config file is broken right now; the console keeps using the last version it could read.
          </p>
        )}
        {[...data.config.errors, ...data.errors].length > 0 && (
          <ul className="w-full space-y-1 rounded-xl border border-degraded/30 bg-degraded/8 p-3 text-xs text-degraded">
            {[...data.config.errors.map((e) => `config: ${e}`), ...data.errors].map((e) => (
              <li key={e} className="flex gap-2 [overflow-wrap:anywhere]"><AlertTriangle className="mt-px size-3.5 flex-none" />{e}</li>
            ))}
          </ul>
        )}
      </section>

      {missing.length > 0 && <NotFound warnings={missing} />}

      {!data.envs.length && (
        <Empty
          icon={<Server className="size-6" />}
          title="No ECS clusters found"
          hint={`The console turns each ECS cluster it reads (${regions.map((r) => r.region).join(", ")}) into an environment. Check the regions and that the console's role can call ecs:ListClusters.`}
        />
      )}
      {regions.map((r) => {
        const envs = data.envs.filter((e) => (e.region ?? data.region) === r.region);
        return (
          <div key={r.region} className="space-y-3">
            {byRegion && (
              <h2 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-1 text-[14px] font-semibold">
                <Globe className="size-3.5 self-center text-fg-3" />
                <span className="font-mono">{r.region}</span>
                {r.home && <Chip tone="muted">home</Chip>}
                <span className="text-xs font-normal text-fg-3">
                  {r.error ? <span className="text-degraded">couldn&apos;t be read: {r.error}</span> : envs.length ? `${envs.length} environment${envs.length === 1 ? "" : "s"}` : "no ECS environments"}
                </span>
              </h2>
            )}
            {envs.map((e) => <EnvCard key={e.id} e={e} i={n++} clean={clean} />)}
          </div>
        );
      })}

      <MapOnly known={new Set(data.envs.map((e) => e.id))} />

      {(data.unassigned.databases.length > 0 || data.unassigned.caches.length > 0) && (
        <section className="rounded-2xl border border-line bg-panel p-4 shadow-card">
          <h2 className="text-[16px] font-semibold">Not attributed to any environment</h2>
          <p className="mt-1 text-xs text-fg-3">
            Tag them <code className="rounded bg-panel-3 px-1">console:env=&lt;env id&gt;</code> (or <code className="rounded bg-panel-3 px-1">Environment</code>), or list them under <code className="rounded bg-panel-3 px-1">environments.&lt;id&gt;.databases / caches</code> in console.config.json.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {data.unassigned.databases.map((d) => <Chip key={d} mono><Database className="size-3" />{d}</Chip>)}
            {data.unassigned.caches.map((c) => <Chip key={c} mono><HardDrive className="size-3" />{c}</Chip>)}
          </div>
        </section>
      )}
    </div>
  );
}

// Config entries the account doesn't have (F05). Discovery doesn't invent them: they stay out of the environment list.
function NotFound({ warnings }: { warnings: Warning[] }) {
  return (
    <section className="rounded-2xl border border-degraded/30 bg-panel p-4 shadow-card">
      <h2 className="flex items-center gap-2 text-[16px] font-semibold"><SearchX className="size-4 text-degraded" />Configured but not found</h2>
      <p className="mt-1 text-xs text-fg-3">
        console.config.json names these, but the account doesn&apos;t have them where the console looks. They are left out until the names match (see{" "}
        <Link href="/docs/troubleshooting" className={cx("text-accent hover:underline", TAP)}>Troubleshooting</Link>).
      </p>
      <ul className="mt-3 divide-y divide-line text-xs">
        {warnings.map((w) => (
          <li key={`${w.scope} ${w.message}`} className="flex gap-2 py-2 first:pt-0 last:pb-0">
            <AlertTriangle className="mt-px size-3.5 flex-none text-degraded" />
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <div className="text-fg">{w.message}</div>
              {w.hint && <div className="mt-0.5 text-fg-3">{w.hint}</div>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Environments the cloud map found by tags, names or config (Lambda, EC2, databases…) with no ECS cluster behind them:
// they have no Overview, Services or Variables, only the map.
function MapOnly({ known }: { known: Set<string> }) {
  const inv = useSWR<InventoryView>("/api/inventory", { refreshInterval: 60_000, keepPreviousData: true, revalidateOnFocus: false }).data;
  if (!inv) return null;
  const envs = inv.envs.filter((e) => !known.has(e.id));
  if (!envs.length) return null;
  const count = (id: string) => inv.resources.filter((r) => r.env === id).length;
  const SOURCE: Record<string, string> = { tags: "from tags", names: "from names", config: "from console.config.json", ecs: "ECS" };
  return (
    <section className="rounded-2xl border border-line bg-panel p-4 shadow-card">
      <h2 className="flex items-center gap-2 text-[16px] font-semibold"><MapIcon className="size-4 text-fg-3" />Environments on the cloud map only (no ECS cluster)</h2>
      <p className="mt-1 text-xs text-fg-3">
        The cloud map placed resources in these environments, but no ECS cluster backs them, so they have no overview, services or variables here — see{" "}
        <Link href="/docs/limitations" className={cx("text-accent hover:underline", TAP)}>Limitations</Link> and{" "}
        <Link href="/docs/cloud-map" className={cx("text-accent hover:underline", TAP)}>the cloud map</Link>. Read-only.
      </p>
      <ul className="mt-3 divide-y divide-line text-[14px]">
        {envs.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0">
            <span className="font-medium">{e.label}</span>
            <Chip mono>{e.id}</Chip>
            {e.protected && <Chip tone="bad"><ShieldAlert className="size-3" />protected</Chip>}
            <span className="text-xs text-fg-3">{SOURCE[e.source] ?? e.source} · {count(e.id)} resource{count(e.id) === 1 ? "" : "s"}</span>
            <Link href={`/map?env=${encodeURIComponent(e.id)}`} className={cx("ml-auto text-xs text-accent hover:underline", TAP)}>Open on the map</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Fact({ icon: Icon, label, value, mono }: { icon: typeof Cloud; label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="grid size-8 flex-none place-items-center rounded-lg border border-line bg-panel-2 text-fg-3"><Icon className="size-4" /></div>
      <div className="min-w-0 leading-tight [overflow-wrap:anywhere]">
        <div className="eyebrow">{label}</div>
        <div className={cx("text-[14px]", mono && "font-mono text-xs")}>{value}</div>
      </div>
    </div>
  );
}

const SOURCE_TONE: Record<string, "ok" | "accent" | "warn"> = { tag: "ok", config: "accent", guess: "warn" };

const serviceColumns = (e: Env): Column<Svc>[] => [
  {
    key: "service",
    header: "Service",
    slot: "title",
    cell: (s) => (
      <>
        <div className="flex flex-wrap items-center gap-1.5 font-medium">
          {s.name} {s.self && <Chip tone="accent">this console</Chip>} {s.proxy && e.ingress === `service:${s.id}` && <Chip>ingress</Chip>} {s.infra && <Chip tone="muted">infra</Chip>} {s.hidden && <Chip tone="muted">hidden</Chip>}
        </div>
        <div className="font-mono text-[12px] text-fg-3 @max-2xl:[overflow-wrap:anywhere]">{s.id}</div>
      </>
    ),
  },
  {
    key: "repo",
    header: "Repository",
    cell: (s) =>
      s.repo ? (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <a className={cx("font-mono text-xs text-accent hover:underline @max-2xl:[overflow-wrap:anywhere]", TAP)} href={`https://github.com/${s.repo}`} target="_blank" rel="noreferrer">{s.repo}</a>
          {s.repoSource && <Chip tone={SOURCE_TONE[s.repoSource]}>{s.repoSource === "guess" ? "name match" : s.repoSource}</Chip>}
        </span>
      ) : s.infra ? null : (
        <span className="text-xs text-degraded">not mapped</span>
      ),
  },
  {
    key: "logs",
    header: "Logs",
    className: "font-mono text-[12px] text-fg-2",
    cell: (s) =>
      s.logs ? (
        <span className="inline-flex items-start gap-1 @max-2xl:[overflow-wrap:anywhere]"><ScrollText className="mt-0.5 size-3 flex-none text-fg-3" />{s.logs.group}{s.logs.prefix ? ` · ${s.logs.prefix}*` : ""}</span>
      ) : s.platform ? (
        <span className="font-sans text-fg-3">{s.platform} · not in CloudWatch</span>
      ) : (
        <span className="text-degraded">no awslogs</span>
      ),
  },
  // Truncated with a tooltip on the wide table; wraps on cards (no hover on touch).
  { key: "health", header: "Health check", label: "Health", className: "font-mono text-[12px] text-fg-2 @max-2xl:[overflow-wrap:anywhere] @min-2xl:max-w-[260px] @min-2xl:truncate", cell: (s) => s.healthcheck && <span title={s.healthcheck}>{s.healthcheck}</span> },
];

function EnvCard({ e, i, clean }: { e: Env; i: number; clean: boolean }) {
  const [showEdges, setShowEdges] = useState(false);
  const bySource = e.edges.reduce<Record<string, number>>((m, x) => {
    const k = x.source.startsWith("inferred") ? (x.source.includes("security group") ? "security groups" : "connection strings") : x.source === "console.config.json workloads" ? "workloads" : x.source === "console.config.json" ? "config" : "load balancer";
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  return (
    <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...enter, delay: Math.min(i, 6) * 0.04 }} className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-3">
        <h2 className="text-[16px] font-semibold">{e.label}</h2>
        <Chip mono>{e.id}</Chip>
        {e.protected && <Chip tone="bad"><ShieldAlert className="size-3" />protected</Chip>}
        {e.region && <Chip tone="muted"><Globe className="size-3" />{e.region}</Chip>}
        <Chip tone="muted">{e.kind === "ec2" ? "ECS on EC2" : e.kind === "fargate" ? "Fargate" : e.kind === "compose" ? "docker compose" : e.kind}</Chip>
        <span className="font-mono text-xs text-fg-3">{e.kind === "compose" ? `box ${e.host}` : `cluster ${e.cluster}`}</span>
        {e.branch ? <Chip><GitBranch className="size-3" />{e.branch}</Chip> : <span className="text-xs text-fg-3">no branch (tag console:branch)</span>}
        <span className="ml-auto text-[13px] text-fg-3">{e.kind === "compose" ? "docker compose box in console.config.json" : e.source === "config" ? "mapped in console.config.json" : "discovered from the cluster"}</span>
      </header>

      {e.services.length ? (
        <DataTable label={`Services in ${e.label}`} rows={e.services} rowKey={(s) => s.id} columns={serviceColumns(e)} still rowClassName={(s) => s.hidden && "opacity-50"} />
      ) : (
        <p className="px-4 py-6 text-center text-xs text-fg-3">{e.kind === "compose" ? "No workloads declared for this environment in console.config.json." : "No services in this cluster."}</p>
      )}

      <div className="grid gap-4 border-t border-line p-4 md:grid-cols-3">
        <div>
          <div className="eyebrow mb-1.5">Resources</div>
          <div className="flex flex-wrap gap-1.5">
            {e.hosts.map((h) => <Chip key={h.id} mono><Server className="size-3" />{h.name} · {h.state}{h.asg ? " · ASG" : ""}</Chip>)}
            {e.databases.map((d) => <Chip key={d.id} mono><Database className="size-3" />{d.id}</Chip>)}
            {e.caches.map((c) => <Chip key={c.id} mono><HardDrive className="size-3" />{c.id}</Chip>)}
            {!e.hosts.length && !e.databases.length && !e.caches.length && <span className="text-xs text-fg-3">none attributed</span>}
          </div>
        </div>
        <div>
          <div className="eyebrow mb-1.5">Connections</div>
          <button onClick={() => setShowEdges((x) => !x)} className="press flex flex-wrap items-center gap-1.5 text-left">
            <Network className="size-3.5 text-fg-3" />
            <span className="text-[14px]">{e.edges.length}</span>
            {Object.entries(bySource).map(([k, n]) => <Chip key={k} tone="muted">{n} {k}</Chip>)}
            <ChevronDown className={cx("size-3.5 text-fg-3 transition-transform", showEdges && "rotate-180")} />
          </button>
        </div>
        <div>
          <div className="eyebrow mb-1.5">Needs attention</div>
          {e.warnings.length ? (
            <ul className="space-y-1 text-xs text-degraded">{e.warnings.map((w) => <li key={w} className="flex gap-1.5"><AlertTriangle className="mt-px size-3 flex-none" />{w}</li>)}</ul>
          ) : (
            <span className={cx("text-xs", clean ? "text-up" : "text-fg-3")}>{clean ? "Everything the console needs was discovered." : "Nothing missing in this environment — see the warnings above."}</span>
          )}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {showEdges && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={enter} className="overflow-hidden border-t border-line">
            <ul className="divide-y divide-line text-xs">
              {e.edges.map((x) => (
                <li key={`${x.from}>${x.to}`} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 px-4 py-2 sm:grid-cols-[1fr_auto_1fr_2fr] sm:py-1.5">
                  <span className="truncate font-mono">{x.from}</span>
                  <span className="text-fg-3">→</span>
                  <span className="truncate font-mono">{x.to}</span>
                  {/* Its own line on phones, the fourth column from sm. */}
                  <span className="col-span-3 truncate text-fg-3 sm:col-span-1" title={x.source}>{x.label ? `${x.label} · ` : ""}{x.source}</span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
