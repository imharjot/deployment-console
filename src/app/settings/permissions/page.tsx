"use client";
// Settings → AWS permissions: what each cloud-map provider could read on the last discovery pass (GET /api/inventory), per
// region, grouped by what it discovers; whether the console's AWS identity can run the map's and the console's actions
// (GET /api/capability, and per provider from GET /api/permissions); what the map knows and doesn't (GET
// /api/inventory/coverage: denied, capped, stale, unresolved references, resources pending deletion confirmation,
// activity-metric spend, AWS call stats); and a policy builder that turns the providers' declarations into an IAM
// policy and copy-paste AWS CLI commands (GET /api/permissions/policy), starting from console.config.json
// inventory.providers. Read-only: nothing here changes AWS or the console. Operators and admins.
import { Activity, AlertTriangle, Check, ChevronRight, CircleCheck, CircleSlash, Cloud, Hourglass, KeyRound, Lock, Radar, Ship, ShieldAlert, ShieldCheck, Zap } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import { FreshnessBanner } from "@/components/freshness-banner";
import { KIND_ICON } from "@/components/map/kinds";
import { Chip, CopyButton, Empty, Segmented, Skeleton, Tabs, TimeAgo, cx } from "@/components/ui";
import { ROLE_INFO, useMe } from "@/components/user-menu";
import type { Freshness } from "@/lib/freshness";
import { CATEGORY_LABEL, CATEGORY_ORDER, KIND_INFO, type Category, type InventoryCompleteness, type InventoryView, type ProviderStatus, type RegionStatus, type ResourceKind } from "@/lib/inventory/types";
import {
  MANAGED_POLICY_LIMIT, cliScript, cloudflareScopes, fillPlaceholders, placeholdersIn, policyName, policySize, splitPolicy, validPlaceholder, validRoleName, withPrincipal,
  type PermissionsCatalog, type Placeholder, type PolicyMode, type PolicyResponse, type ProviderPermissions,
} from "@/lib/permissions";
import type { CapabilityView, CapState } from "@/lib/types";
import { SectionTitle, TAP } from "../../_components/page-frame";

// GET /api/permissions adds these to the catalog (src/app/api/permissions/route.ts).
interface WriteCapability {
  state: CapState;
  allowed: number;
  total: number;
  missing: string[];
}
type Catalog = PermissionsCatalog & { writeCapability?: Record<string, WriteCapability>; inventoryProviders?: { include?: string[]; exclude?: string[] } };

// GET /api/inventory/coverage (src/lib/server/inventory.ts InventoryCoverage, plus awsCalls for operators).
interface AwsCall { service: string; region: string; requests: number; attempts: number; throttled: number; errors: number; p95Ms: number; active: number; queued: number }
interface Coverage {
  generatedAt: number;
  regions: string[];
  homeRegion?: string;
  completeness: InventoryCompleteness;
  pendingRegions: string[];
  stale: string[];
  unresolved: { key: string; ref: string; account?: string; region?: string }[];
  unresolvedTotal: number;
  vanishing: { key: string; name: string; provider: string; region: string; lastSeen: number }[];
  activity: { metricsLastHour: number; estMonthlyUsd: number; budgetPerHour: number };
  awsCalls: AwsCall[];
  freshness: Freshness;
}

const STATE: Record<ProviderStatus["state"], { label: string; tone: "ok" | "bad" | "warn" | "muted"; rank: number }> = {
  denied: { label: "Missing read permissions", tone: "bad", rank: 0 },
  error: { label: "Error", tone: "warn", rank: 1 },
  disabled: { label: "Not set up", tone: "muted", rank: 2 },
  skipped: { label: "Skipped", tone: "muted", rank: 3 },
  ok: { label: "Working", tone: "ok", rank: 4 },
};
const CAP: Record<CapState, { label: string; tone: "ok" | "bad" | "warn" | "muted" }> = {
  allowed: { label: "Actions allowed", tone: "ok" },
  "probably-denied": { label: "Actions likely denied", tone: "warn" },
  denied: { label: "Actions denied", tone: "bad" },
  unknown: { label: "Actions not verified", tone: "muted" },
};
type Tab = "services" | "coverage" | "policy";
type Filter = "all" | "attention" | "working" | "off" | "planned";
const FILTER_LABEL: Record<Filter, string> = { all: "All", attention: "Needs attention", working: "Working", off: "Not set up", planned: "Coming soon" };
// Planned providers (registered, not built yet: `planned`) sort after every working one and need no setup.
const PLANNED_RANK = 5;
const plural = (label: string) => (label.endsWith("bus") ? `${label}es` : `${label}s`);
const num = (n: number) => n.toLocaleString("en-US");
const inputCls = "h-9 w-full rounded-lg border bg-panel-2 px-3 font-mono text-[13.5px] outline-none transition-colors placeholder:font-sans placeholder:text-fg-3 focus:border-accent pointer-coarse:h-10";
// A provider's group on this page: the category of the first thing it discovers.
const categoryOfProvider = (p: ProviderPermissions): Category => (p.kinds.length ? KIND_INFO[p.kinds[0]]?.category : undefined) ?? "other";
// The providers console.config.json inventory.providers runs (all when it says nothing).
const runsByConfig = (id: string, cfg?: Catalog["inventoryProviders"]) => !cfg?.exclude?.includes(id) && (!cfg?.include || cfg.include.includes(id));

export default function PermissionsPage() {
  const { data: me, error } = useMe();
  if (error) return <Empty title="Couldn't load your account" hint={(error as Error).message} />;
  if (!me) return <Skeleton className="h-64 rounded-2xl" />;
  if (me.user.role !== "admin" && me.user.role !== "operator")
    return (
      <div className="rounded-2xl border border-line bg-panel shadow-card">
        <Empty icon={<Lock className="size-6" />} title="Operators and admins only" hint={`AWS permissions are set up by whoever runs the console. You're signed in as ${ROLE_INFO[me.user.role].label.toLowerCase()}.`} />
      </div>
    );
  return <Permissions />;
}

function Permissions() {
  const catalog = useSWR<Catalog>("/api/permissions");
  // Same key as the cloud map, so both share one request. Optional: the builder works from declarations alone.
  const inv = useSWR<InventoryView>("/api/inventory", { refreshInterval: 60_000, keepPreviousData: true });
  const cap = useSWR<CapabilityView>("/api/capability", { refreshInterval: 60_000, keepPreviousData: true });
  const coverage = useSWR<Coverage>("/api/inventory/coverage", { refreshInterval: 60_000, keepPreviousData: true });
  const [vals, setVals] = useState<Partial<Record<Field, string>>>({});
  const [tab, setTab] = useState<Tab>("services");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  if (catalog.error) return <Empty title="Couldn't load the providers' permissions" hint={(catalog.error as Error).message} />;
  if (!catalog.data) return <div className="space-y-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}</div>;

  const providers = catalog.data.providers;
  const writeCap = catalog.data.writeCapability ?? {};
  const config = catalog.data.inventoryProviders;
  const status = new Map((inv.data?.providers ?? []).map((s) => [s.id, s]));
  const counts = new Map<string, Map<ResourceKind, number>>();
  for (const r of inv.data?.resources ?? []) {
    if (!counts.has(r.provider)) counts.set(r.provider, new Map());
    const m = counts.get(r.provider)!;
    m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
  }
  const defaults: Partial<Record<Field, string>> = { REGION: inv.data?.homeRegion ?? inv.data?.region, ACCOUNT_ID: inv.data?.accountId };
  const values = Object.fromEntries(FIELDS.map((k) => [k, vals[k] ?? defaults[k] ?? ""])) as Record<Field, string>;
  const setValue = (k: Field, v: string) => setVals((x) => ({ ...x, [k]: v.trim() }));
  const rank = (p: ProviderPermissions) => (p.planned ? PLANNED_RANK : STATE[status.get(p.id)?.state ?? "ok"].rank);
  const groups = CATEGORY_ORDER.map((c) => ({ c, list: providers.filter((p) => categoryOfProvider(p) === c).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)) })).filter((g) => g.list.length);
  const denied = providers.filter((p) => status.get(p.id)?.state === "denied").map((p) => p.id);
  const scopes = cloudflareScopes(providers.map((p) => ({ ...p, read: p.scopes.map((s) => `cloudflare:${s}`), sensitive: [], write: p.writeScopes.map((s) => `cloudflare:${s}`), implicit: [] })));
  const eks = providers.find((p) => p.kinds.includes("eks-cluster") || p.kinds.includes("eks-workload"));
  const multiRegion = (inv.data?.regions?.length ?? 1) > 1;

  // Organised in three tabs instead of one long page: the services (filterable), what the map knows, and the policy.
  const attention = (p: ProviderPermissions) => {
    const st = status.get(p.id)?.state;
    const w = writeCap[p.id]?.state;
    return !p.planned && (st === "denied" || st === "error" || w === "denied" || w === "probably-denied");
  };
  const FILTERS: Record<Filter, (p: ProviderPermissions) => boolean> = {
    all: () => true,
    attention,
    working: (p) => !p.planned && (status.get(p.id)?.state ?? "ok") === "ok" && runsByConfig(p.id, config),
    off: (p) => !p.planned && (status.get(p.id)?.state === "disabled" || status.get(p.id)?.state === "skipped" || !runsByConfig(p.id, config)),
    planned: (p) => !!p.planned,
  };
  const needle = query.trim().toLowerCase();
  const shown = (p: ProviderPermissions) => FILTERS[filter](p) && (!needle || `${p.label} ${p.id}`.toLowerCase().includes(needle));
  const visible = groups.map((g) => ({ ...g, list: g.list.filter(shown) })).filter((g) => g.list.length);
  const attentionCount = providers.filter(attention).length;

  return (
    <div className="space-y-6">
      <Summary providers={providers} status={status} inv={inv.data} invError={inv.error as Error | undefined} loading={inv.isLoading} cap={cap.data} capError={cap.error as Error | undefined} onBuild={() => setTab("policy")} />

      <Tabs<Tab>
        id="permissions"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "services", label: "Services", badge: attentionCount ? <Chip tone="bad">{attentionCount}</Chip> : undefined },
          { value: "coverage", label: "Coverage" },
          { value: "policy", label: "Policy builder" },
        ]}
      />

      {tab === "services" && (
        <section className="space-y-4" aria-label="What each service needs">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented<Filter>
              id="perm-filter"
              size="sm"
              value={filter}
              onChange={setFilter}
              options={(Object.keys(FILTER_LABEL) as Filter[]).map((f) => ({ value: f, label: <>{FILTER_LABEL[f]} <span className="text-fg-3 tabular-nums">{providers.filter(FILTERS[f]).length}</span></> }))}
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a service…"
              aria-label="Find a service"
              className="h-8 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14px] outline-none transition-colors placeholder:text-fg-3 focus:border-accent sm:ml-auto sm:w-56 pointer-coarse:h-10"
            />
          </div>
          {providers.length ? (
            visible.length ? (
              <div className="space-y-6">
                {visible.map((g) => (
                  <div key={g.c} className="space-y-2.5 [content-visibility:auto] [contain-intrinsic-size:auto_480px]" aria-labelledby={`grp-${g.c}`}>
                    <h3 id={`grp-${g.c}`} className="text-[15px] font-semibold text-fg">
                      {CATEGORY_LABEL[g.c]} <span className="font-normal text-fg-3">· {g.list.length}</span>
                    </h3>
                    <div className="stagger grid gap-3 xl:grid-cols-2">
                      {g.list.map((p) => (
                        <ProviderCard key={p.id} p={p} status={status.get(p.id)} counts={counts.get(p.id)} write={writeCap[p.id]} multiRegion={multiRegion} off={!runsByConfig(p.id, config)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-line bg-panel shadow-card">
                <Empty icon={<Check className="size-6" />} title={filter === "attention" && !needle ? "Nothing needs attention" : "No services match"} hint={needle ? `Nothing called "${query.trim()}" in this view.` : "Try another filter."} />
              </div>
            )
          ) : (
            <div className="rounded-2xl border border-line bg-panel shadow-card">
              <Empty icon={<Cloud className="size-6" />} title="No cloud-map providers in this build" hint="The policies in Policy builder still cover the ECS console itself." />
            </div>
          )}
        </section>
      )}

      {tab === "coverage" && <CoveragePanel data={coverage.data} error={coverage.error as Error | undefined} onRetry={() => void coverage.mutate()} />}

      {tab === "policy" && (
        <div className="space-y-6">
          <PolicyBuilder providers={providers} denied={denied} config={config} values={values} setValue={setValue} />
          {scopes.length > 0 && <CloudflareCard scopes={scopes} providers={providers.filter((p) => p.scopes.length + p.writeScopes.length)} status={status} />}
          {eks && <EksCard role={values.ROLE} account={values.ACCOUNT_ID} />}
        </div>
      )}

      <p className="text-[14px] leading-relaxed text-fg-3">
        Start read-only, then add write permissions one feature at a time.{" "}
        <Link href="/docs/permissions" className={cx("text-accent hover:underline", TAP)}>Permissions setup</Link> walks through it;{" "}
        <Link href="/docs/services" className={cx("text-accent hover:underline", TAP)}>Supported services</Link> lists what each service discovers and links;{" "}
        <Link href="/docs/actions" className={cx("text-accent hover:underline", TAP)}>Actions &amp; safety</Link> explains how changes are checked.
      </p>
    </div>
  );
}

// The Actions tile: every write the console and the map use (GET /api/capability covers both). "Read-only identity"
// when every ECS write is denied; "not verified" when nothing was simulated or observed for them.
function actionsTile(cap: CapabilityView | undefined): { value: string; tone?: "bad" | "warn"; hint: string } {
  if (!cap) return { value: "—", hint: "" };
  const states = Object.values(cap.actions);
  const allowed = states.filter((s) => s === "allowed").length;
  const unknown = states.filter((s) => s === "unknown").length;
  const bad = cap.denied.length;
  if (cap.readOnly) return { value: "Read-only identity", tone: "warn", hint: "The console's role can't change ECS services — buttons stay disabled with the reason" };
  if (cap.source === "none" || unknown === states.length || (!allowed && unknown + bad === states.length))
    return { value: bad ? `Not verified · ${num(bad)} denied` : "Not verified", tone: bad ? "warn" : undefined, hint: cap.note ?? "Nothing simulated yet — what AWS refuses is remembered" };
  return { value: `${num(allowed)} of ${num(states.length)} allowed`, tone: bad ? "warn" : undefined, hint: `IAM write actions the console and the map use${bad ? ` — ${num(bad)} denied or likely denied` : ""}${unknown ? `, ${num(unknown)} not verified` : ""}` };
}

function Summary({ providers, status, inv, invError, loading, cap, capError, onBuild }: {
  onBuild(): void;
  providers: ProviderPermissions[];
  status: Map<string, ProviderStatus>;
  inv?: InventoryView;
  invError?: Error;
  loading: boolean;
  cap?: CapabilityView;
  capError?: Error;
}) {
  const built = providers.filter((p) => !p.planned);
  const planned = providers.length - built.length;
  const n = (s: ProviderStatus["state"]) => built.filter((p) => status.get(p.id)?.state === s).length;
  const actions = actionsTile(cap);
  return (
    <section className="rounded-2xl border border-line bg-panel p-4 shadow-card" aria-label="Summary">
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 min-[480px]:grid-cols-2 lg:flex lg:flex-wrap lg:items-center">
        <Fact icon={ShieldCheck} label="Discovery: working" value={inv ? `${n("ok")} of ${built.length}` : "—"} />
        <Fact icon={ShieldAlert} label="Discovery: missing read permissions" value={inv ? String(n("denied")) : "—"} tone={inv && n("denied") ? "bad" : undefined} />
        <Fact icon={CircleSlash} label="Not set up" value={inv ? String(n("disabled")) : "—"} />
        {planned > 0 && <Fact icon={Hourglass} label="Coming soon" value={<span className="text-fg-3">{planned}</span>} />}
        <Fact icon={Zap} label="Actions" value={capError && !cap ? "—" : actions.value} tone={actions.tone} title={actions.hint} />
        <Fact icon={Cloud} label="Last discovery" value={inv ? <TimeAgo at={inv.generatedAt} /> : loading ? "…" : "—"} />
        <div className="flex items-center gap-3 lg:ml-auto">
          <button type="button" onClick={onBuild} className={cx("text-xs text-accent hover:underline", TAP)}>Build the policy</button>
          <Link href="/docs/permissions" className={cx("text-xs text-accent hover:underline", TAP)}>Setup guide</Link>
        </div>
      </div>
      {cap && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-fg-3">
          Actions: {cap.source === "simulated" ? <>IAM policy simulation{cap.checkedAt ? <>, <TimeAgo at={cap.checkedAt} /></> : null}</> : cap.source === "observed" ? "what recent calls to AWS showed" : "not verified yet"}
          {cap.note ? ` (${cap.note})` : ""}. The simulation can&apos;t see service control policies, resource policies or tag conditions — a refusal from AWS always wins, and is remembered for 10 minutes.
        </p>
      )}
      {invError && !inv && (
        <p className="mt-3 flex gap-2 rounded-xl border border-degraded/30 bg-degraded/8 p-3 text-xs leading-relaxed text-degraded">
          <AlertTriangle className="mt-px size-3.5 flex-none" />
          <span>Live status unavailable: {(invError as { status?: number }).status === 404 ? "this build has no inventory yet" : `the inventory didn't answer (${invError.message})`}. What each service needs and the policy builder below work without it.</span>
        </p>
      )}
    </section>
  );
}

function Fact({ icon: Icon, label, value, tone, title }: { icon: typeof Cloud; label: string; value: ReactNode; tone?: "bad" | "warn"; title?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5" title={title}>
      <div className="grid size-8 flex-none place-items-center rounded-lg border border-line bg-panel-2 text-fg-3"><Icon className="size-4" /></div>
      <div className="min-w-0 leading-tight">
        <div className="eyebrow">{label}</div>
        <div className={cx("text-[14px] tabular-nums", tone === "bad" && "text-down", tone === "warn" && "text-degraded")}>{value}</div>
        {title && <div className="sr-only">{title}</div>}
      </div>
    </div>
  );
}

// What the map knows and what it doesn't: GET /api/inventory/coverage.
function CoveragePanel({ data, error, onRetry }: { data?: Coverage; error?: Error; onRetry(): void }) {
  const [allRefs, setAllRefs] = useState(false);
  if (error && !data)
    return (
      <section className="space-y-2.5" aria-labelledby="coverage-title">
        <SectionTitle><span id="coverage-title">Coverage</span></SectionTitle>
        <p className="rounded-2xl border border-degraded/30 bg-degraded/8 p-3 text-xs text-degraded">Coverage unavailable: {error.message}</p>
      </section>
    );
  if (!data) return <Skeleton className="h-40 rounded-2xl" />;
  const c = data.completeness;
  const refs = allRefs ? data.unresolved : data.unresolved.slice(0, 8);
  const calls = [...data.awsCalls].sort((a, b) => b.requests - a.requests);
  return (
    <section className="space-y-2.5" aria-labelledby="coverage-title">
      <SectionTitle><span id="coverage-title">Coverage</span></SectionTitle>
      <div className="min-w-0 space-y-4 rounded-2xl border border-line bg-panel p-4 shadow-card">
        <FreshnessBanner f={data.freshness} onRetry={onRetry} />
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
          <Fact icon={Radar} label="Last complete scan" value={c.lastCompleteAt ? <TimeAgo at={c.lastCompleteAt} /> : "not yet"} tone={c.lastCompleteAt ? undefined : "warn"} />
          <Fact icon={Cloud} label="Regions" value={`${data.regions.join(", ")}${data.pendingRegions.length ? ` · reading ${data.pendingRegions.join(", ")}` : ""}`} />
          <Fact icon={ShieldAlert} label="Sources denied · failing" value={`${num(c.providers.denied)} · ${num(c.providers.error)}`} tone={c.providers.denied ? "bad" : c.providers.error ? "warn" : undefined} />
          <Fact
            icon={Activity}
            label="Activity metrics, last hour"
            value={`${num(data.activity.metricsLastHour)} of ${num(data.activity.budgetPerHour)} · ≈ $${data.activity.estMonthlyUsd.toFixed(2)}/month`}
            title="CloudWatch GetMetricData reads for idle marks, capped per hour (CONSOLE_ACTIVITY_BUDGET); $0.01 per 1,000 metrics"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <ChipList title="IAM actions AWS refused" items={c.deniedActions} tone="bad" empty="None" />
          <ChipList title="Capped — more exist than were listed" items={c.cappedTypes} tone="warn" empty="None" />
          <ChipList title="Shown from an older read" items={data.stale} tone="warn" empty="None" />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <div className="eyebrow mb-1">Pending deletion confirmation</div>
            {data.vanishing.length ? (
              <ul className="space-y-1">
                {data.vanishing.map((v) => (
                  <li key={v.key} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px]">
                    <Link href={`/map?r=${encodeURIComponent(v.key)}`} className={cx("min-w-0 truncate font-medium text-accent hover:underline", TAP)}>{v.name}</Link>
                    <span className="text-fg-3">{v.provider} · {v.region} · not seen since <TimeAgo at={v.lastSeen} /></span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-fg-3">None — every resource on the map was listed by its latest complete read.</p>
            )}
          </div>

          <div className="min-w-0">
            <div className="eyebrow mb-1">References nothing in this account or region answers to{data.unresolvedTotal > data.unresolved.length ? ` (first ${num(data.unresolved.length)} of ${num(data.unresolvedTotal)})` : ""}</div>
            {data.unresolved.length ? (
              <>
                <ul className="space-y-1">
                  {refs.map((u) => (
                    <li key={u.key} className="min-w-0 text-[13px]">
                      <span className="break-all font-mono text-[12.5px] text-fg-2">{u.ref}</span>
                      {(u.account || u.region) && <span className="text-fg-3"> · {[u.account && `account ${u.account}`, u.region].filter(Boolean).join(" · ")}</span>}
                    </li>
                  ))}
                </ul>
                {data.unresolved.length > refs.length && (
                  <button type="button" className={cx("mt-1 text-[12.5px] text-accent hover:underline", TAP)} onClick={() => setAllRefs(true)}>Show all {num(data.unresolved.length)}</button>
                )}
              </>
            ) : (
              <p className="text-[13px] text-fg-3">None.</p>
            )}
          </div>
        </div>

        {calls.length > 0 && (
          <details className="group rounded-xl border border-line bg-panel-2/50">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-medium text-fg-3 hover:text-fg-2 pointer-coarse:py-3 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform duration-200 group-open:rotate-90" aria-hidden />
              AWS calls since the console started <span className="font-normal">· {num(calls.reduce((a, x) => a + x.requests, 0))} requests, {num(calls.reduce((a, x) => a + x.throttled, 0))} throttled</span>
            </summary>
            <div className="max-h-80 overflow-auto px-3 pb-3">
              <table className="w-full min-w-[520px] text-left text-[13px] tabular-nums">
                <thead className="text-fg-3">
                  <tr>{["Service", "Region", "Requests", "Throttled", "Errors", "p95", "Now"].map((h) => <th key={h} scope="col" className="py-1.5 pr-3 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {calls.map((x) => (
                    <tr key={`${x.service}@${x.region}`} className="border-t border-line">
                      <td className="py-1.5 pr-3 font-mono">{x.service}</td>
                      <td className="py-1.5 pr-3">{x.region}</td>
                      <td className="py-1.5 pr-3">{num(x.requests)}</td>
                      <td className={cx("py-1.5 pr-3", x.throttled > 0 && "text-degraded")}>{num(x.throttled)}</td>
                      <td className={cx("py-1.5 pr-3", x.errors > 0 && "text-degraded")}>{num(x.errors)}</td>
                      <td className="py-1.5 pr-3">{num(Math.round(x.p95Ms))} ms</td>
                      <td className="py-1.5 pr-3 text-fg-3">{x.active ? `${x.active} running` : ""}{x.queued ? ` · ${x.queued} queued` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

function ChipList({ title, items, tone, empty }: { title: string; items: string[]; tone: "bad" | "warn"; empty: string }) {
  return (
    <div>
      <div className="eyebrow mb-1">{title}</div>
      {items.length ? <div className="flex flex-wrap gap-1">{items.map((a) => <Chip key={a} mono tone={tone}>{a}</Chip>)}</div> : <p className="text-[13px] text-fg-3">{empty}</p>}
    </div>
  );
}

function RegionRows({ regions }: { regions: RegionStatus[] }) {
  return (
    <ul className="mt-3 space-y-1" aria-label="By region">
      {regions.map((r) => (
        <li key={r.region} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px]">
          <span className="w-28 flex-none font-mono text-[12.5px] text-fg-2">{r.region}</span>
          <span className={cx(r.state === "denied" ? "text-down" : r.state === "error" || r.partial ? "text-degraded" : "text-fg-3")}>
            {STATE[r.state].label}{r.state === "ok" ? ` · ${num(r.count)}` : ""}{r.partial ? " · cut short" : ""}
          </span>
          {r.state !== "ok" && (r.missing?.length || r.error) ? <span className="min-w-0 basis-full truncate pl-[7.5rem] text-[12px] text-fg-3" title={r.missing?.join(", ") || r.error}>{r.missing?.join(", ") || r.error}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function ProviderCard({ p, status, counts, write, multiRegion, off }: { p: ProviderPermissions; status?: ProviderStatus; counts?: Map<ResourceKind, number>; write?: WriteCapability; multiRegion: boolean; off: boolean }) {
  const st = status ? STATE[status.state] : undefined;
  const kinds = [...new Set([...p.kinds, ...(counts?.keys() ?? [])])].filter((k) => KIND_INFO[k]);
  const why = p.planned ? undefined : status?.state === "disabled" ? status.error ?? (!p.enabled.ok ? p.enabled.why : undefined) : !status && !p.enabled.ok ? p.enabled.why : undefined;
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-line bg-panel p-4 shadow-card" aria-labelledby={`pv-${p.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`pv-${p.id}`} className="text-[15px] font-semibold leading-snug">{p.label}</h3>
          <div className="mt-0.5 font-mono text-[12.5px] text-fg-3">{p.id}{p.scope === "global" ? " · global" : p.scope === "home" ? " · home region" : ""}{off ? " · off in console.config.json" : ""}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {p.planned ? (
            <Chip tone="muted">Coming soon</Chip>
          ) : st ? (
            <Chip tone={st.tone}>
              {status!.state === "ok" ? <CircleCheck className="size-3" /> : status!.state === "denied" ? <ShieldAlert className="size-3" /> : null}
              {st.label}{status!.state === "ok" ? ` · ${status!.count.toLocaleString()}` : ""}
            </Chip>
          ) : (
            !p.enabled.ok && <Chip tone="muted">Not set up</Chip>
          )}
          {!p.planned && write && <Chip tone={CAP[write.state].tone}>{CAP[write.state].label}{write.state !== "unknown" ? ` · ${write.allowed}/${write.total}` : ""}</Chip>}
        </div>
      </div>

      {status?.state === "denied" && (
        <div className="mt-3 rounded-xl border border-down/25 bg-down/6 p-3">
          <div className="text-[13px] font-medium text-down">AWS refused {status.missing?.length === 1 ? "this action" : "these actions"} — add {status.missing?.length === 1 ? "it" : "them"} with the policy below:</div>
          <div className="mt-2 flex flex-wrap gap-1">{(status.missing?.length ? status.missing : ["(unknown action)"]).map((a) => <Chip key={a} mono tone="bad">{a}</Chip>)}</div>
        </div>
      )}
      {status?.state === "error" && status.error && <p className="mt-3 rounded-xl border border-degraded/25 bg-degraded/8 p-3 text-[13px] leading-relaxed text-degraded [overflow-wrap:anywhere]">{status.error}</p>}
      {write?.missing.length ? (
        <p className="mt-3 text-[13px] leading-relaxed text-fg-2">
          Its actions need {write.missing.map((a, i) => <span key={a}>{i ? ", " : ""}<code className="font-mono text-[12.5px]">{a}</code></span>)} — the map disables them until the full policy grants {write.missing.length === 1 ? "it" : "them"}.
        </p>
      ) : null}
      {why && <p className="mt-3 text-[13px] leading-relaxed text-fg-2">{why}</p>}
      {multiRegion && status?.regions && status.regions.length > 1 && <RegionRows regions={status.regions} />}
      {status?.notes?.length ? <ul className="mt-2 space-y-0.5 text-[12.5px] text-fg-3">{status.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}

      {kinds.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Discovers">
          {kinds.map((k) => {
            const Icon = KIND_ICON[k];
            const c = counts?.get(k);
            return <Chip key={k}>{Icon && <Icon className="size-3" />}{plural(KIND_INFO[k].label)}{c !== undefined ? ` · ${c.toLocaleString()}` : ""}</Chip>;
          })}
        </div>
      )}

      {!p.planned && (
        <div className="mt-auto pt-3">
          <details className="group rounded-xl border border-line bg-panel-2/50">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl px-3 py-2 text-[13px] font-medium text-fg-3 hover:text-fg-2 pointer-coarse:py-3 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform duration-200 group-open:rotate-90" aria-hidden />
              Needs
              <span className="font-normal">
                {[
                  (p.read.length || !p.scopes.length) && `${p.read.length} to discover`,
                  p.sensitive.length && `${p.sensitive.length} to read data`,
                  p.write.length && `${p.write.length} for actions`,
                  p.scopes.length + p.writeScopes.length && `${p.scopes.length + p.writeScopes.length} token scope${p.scopes.length + p.writeScopes.length > 1 ? "s" : ""}`,
                ].filter(Boolean).join(" · ")}
              </span>
            </summary>
            <div className="space-y-3 px-3 pb-3">
              <ActionList title="Discovery · both policies" actions={p.read} />
              <ActionList title="Data reads · full policy only" actions={p.sensitive} />
              <ActionList title="Actions · full policy only" actions={p.write} />
              <ActionList title="Authorised through other calls" actions={p.implicit} />
              <ActionList title="Cloudflare token · discovery" actions={p.scopes} />
              <ActionList title="Cloudflare token · actions" actions={p.writeScopes} />
              {p.actions.length > 0 && (
                <div>
                  <div className="eyebrow mb-1">What you can do from the map</div>
                  <ul className="space-y-1">
                    {p.actions.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center gap-1.5 text-[13px] text-fg-2">
                        {a.title}
                        {a.risk === "danger" && <Chip tone="bad">danger</Chip>}
                        <span className="text-[12px] text-fg-3">· {KIND_INFO[a.kind as ResourceKind]?.label ?? a.kind}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        </div>
      )}
    </article>
  );
}

function ActionList({ title, actions }: { title: string; actions: string[] }) {
  if (!actions.length) return null;
  return (
    <div>
      <div className="eyebrow mb-1">{title}</div>
      <div className="flex flex-wrap gap-1">{actions.map((a) => <Chip key={a} mono>{a}</Chip>)}</div>
    </div>
  );
}

type Field = Placeholder | "ROLE";
const FIELDS: Field[] = ["ROLE", "ACCOUNT_ID", "REGION", "CONSOLE_CLUSTER", "CONSOLE_SERVICE", "ENV_FILES_BUCKET", "CONSOLE_PARAM_PREFIX", "CONSOLE_SECRET_PREFIX", "CONSOLE_ENV_FILE"];
const FIELD_INFO: Record<Field, { label: string; placeholder: string; hint: string }> = {
  ROLE: { label: "Console's role", placeholder: "deployment-console-task", hint: "The role the console runs as: its ECS task role, or the role behind its AWS profile." },
  ACCOUNT_ID: { label: "Account id", placeholder: "123456789012", hint: "12 digits." },
  REGION: { label: "Region", placeholder: "eu-west-1", hint: "The region the console discovers." },
  CONSOLE_CLUSTER: { label: "Console's cluster", placeholder: "tools", hint: "Where the console itself runs, so it can never act on itself. Not on ECS here? Leave it." },
  CONSOLE_SERVICE: { label: "Console's service", placeholder: "deployment-console", hint: "The console's own ECS service." },
  ENV_FILES_BUCKET: { label: "Env files bucket", placeholder: "acme-env-files", hint: "The S3 bucket with your services' env files. None? Delete the EnvironmentFiles statement." },
  CONSOLE_PARAM_PREFIX: { label: "Console's parameter path", placeholder: "deployment-console", hint: "Where the console's own settings live in Parameter Store, without the leading slash. The console may never read or overwrite them." },
  CONSOLE_SECRET_PREFIX: { label: "Console's secret prefix", placeholder: "deployment-console/", hint: "How the names of the console's own Secrets Manager secrets start. The console may never read or overwrite them." },
  CONSOLE_ENV_FILE: { label: "Console's env file", placeholder: "deployment-console/production.env", hint: "Its own env file's key in the env files bucket (* matches several). None? Delete the NeverReadOrWriteTheConsolesOwnEnvFile statement." },
};

function PolicyBuilder({ providers, denied, config, values, setValue }: {
  providers: ProviderPermissions[];
  denied: string[];
  config?: Catalog["inventoryProviders"];
  values: Record<Field, string>;
  setValue(k: Field, v: string): void;
}) {
  const iam = useMemo(() => providers.filter((p) => p.read.length + p.sensitive.length + p.write.length + p.implicit.length > 0), [providers]);
  // Starts from what this console runs: console.config.json inventory.providers when it says, else every provider.
  const configured = !!(config?.include || config?.exclude?.length);
  const mine = useMemo(() => iam.filter((p) => runsByConfig(p.id, config)).map((p) => p.id), [iam, config]);
  const [mode, setMode] = useState<PolicyMode>("read");
  const [picked, setPicked] = useState<string[] | null>(null); // null = the providers this console runs
  const [tab, setTab] = useState<"json" | "cli">("json");
  const [part, setPart] = useState(0);
  const chosen = picked ?? mine;
  const { data, error } = useSWR<PolicyResponse>(`/api/permissions/policy?mode=${mode}&providers=${[...chosen].sort().join(",")}`, { keepPreviousData: true });

  // Filled, split and turned into commands here: small documents, and nothing typed leaves the browser.
  const out = (() => {
    if (!data) return null;
    const { ROLE, ...ph } = values;
    const filled0 = fillPlaceholders(data.policy, ph);
    // SimulateOwnPermissions names the console's own role: the one typed here, not the default deployment-console-task.
    const filled = validPlaceholder("ACCOUNT_ID", values.ACCOUNT_ID) && validRoleName(ROLE) ? withPrincipal(filled0, `arn:aws:iam::${values.ACCOUNT_ID}:role/${ROLE}`) : filled0;
    const parts = splitPolicy(filled);
    return {
      fields: placeholdersIn(data.policy),
      left: placeholdersIn(filled),
      size: policySize(filled),
      parts,
      cli: cliScript({ parts, mode: data.mode, role: ROLE, accountId: values.ACCOUNT_ID }),
    };
  })();
  const toggle = (id: string) => setPicked((cur) => {
    const base = cur ?? mine;
    return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
  });
  const shownPart = out ? Math.min(part, out.parts.length - 1) : 0;
  const json = out ? JSON.stringify(out.parts[shownPart], null, 2) : "";

  return (
    <section id="policy" className="scroll-mt-20 space-y-2.5" aria-labelledby="policy-title">
      <SectionTitle><span id="policy-title">Policy builder</span></SectionTitle>
      <div className="min-w-0 space-y-4 rounded-2xl border border-line bg-panel p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented id="perm-mode" value={mode} onChange={setMode} options={[{ value: "read", label: "Read-only (map only)" }, { value: "full", label: "Full (map + actions)" }]} />
          <p className="min-w-0 flex-1 basis-64 text-[13px] leading-relaxed text-fg-3">
            {mode === "read"
              ? "The console can list and describe everything, and change nothing. No object contents, message bodies or secret values."
              : "Adds data reads and what each action needs, plus the ECS console's own write statements with their conditions and self-protection denies."}
          </p>
        </div>

        {iam.length > 0 && (
          <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-[13px] font-medium text-fg-2">Services ({chosen.length} of {iam.length})</span>
              {configured && <button type="button" className={cx("text-[12.5px] text-accent hover:underline", TAP)} onClick={() => setPicked(null)}>This console&apos;s (console.config.json)</button>}
              <button type="button" className={cx("text-[12.5px] text-accent hover:underline", TAP)} onClick={() => setPicked(iam.map((p) => p.id))}>All</button>
              <button type="button" className={cx("text-[12.5px] text-accent hover:underline", TAP)} onClick={() => setPicked([])}>None</button>
              {denied.length > 0 && <button type="button" className={cx("text-[12.5px] text-accent hover:underline", TAP)} onClick={() => setPicked(denied)}>Only what&apos;s missing</button>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {iam.map((p) => {
                const on = chosen.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(p.id)}
                    className={cx(
                      "press inline-flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[13px] transition-colors pointer-coarse:h-9",
                      on ? "border-accent/40 bg-accent-soft text-fg" : "border-line bg-panel text-fg-3 hover:text-fg-2",
                      denied.includes(p.id) && !on && "border-down/40",
                    )}
                  >
                    {on ? <Check className="size-3" /> : <span className="size-3" />} {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(["ROLE", "ACCOUNT_ID", "REGION", ...(out?.fields ?? []).filter((f) => f !== "ACCOUNT_ID" && f !== "REGION")] as const).map((k) => {
            const v = values[k];
            const bad = !!v && !(k === "ROLE" ? validRoleName(v) : validPlaceholder(k, v));
            return (
              <label key={k} className="block min-w-0">
                <span className="mb-1 block text-[13px] font-medium text-fg-2">{FIELD_INFO[k].label}</span>
                <input value={v} placeholder={FIELD_INFO[k].placeholder} spellCheck={false} autoComplete="off" aria-invalid={bad} onChange={(e) => setValue(k, e.target.value)} className={cx(inputCls, bad ? "border-down/60" : "border-line")} />
                <span className={cx("mt-1 block text-[12px] leading-snug", bad ? "text-down" : "text-fg-3")}>{bad ? `Not a valid ${FIELD_INFO[k].label.toLowerCase()} — left as a placeholder.` : FIELD_INFO[k].hint}</span>
              </label>
            );
          })}
        </div>

        {error && <p className="text-[13px] text-down">Couldn&apos;t build the policy: {(error as Error).message}</p>}
        {!out ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : (
          <div className="min-w-0 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-3">
              <span className="tabular-nums">{out.size.toLocaleString()} characters</span>
              {out.parts.length > 1 ? (
                <Chip tone="warn">Split into {out.parts.length} policies — AWS allows {MANAGED_POLICY_LIMIT.toLocaleString()} characters each; attach all of them</Chip>
              ) : (
                <span>· fits one managed policy ({MANAGED_POLICY_LIMIT.toLocaleString()} max)</span>
              )}
              {out.left.length > 0 && <Chip tone="warn">Replace before creating: {out.left.join(", ")}</Chip>}
            </div>
            {data?.skipped.length ? (
              <ul className="space-y-1 rounded-xl border border-degraded/30 bg-degraded/8 p-3 text-[13px] text-degraded">
                {data.skipped.map((s) => <li key={`${s.provider}:${s.action}`} className="flex gap-2"><AlertTriangle className="mt-px size-3.5 flex-none" /><span><b className="font-mono font-medium">{s.action}</b> ({s.provider}) isn&apos;t included: {s.why}</span></li>)}
              </ul>
            ) : null}
            <Tabs id="perm-out" value={tab} onChange={setTab} tabs={[{ value: "json", label: "Policy JSON" }, { value: "cli", label: "AWS CLI" }]} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              {tab === "json" && out.parts.length > 1 ? (
                <Segmented id="perm-part" size="sm" value={String(shownPart)} onChange={(v) => setPart(Number(v))} options={out.parts.map((_, i) => ({ value: String(i), label: `Part ${i + 1}` }))} />
              ) : (
                <span className="min-w-0 text-[13px] text-fg-3">
                  {tab === "json" ? <>Save as <code className="font-mono">{policyName(mode, shownPart, out.parts.length)}.json</code>, or create it in the IAM console.</> : "Creates the policy and attaches it to the console's role. Run it with credentials that may manage IAM."}
                </span>
              )}
              <CopyButton text={tab === "json" ? json : out.cli} label={tab === "json" ? "Copy JSON" : "Copy commands"} />
            </div>
            <pre className="max-h-[28rem] min-w-0 overflow-auto rounded-xl border border-line bg-panel-2 p-3 font-mono text-[12.5px] leading-relaxed text-fg-2">{tab === "json" ? json : out.cli}</pre>
            <p className="text-[12.5px] leading-relaxed text-fg-3">
              Already have the console&apos;s policy? Replace it (IAM keeps up to five versions) rather than attaching a second copy. The same policy is in the repository as{" "}
              <code className="font-mono">{mode === "read" ? "infra/iam-policy-readonly.json" : "infra/iam-policy.json"}</code> (every service); <code className="font-mono">npm run iam:policy</code> regenerates it.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function CloudflareCard({ scopes, providers, status }: { scopes: { scope: string; providers: string[]; write: boolean }[]; providers: ProviderPermissions[]; status: Map<string, ProviderStatus> }) {
  const reads = scopes.filter((s) => !s.write), writes = scopes.filter((s) => s.write);
  const off = providers.map((p) => (status.get(p.id)?.state === "disabled" ? status.get(p.id)?.error : undefined) ?? (!p.enabled.ok ? p.enabled.why : undefined)).find(Boolean);
  return (
    <section className="space-y-2.5" aria-labelledby="cf-title">
      <SectionTitle><span id="cf-title">Cloudflare</span></SectionTitle>
      <div className="space-y-3 rounded-2xl border border-line bg-panel p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <KeyRound className="size-4 text-fg-3" />
          <span className="text-[14px] font-medium">An API token, not IAM</span>
          {off ? <Chip tone="muted">Not set up</Chip> : <Chip tone="ok"><CircleCheck className="size-3" /> Token set</Chip>}
        </div>
        <p className="text-[13.5px] leading-relaxed text-fg-2">
          In the Cloudflare dashboard: My Profile → API Tokens → Create Token → Custom token, limited to the zones you want on the map. For the map (read-only):
        </p>
        <div className="flex flex-wrap gap-1.5">{reads.map((s) => <Chip key={s.scope} mono>{s.scope}</Chip>)}</div>
        {writes.length > 0 && (
          <>
            <p className="text-[13.5px] leading-relaxed text-fg-2">Only if you want its actions from the map (they change things at Cloudflare):</p>
            <div className="flex flex-wrap gap-1.5">{writes.map((s) => <Chip key={s.scope} mono tone="warn">{s.scope}</Chip>)}</div>
          </>
        )}
        <p className="text-[13.5px] leading-relaxed text-fg-2">
          Then set <code className="font-mono text-[13px]">CLOUDFLARE_API_TOKEN</code> (and optionally <code className="font-mono text-[13px]">CLOUDFLARE_ACCOUNT_ID</code>) in the console&apos;s environment — <code className="font-mono text-[13px]">.env.local</code> on your machine, a Secrets Manager secret in the task definition on ECS — and restart it.
          {off && <span className="text-fg-3"> Now: {off}</span>}
        </p>
      </div>
    </section>
  );
}

function EksCard({ role, account }: { role: string; account: string }) {
  const arn = `arn:aws:iam::${/^\d{12}$/.test(account) ? account : "ACCOUNT_ID"}:role/${role && validRoleName(role) ? role : "ROLE_NAME"}`;
  const cmds = [
    "CLUSTER=my-cluster   # repeat for each cluster",
    `ROLE_ARN=${arn}`,
    "# Needs the cluster's authentication mode to allow access entries (API or API_AND_CONFIG_MAP):",
    '#   aws eks update-cluster-config --name "$CLUSTER" --access-config authenticationMode=API_AND_CONFIG_MAP',
    'aws eks create-access-entry --cluster-name "$CLUSTER" --principal-arn "$ROLE_ARN"',
    "# See workloads (read-only):",
    'aws eks associate-access-policy --cluster-name "$CLUSTER" --principal-arn "$ROLE_ARN" \\',
    "  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy --access-scope type=cluster",
    "# Restart and scale workloads too, in the namespaces you choose:",
    'aws eks associate-access-policy --cluster-name "$CLUSTER" --principal-arn "$ROLE_ARN" \\',
    "  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy --access-scope type=namespace,namespaces=default",
  ].join("\n") + "\n";
  return (
    <section className="space-y-2.5" aria-labelledby="eks-title">
      <SectionTitle><span id="eks-title">Kubernetes workloads (EKS)</span></SectionTitle>
      <div className="min-w-0 space-y-3 rounded-2xl border border-line bg-panel p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <Ship className="size-4 text-fg-3" />
          <span className="text-[14px] font-medium">IAM finds the clusters; each cluster lets the console in</span>
        </div>
        <p className="text-[13.5px] leading-relaxed text-fg-2">
          The policy above lists clusters and node groups. To show the Deployments and StatefulSets inside a cluster, give the console&apos;s role an access entry there. View access is enough for the map; restart and scale need edit access.
        </p>
        <div className="flex items-center justify-end"><CopyButton text={cmds} label="Copy commands" /></div>
        <pre className="max-h-72 min-w-0 overflow-auto rounded-xl border border-line bg-panel-2 p-3 font-mono text-[12.5px] leading-relaxed text-fg-2">{cmds}</pre>
      </div>
    </section>
  );
}

