"use client";
// Costs & usage: actual spend from Cost Explorer (a cached snapshot) beside a free list-price estimate of what runs.
// Operators and admins only (`costs`); everyone else gets a polite explanation instead of numbers (the API says 403).
// The estimate never depends on Cost Explorer, so it still renders when spend is unavailable.
import { Activity, Box, CircleDollarSign, Database, HardDrive, Layers, Lock, RefreshCw, ShieldAlert, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { FreshnessBanner } from "@/components/freshness-banner";
import { Swap } from "@/components/motion";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, Skeleton, TimeAgo, cx, useNow } from "@/components/ui";
import { ROLE_INFO, useMe } from "@/components/user-menu";
import { ApiError, postJson } from "@/lib/client/api";
import { loadedAt, trackedJson } from "@/lib/client/env";
import { keptFreshness, stamp } from "@/lib/client/format";
import { useRegions } from "@/lib/client/region";
import { usd, type RunItem } from "@/lib/costs";
import { roleFor } from "@/lib/rbac";
import type { CostsView, EcsServiceSpend, RunRateEnv, SpendUnavailable, SpendView } from "@/lib/spend";
import { DataTable, type Column } from "../_components/data-table";
import { Page, PageHeader, SectionTitle } from "../_components/page-frame";
import { BarList, Callout, Card, CardTitle, DailyBars, Stat, fmtDay, fmtMonth, fmtPct } from "./parts";

export default function CostsPage() {
  const { data, error, isLoading, mutate } = useSWR<CostsView>("/api/costs", trackedJson, { refreshInterval: 5 * 60_000, keepPreviousData: true, revalidateOnFocus: false });
  const denied = error instanceof ApiError && error.status === 403;
  const multi = useRegions().multi;
  const kept = denied ? undefined : keptFreshness({ data, error, loadedAt: loadedAt("/api/costs"), source: "costs", staleAfterMs: 15 * 60_000 });
  return (
    <Page width="wide">
      <PageHeader
        title="Costs"
        description={
          <>
            What AWS charges, from Cost Explorer, and what runs right now priced at list — side by side.
            {multi && <span className="mt-1.5 block"><Chip tone="muted">account-wide (Cost Explorer) — not filtered by region</Chip></span>}
          </>
        }
        actions={data && <Freshness data={data} onRefreshed={(v) => mutate(v, { revalidate: false })} />}
      />
      <FreshnessBanner f={kept} onRetry={() => void mutate()} />
      {denied ? (
        <NeedsRole />
      ) : error && !data ? (
        <Empty title="Could not load costs" hint={(error as Error).message} />
      ) : (
        <Swap id={isLoading && !data ? "loading" : "data"}>
          {!data ? <Loading /> : (
            <div className="space-y-8">
              {data.actual.status === "ok" ? <Actual v={data.actual} /> : <ActualUnavailable v={data.actual} />}
              <Estimate data={data} />
            </div>
          )}
        </Swap>
      )}
    </Page>
  );
}

function NeedsRole() {
  const me = useMe().data;
  return (
    <div className="rounded-2xl border border-line bg-panel shadow-card">
      <Empty
        icon={<Lock className="size-5" />}
        title={`Costs need the ${roleFor("costs")} role`}
        hint={<>Spend, forecasts and estimates are visible to operators and admins.{me && <> You&apos;re signed in as {ROLE_INFO[me.user.role].label.toLowerCase()}; an admin can change that under Settings → Users &amp; roles.</>}</>}
      />
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)}</div>
      <Skeleton className="h-64 rounded-2xl" />
      <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-72 rounded-2xl" /><Skeleton className="h-72 rounded-2xl" /></div>
    </div>
  );
}

// "as of 2h ago" + Refresh. Refresh spends real money, so it says so and waits out the global 5-minute gap.
function Freshness({ data, onRefreshed }: { data: CostsView; onRefreshed(v: CostsView): void }) {
  const now = useNow();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const a = data.actual;
  const wait = now ? data.refresh.allowedAt - now : 0;
  const cost = `${data.refresh.requestsPerSnapshot} Cost Explorer requests, about $${(data.refresh.requestsPerSnapshot * 0.01).toFixed(2)}`;
  async function refresh() {
    setBusy(true);
    try {
      const v = await postJson<CostsView>("/api/costs/refresh", {});
      onRefreshed(v);
      if (v.actual.status === "ok" && !v.actual.warning) toast.push({ tone: "ok", title: "Spend refreshed", body: `New snapshot from Cost Explorer (${v.actual.requests} requests).` });
      else toast.push({ tone: "error", title: "Cost Explorer didn't answer", body: v.actual.status === "ok" ? v.actual.warning : v.actual.reason }, 8000);
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't refresh", body: (e as Error).message }, 8000);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:w-auto sm:justify-end">
      <span className="text-xs text-fg-3">
        {a.status === "ok" ? <>as of <span title={stamp(a.fetchedAt)}><TimeAgo at={a.fetchedAt} /></span> · kept {data.refresh.cacheHours} h</> : "Cost Explorer unavailable"}
        {a.source === "mock" && <> · <Chip tone="muted">simulated</Chip></>}
      </span>
      <Button onClick={refresh} disabled={busy || wait > 0} title={wait > 0 ? `Available in ${Math.ceil(wait / 60_000)} min — one refresh per 5 minutes (each is billed: ${cost})` : `Take a new snapshot now: ${cost}`}>
        <RefreshCw className={cx("size-3.5", busy && "animate-spin")} /> Refresh
      </Button>
    </div>
  );
}

const UNAVAILABLE_TITLE: Record<SpendUnavailable["code"], string> = {
  "not-enabled": "Cost Explorer isn't enabled for this account",
  denied: "The console isn't allowed to read Cost Explorer",
  throttled: "Cost Explorer is throttling requests",
  error: "Couldn't read Cost Explorer",
};

function ActualUnavailable({ v }: { v: SpendUnavailable }) {
  return (
    <section className="space-y-3">
      <SectionTitle>Actual spend</SectionTitle>
      <Callout title={UNAVAILABLE_TITLE[v.code]} reason={v.reason} steps={v.fix} tone={v.code === "error" ? "bad" : "warn"} />
      <p className="text-xs text-fg-3">The estimate below doesn&apos;t need Cost Explorer. The console tries again when the page is opened after 15 minutes, or at once with Refresh.</p>
    </section>
  );
}

function Actual({ v }: { v: SpendView }) {
  const sp = v.samePoint;
  const lastMonthName = fmtMonth(v.lastMonthStart);
  const openAnomaly = v.anomalies.status === "ok" ? v.anomalies.items.filter((a) => a.open && a.start).map((a) => a.start!).sort()[0] : undefined;
  const mtdTotal = v.monthToDate || 1;
  return (
    <section className="space-y-4">
      {v.warning && <Callout title="Showing the previous snapshot" reason={v.warning} tone="muted" docs={false} />}
      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat i={0} label="Month to date" value={usd(v.monthToDate)} sub={<>{fmtDay(v.month)} – {fmtDay(v.today)}, today so far{v.estimated ? " · estimated" : ""}</>} />
        <Stat
          i={1}
          label="Forecast · month end"
          value={v.forecast ? usd(v.forecast.monthEnd) : "—"}
          sub={v.forecast ? (
            <span title={v.forecast.note}>
              {v.forecast.method === "aws" ? "AWS forecast" : "from the 7-day average"}
              {v.forecast.runRate !== undefined && <> · last 7 days point to {usd(v.forecast.runRate)}</>}
            </span>
          ) : "not enough data yet"}
        />
        <Stat i={2} label="Last month" value={usd(v.lastMonth)} sub={`${lastMonthName}, full month`} />
        <Stat
          i={3}
          label={`vs same point in ${lastMonthName}`}
          value={sp?.changePct !== null && sp?.changePct !== undefined ? fmtPct(sp.changePct) : "—"}
          tone={sp?.changePct ? (sp.changePct > 5 ? "warn" : sp.changePct < -5 ? "ok" : undefined) : undefined}
          sub={sp ? `${usd(sp.thisMonth)} vs ${usd(sp.lastMonth)} over ${sp.days} full day${sp.days === 1 ? "" : "s"}` : "from the 2nd of the month"}
        />
      </div>

      <Card i={1}>
        <DailyBars days={v.daily} anomalyFrom={openAnomaly} />
      </Card>

      <div className="stagger grid gap-4 lg:grid-cols-2">
        <Card i={2}>
          <CardTitle aside={`month to date · ${lastMonthName} for comparison`}>By AWS service</CardTitle>
          {v.services.length ? (
            <BarList
              label="Spend by AWS service"
              rows={v.services.map((s) => ({
                key: s.service, label: s.label, amount: s.amount, title: s.service,
                sub: <>{Math.round((s.amount / mtdTotal) * 100)}%<span className="max-sm:hidden"> · {lastMonthName.slice(0, 3)} {usd(s.lastMonth)}</span></>,
              }))}
            />
          ) : <Empty title="No spend recorded this month yet" />}
        </Card>
        <Card i={3}>
          <CardTitle aside={<span className="font-mono">{v.envs.tagKey}</span>}>By environment</CardTitle>
          <EnvBreakdownView v={v} />
        </Card>
      </div>

      <Card i={4} flush>
        <div className="px-4 pt-4 sm:px-5 sm:pt-5"><CardTitle aside="month to date · split cost allocation data">By ECS service</CardTitle></div>
        <EcsServices v={v} />
      </Card>

      <ExtraUsage v={v} />
    </section>
  );
}

function EnvBreakdownView({ v }: { v: SpendView }) {
  const e = v.envs;
  if (e.status === "unavailable") return <Callout title="Couldn't split spend by environment" reason={e.reason} steps={e.fix} />;
  if (e.status === "no-data")
    return <Callout title={`No spend carries the ${e.tagKey} tag yet`} steps={e.fix} />;
  const total = e.rows.reduce((a, r) => a + r.amount, 0) + e.untagged;
  return (
    <BarList
      label="Spend by environment"
      rows={[
        ...e.rows.map((r) => ({
          key: r.key,
          label: <span className="inline-flex min-w-0 items-center gap-1.5">{r.protected && <ShieldAlert className="size-3.5 flex-none text-down" aria-label="protected" />}<span className="truncate">{r.label}</span>{!r.env && <Chip tone="muted">not discovered</Chip>}</span>,
          amount: r.amount,
          sub: `${Math.round((r.amount / (total || 1)) * 100)}%`,
        })),
        ...(e.untagged ? [{ key: "__untagged", label: "Shared & untagged — RDS, NAT, load balancers, …", amount: e.untagged, muted: true, sub: `${Math.round((e.untagged / (total || 1)) * 100)}%` }] : []),
      ]}
    />
  );
}

function EcsServices({ v }: { v: SpendView }) {
  const e = v.ecsServices;
  const envProtected = useMemo(() => new Map(v.envs.rows.map((r) => [r.env, !!r.protected])), [v.envs.rows]);
  const max = Math.max(...e.rows.map((r) => r.amount), 0.01);
  const columns = useMemo<Column<EcsServiceSpend>[]>(
    () => [
      { key: "name", header: "Service", slot: "title", cell: (r) => <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5"><span className="truncate font-medium">{r.name}</span>{r.name !== r.service && <span className="truncate font-mono text-[12px] text-fg-3">{r.service}</span>}</span> },
      { key: "env", header: "Environment", slot: "meta", cell: (r) => <Chip tone={r.env && envProtected.get(r.env) ? "bad" : "muted"}>{r.envLabel}</Chip> },
      {
        key: "bar", header: "Share", slot: "line", className: "@min-2xl:w-2/5",
        cell: (r) => <div className="h-1.5 overflow-hidden rounded-full bg-panel-3" aria-hidden><div className="h-full origin-left rounded-full bg-accent/60" style={{ transform: `scaleX(${Math.max(0, r.amount) / max})` }} /></div>,
      },
      { key: "amount", header: <span className="block text-right">Month to date</span>, slot: "end", className: "whitespace-nowrap font-medium tabular-nums @min-2xl:text-right", cell: (r) => usd(r.amount) },
    ],
    [envProtected, max],
  );
  if (e.status !== "ok")
    return <div className="px-4 pb-4 sm:px-5 sm:pb-5"><Callout title={e.status === "unavailable" ? "Couldn't split spend by ECS service" : "No spend carries the aws:ecs:serviceName tag yet"} reason={e.reason} steps={e.fix} /></div>;
  return <DataTable label="Spend by ECS service" rows={e.rows} rowKey={(r) => `${r.envLabel}/${r.service}`} columns={columns} />;
}

function ExtraUsage({ v }: { v: SpendView }) {
  const a = v.anomalies;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card i={5}>
        <CardTitle aside="AWS Cost Anomaly Detection · last 30 days">Anomalies</CardTitle>
        {a.status === "unavailable" ? (
          <Callout title="Couldn't read cost anomalies" reason={a.reason} steps={a.fix} />
        ) : a.items.length === 0 ? (
          <Empty icon={<Activity className="size-5" />} title="No anomalies in the last 30 days" hint="AWS only reports on the monitors you've created — Billing and Cost Management → Cost Anomaly Detection (free)." />
        ) : (
          <ul className="divide-y divide-line">
            {a.items.map((x) => (
              <li key={x.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span className={cx("mt-0.5 grid size-7 flex-none place-items-center rounded-lg", x.open ? "bg-degraded/10 text-degraded" : "bg-panel-2 text-fg-3")}><Activity className="size-3.5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-[14px] font-medium">{x.label}</span>
                    <span className="text-[14px] font-medium tabular-nums text-degraded">+{usd(x.impact)}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-fg-3">
                    {x.start ? <>since {fmtDay(x.start)}</> : null}{x.end ? <> – {fmtDay(x.end)}</> : null}
                    {x.open && <> · <span className="text-degraded">ongoing</span></>}
                    {x.pct !== undefined && <> · {fmtPct(x.pct)} over expected</>}
                    {x.region && <> · {x.region}</>}
                  </div>
                  {x.usageType && <div className="mt-1 truncate font-mono text-[12px] text-fg-3" title={x.usageType}>{x.usageType}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card i={6}>
        <CardTitle aside={`last 7 days vs the 21 before · over ${v.spikePercent}% and $1/day`}>Spikes</CardTitle>
        {v.spikes.length === 0 ? (
          <Empty icon={<TrendingUp className="size-5" />} title="No service is spending noticeably more" hint={`Checked every AWS service's daily spend against its previous three weeks.`} />
        ) : (
          <ul className="divide-y divide-line">
            {v.spikes.map((s) => (
              <li key={s.service} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span className="mt-0.5 grid size-7 flex-none place-items-center rounded-lg bg-degraded/10 text-degraded"><TrendingUp className="size-3.5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-[14px] font-medium" title={s.service}>{s.label}</span>
                    <span className="text-[14px] font-medium tabular-nums text-degraded">{s.changePct === null ? "new" : fmtPct(s.changePct)}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-fg-3">
                    {usd(s.recentDaily)}/day, was {usd(s.baselineDaily)}/day · about +{usd(s.extraMonthly)} a month at this rate
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------- estimate ----------

const KIND_ICON: Record<RunItem["kind"], typeof Box> = { service: Layers, host: HardDrive, database: Database, cache: Box };
const KIND_LABEL: Record<RunItem["kind"], string> = { service: "service", host: "EC2 host", database: "RDS", cache: "ElastiCache" };

const itemColumns: Column<RunItem>[] = [
  {
    key: "name", header: "Resource", slot: "title",
    cell: (i) => {
      const Icon = KIND_ICON[i.kind];
      return <span className="inline-flex min-w-0 items-center gap-2"><Icon className="size-3.5 flex-none text-fg-3" aria-label={KIND_LABEL[i.kind]} /><span className="truncate">{i.name}</span></span>;
    },
  },
  { key: "detail", header: "What runs", slot: "line", className: "text-fg-2 @max-2xl:text-xs", cell: (i) => i.detail },
  { key: "note", header: "Note", slot: "meta", className: "text-xs text-fg-3", cell: (i) => i.note },
  {
    key: "monthly", header: <span className="block text-right">Per month</span>, slot: "end", className: "whitespace-nowrap tabular-nums @min-2xl:text-right",
    cell: (i) => (i.monthly === null ? <span className="text-fg-3">{i.note?.startsWith("counted") ? "on host" : "no list price"}</span> : <span className={cx(i.monthly === 0 && "text-fg-3")}>{usd(i.monthly)}</span>),
  },
];

function Estimate({ data }: { data: CostsView }) {
  const e = data.estimate;
  const actual = data.actual.status === "ok" ? data.actual : undefined;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <SectionTitle className="inline-flex items-center gap-1.5"><CircleDollarSign className="size-3.5" /> Estimated monthly run rate</SectionTitle>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-fg-3">
            What runs right now × {e.customRates ? "your rates from console.config.json" : "us-east-1 on-demand list prices"}, for 730 hours. An estimate at list price: excludes data transfer, storage, load balancers, NAT, Spot and Savings Plans, so it won&apos;t match the bill
            {actual?.forecast ? <> (AWS forecasts {usd(actual.forecast.monthEnd)} for this month).</> : "."}
          </p>
        </div>
        <div className="sm:text-right">
          <div className="font-display text-[32px] leading-none tabular-nums">{usd(e.monthly)}</div>
          <div className="mt-1 text-[12px] text-fg-3">per month · free, no Cost Explorer</div>
        </div>
      </div>
      {e.errors.length > 0 && <Callout title="Discovery had errors — the estimate may be incomplete" reason={e.errors.join(" · ")} tone="muted" docs={false} />}
      {e.envs.length === 0 && <Empty title="Nothing discovered yet" hint="Environments appear once discovery has found your ECS clusters (Settings → Environments)." />}
      {/* One column: each environment gets a full-width table on desktop, cards on phones. */}
      <div className="space-y-4">
        {e.envs.map((env, i) => <EnvEstimate key={env.env || "__none"} env={env} i={i} />)}
      </div>
      <p className="text-[12px] text-fg-3">
        Services on EC2 hosts show <i>on host</i>: their cost is the instance&apos;s. Rates and a regional multiplier can be set in console.config.json → <span className="font-mono">pricing</span>. <Link href="/docs/costs" className="text-accent hover:underline">How this is calculated</Link>
      </p>
    </section>
  );
}

function EnvEstimate({ env, i }: { env: RunRateEnv; i: number }) {
  return (
    <Card i={i} flush>
      <div className="flex items-baseline justify-between gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
        <div className="inline-flex min-w-0 items-center gap-2">
          {env.protected && <ShieldAlert className="size-3.5 flex-none text-down" aria-label="protected" />}
          <span className="truncate text-[16px] font-semibold">{env.label}</span>
        </div>
        <span className="flex-none font-display text-[24px] leading-none tabular-nums">{usd(env.monthly)}<span className="ml-1 font-sans text-[12px] text-fg-3">/mo</span></span>
      </div>
      {env.unpriced.length > 0 && <div className="px-4 pt-1 text-[12px] text-fg-3 sm:px-5">No list price for {env.unpriced.join(", ")} — not included.</div>}
      <div className="mt-2">
        <DataTable label={`Estimated cost of ${env.label}`} rows={env.items} rowKey={(r) => `${r.kind}:${r.id}`} columns={itemColumns} still={env.items.length > 30} />
      </div>
    </Card>
  );
}
