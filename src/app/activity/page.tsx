"use client";
import { AnimatePresence } from "motion/react";
import { Activity, Boxes, ExternalLink, GitBranch, Hand, Rocket } from "lucide-react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { FreshnessBanner } from "@/components/freshness-banner";
import { Row, Swap, useFresh } from "@/components/motion";
import { Chip, Empty, Segmented, Skeleton, TimeAgo, cx } from "@/components/ui";
import { loadedAt, trackedJson, useEnv } from "@/lib/client/env";
import { keptFreshness, stamp } from "@/lib/client/format";
import type { ActivityItem } from "@/lib/types";
import { SearchField, SelectField } from "../_components/fields";
import { BELOW_HEADER, Page, PageHeader, TAP } from "../_components/page-frame";

const KIND = {
  ci: { icon: GitBranch, label: "CI" },
  deploy: { icon: Rocket, label: "Deploy" },
  ecs: { icon: Boxes, label: "ECS" },
  action: { icon: Hand, label: "Console action" },
} as const;
const TONE = { ok: "var(--up)", bad: "var(--down)", warn: "var(--degraded)", info: "var(--deploying)" } as const;

export default function ActivityPage() {
  const { env } = useEnv();
  const url = env ? `/api/activity?env=${env}` : null;
  const { data, error, isLoading, mutate } = useSWR<ActivityItem[]>(url, trackedJson, { refreshInterval: 15_000, keepPreviousData: true });
  const kept = keptFreshness({ data, error, loadedAt: loadedAt(url), source: "activity", staleAfterMs: 60_000 });
  const [kind, setKind] = useState("all");
  const [svc, setSvc] = useState("all");
  const [q, setQ] = useState("");
  const { fresh, gen } = useFresh(data?.map((i) => i.id));
  const services = useMemo(() => [...new Set((data ?? []).map((i) => i.service).filter(Boolean))] as string[], [data]);
  const items = useMemo(
    () => (data ?? []).filter((i) => (kind === "all" || i.kind === kind) && (svc === "all" || i.service === svc) && (!q || `${i.title} ${i.detail ?? ""} ${i.user ?? ""}`.toLowerCase().includes(q.toLowerCase()))),
    [data, kind, svc, q],
  );
  const days = useMemo(() => {
    const m = new Map<string, ActivityItem[]>();
    for (const i of items) {
      const d = new Date(i.at).toDateString();
      m.set(d, [...(m.get(d) ?? []), i]);
    }
    return [...m.entries()];
  }, [items]);

  return (
    <Page>
      <PageHeader
        title="Activity"
        description={`Everything that happened to ${env}: CI runs, deploys, ECS events and console actions, newest first.`}
        actions={
          <>
            <SearchField value={q} onChange={setQ} label="Filter activity" className="min-w-40 flex-1 sm:w-48 sm:flex-none" />
            <SelectField value={svc} onChange={setSvc} label="Service" className="max-w-[45%] sm:max-w-none" options={[{ value: "all", label: "All services" }, ...services.map((s) => ({ value: s, label: s }))]} />
            <Segmented id="act-kind" value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, { value: "deploy", label: "Deploys" }, { value: "ci", label: "CI" }, { value: "ecs", label: "ECS" }, { value: "action", label: "Actions" }]} />
          </>
        }
      />
      <FreshnessBanner f={kept} onRetry={() => void mutate()} />
      {/* Switching kind/service or env crossfades the feed; typing filters rows out in place and new
          events expand in at the top. A failed refresh keeps the feed (the banner says how old it is). */}
      <Swap id={error && !data ? "error" : isLoading && !data ? "loading" : !items.length ? "empty" : `feed-${kind}-${svc}-${gen}`} bodyClassName="space-y-5">
        {error && !data && <Empty title="Could not load activity" hint={(error as Error).message} />}
        {isLoading && !data && <div className="space-y-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>}
        {data && !items.length && <Empty icon={<Activity className="size-5" />} title="Nothing matches" />}
        {days.map(([day, list]) => (
          <section key={day}>
            <h2 className={cx("eyebrow sticky z-10 -mx-2 bg-[color-mix(in_srgb,var(--bg)_85%,transparent)] px-2 py-2 backdrop-blur", BELOW_HEADER)}>{day === new Date().toDateString() ? "Today" : day}</h2>
            <ol className="relative ml-3 border-l border-line">
              <AnimatePresence>
                {list.map((i, n) => {
                  const K = KIND[i.kind];
                  return (
                    <Row key={i.id} index={n} fresh={fresh.has(i.id)} still={items.length > 100} className="relative ml-5 rounded-lg py-2 pl-1">
                      <span className="absolute -left-[33px] top-3 grid size-6 place-items-center rounded-full border border-line bg-panel" style={{ color: TONE[i.tone] }}>
                        <K.icon className="size-3.5" />
                      </span>
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[14px] font-medium [overflow-wrap:anywhere]" style={{ color: i.tone === "bad" ? "var(--down)" : undefined }}>{i.title}</span>
                        {i.service && <Chip>{i.service}</Chip>}
                        <span className="text-[12px] text-fg-3" title={stamp(i.at)}><TimeAgo at={i.at} /></span>
                        {i.user && <span className="text-[12px] text-fg-3">by {i.user}</span>}
                        {i.url && (
                          <a href={i.url} target="_blank" rel="noreferrer" className={cx("inline-flex items-center gap-0.5 text-[12px] text-accent hover:underline", TAP)}>
                            open <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>
                      {i.detail && <div className={cx("mt-0.5 text-[13.5px] [overflow-wrap:anywhere]", i.tone === "bad" ? "text-down" : "text-fg-2")}>{i.detail}</div>}
                    </Row>
                  );
                })}
              </AnimatePresence>
            </ol>
          </section>
        ))}
      </Swap>
    </Page>
  );
}
