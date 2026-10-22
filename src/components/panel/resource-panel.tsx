"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Check, Copy, ExternalLink, MoreHorizontal, Pencil, Play, Power, RotateCcw, Square, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";
import useSWR from "swr";
import { capacityText, opsOf, repoName, revisionGuard, shortSha, stamp, verificationText } from "@/lib/client/format";
import { loadedAt, trackedJson, useEnvList } from "@/lib/client/env";
import { useRegions } from "@/lib/client/region";
import { ecsNoteTarget } from "@/lib/notes";
import type { EnvOverview, MetricSeries, PropertyItem, RawEvent, ResourceView, RevisionView } from "@/lib/types";
import { MetricChart } from "../charts";
import { AskAbout, ecsSubject } from "../assistant/status";
import { useBoxAction, useServiceAction } from "../confirm";
import { Modal, Row, Sheet, Swap, enter, swap, useFresh, usePhone } from "../motion";
import { Notes, useNoteCount } from "../notes";
import { PinButton } from "../pin-button";
import { ResourceCard } from "../overview/card";
import { StateBadge, UptimeBars, stateStyle } from "../state";
import { CreateTicketButton, resourceTicket } from "../ticket-button";
import { Button, Chip, Empty, IconButton, RegionBadge, Segmented, Skeleton, Tabs, TimeAgo, copy, cx } from "../ui";

// The heavy tabs load when first opened (F53); cards start loading them on hover or focus (preloadPanel).
const LogViewer = dynamic(() => import("../logs/log-viewer").then((m) => m.LogViewer), { ssr: false, loading: () => <Skeleton className="h-full min-h-60 rounded-xl" /> });
const EnvVars = dynamic(() => import("./env-vars").then((m) => m.EnvVars), {
  ssr: false,
  loading: () => <div className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-11" />)}</div>,
});
const ProvisionActions = dynamic(() => import("./provision").then((m) => m.ProvisionActions), { ssr: false, loading: () => null });

type Tab = ResourceView["tabs"][number] | "notes";
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", revisions: "Revisions", variables: "Variables", events: "Events", logs: "Logs", metrics: "Metrics", containers: "Containers", notes: "Notes" };

type Action = ResourceView["actions"][number];
const ACTION_ICON: Record<Action["name"], LucideIcon> = { restart: RotateCcw, start: Play, stop: Square, switch: ArrowUpRight, boxStart: Power, boxStop: Power };

export function ResourcePanel({ r, overview, onClose, onOpen }: { r: ResourceView; overview: EnvOverview; onClose(): void; onOpen(key: string): void }) {
  // A link may name the tab (?tab=variables — e.g. a configuration-drift task). The panel opens on the client, once
  // the environment's data is in, so the URL is read when it mounts.
  const [tab, setTab] = useState<Tab>(() => {
    const want = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
    return want && ((r.tabs as string[]).includes(want) || want === "notes") ? (want as Tab) : "overview";
  });
  // The sheet and header commit first so the slide-in starts at once; the tab body follows as an
  // interruptible background render (time-sliced, so opening never blocks the main thread).
  const bodyReady = useDeferredValue(true, false);
  const serviceAction = useServiceAction();
  const boxAction = useBoxAction();
  // Notes and pins use the inventory's resource keys, so the cloud map shows the same ones (services need the
  // env's cluster; outside the home region the key carries the region).
  const envInfo = useEnvList().data?.find((e) => e.id === r.env);
  const regions = useRegions();
  const noted = ecsNoteTarget(r, envInfo?.cluster, envInfo?.region, regions.data?.home);
  const noteCount = useNoteCount(noted?.key);
  const short = r.state === "UNKNOWN" ? undefined : capacityText(r.capacity);
  // A host's Containers tab: services with tasks on it, then those whose tasks' hosts weren't read.
  const placedHere = overview.services.filter((s) => r.placed?.includes(s.key) ?? true);
  const maybeHere = overview.services.filter((s) => r.maybePlaced?.includes(s.key));
  const op = opsOf(r)[0];
  const scaling = r.autoscaling && !r.properties.some((g) => g.items.some((i) => /autoscal/i.test(i.label))) ? r.autoscaling : undefined;
  // The assistant: "Explain this" for any resource, "Why is this unhealthy?" when it isn't ok — scoped to its inventory key.
  const asked = ecsSubject(r, noted?.key, envInfo?.label);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog][aria-modal]") && !document.activeElement?.closest("aside")) onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const runAction = (name: Action["name"]) => {
    const warning = r.actions.find((a) => a.name === name)?.warning;
    if (name === "boxStart") return boxAction(r, "start", warning);
    if (name === "boxStop") return boxAction(r, "stop", warning);
    if (name === "switch") return setTab("revisions");
    serviceAction(r.env, r.id, r.name, name, undefined, { warnings: warning ? [warning] : [] });
  };

  return (
    // Full screen below md; a wide sheet from the right above it. The header stays put while each tab scrolls.
    <Sheet onClose={onClose} role="region" aria-label={`${r.name} details`} style={stateStyle(r.state)} className="flex h-full w-full flex-col overflow-hidden border-line bg-panel shadow-float md:w-[min(1080px,96vw)] md:rounded-l-2xl md:border-l">
      <header className="relative flex-none space-y-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] sm:space-y-4 sm:px-7 sm:pt-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h2 className="min-w-0 truncate font-display text-[28px] leading-[1.1] sm:text-[34px]">{r.name}</h2>
              {noted && <PinButton rkey={noted.key} name={noted.name} kind={r.kind === "service" ? "ecs-service" : r.kind} env={r.env} region={envInfo?.region} />}
              <StateBadge state={r.state} />
              <Chip mono>{r.env}</Chip>
              {regions.multi && <RegionBadge region={envInfo?.region} />}
              {r.readOnly && <span title={r.actions.find((a) => !a.enabled)?.why}><Chip tone="muted">read-only</Chip></span>}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
              <span className="max-w-full truncate font-mono">{r.subtitle}</span>
              {r.repo && (
                <a className="inline-flex items-center gap-1 text-accent hover:underline pointer-coarse:-my-3 pointer-coarse:py-3" href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer">
                  {repoName(r.repo)} <ExternalLink className="size-3" />
                </a>
              )}
              <span>
                checked <TimeAgo at={r.checkedAt} />
              </span>
              {r.uptime?.since && (
                <span>
                  {r.state.toLowerCase().replace("_", " ")} since <TimeAgo at={r.uptime.since} />
                </span>
              )}
            </div>
            {r.uptime && <UptimeBars u={r.uptime} verbose className="mt-2.5 max-w-md" />}
            {(short || op || scaling) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {short && <Chip tone="warn">{short}</Chip>}
                {scaling && <Chip tone="muted" className="font-mono">autoscaling min {scaling.min} · max {scaling.max}</Chip>}
                {op && (
                  <span title={`${op.action} by ${op.actor} · ${stamp(op.at)}${op.detail ? ` · ${op.detail}` : ""}`}>
                    <Chip tone={verificationText(op).tone}>
                      {op.action.split(".").pop()}: {verificationText(op).text}
                    </Chip>
                  </span>
                )}
              </div>
            )}
            <AskAbout subject={asked.subject} unhealthy={asked.unhealthy} className="mt-2.5" />
          </div>
          <IconButton label="Close (Esc)" onClick={onClose} className="-mr-1 max-sm:size-10">
            <X className="size-[18px]" />
          </IconButton>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <ul className="flex min-w-0 flex-wrap gap-1.5">
            {r.reasons.map((x) => (
              <li key={x} className={cx("rounded-md border px-2 py-0.5 text-xs leading-relaxed", r.state === "UP" ? "border-line text-fg-2" : "border-[color-mix(in_srgb,var(--dot)_30%,transparent)] bg-[color-mix(in_srgb,var(--dot)_6%,transparent)] text-[var(--dot)]")}>
                {x}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
            <Actions r={r} run={runAction} />
            <ProvisionActions r={r} />
          </div>
        </div>

        <Tabs
          id={`panel-${r.key}`}
          value={tab}
          onChange={setTab}
          tabs={[...r.tabs, ...(noted ? (["notes"] as const) : [])].map((t) => ({
            value: t,
            label: TAB_LABEL[t],
            badge: t === "notes" && noteCount > 0 ? <span className="rounded-full bg-panel-3 px-1.5 text-[11px] leading-4 tabular-nums text-fg-2">{noteCount}</span> : undefined,
          }))}
        />
      </header>

      {/* Each tab is its own absolutely placed scroll pane, so outgoing and incoming tabs overlap
          in a crossfade (no blank gap) and each opens at the top without disturbing the other. */}
      <div className="relative min-h-0 flex-1">
        <AnimatePresence initial={false}>
          {bodyReady && (
            <motion.div key={tab} {...swap} className={cx("absolute inset-0 pb-[env(safe-area-inset-bottom)]", tab === "logs" ? "flex flex-col p-3 sm:p-4" : "overflow-y-auto overscroll-contain p-4 sm:p-7")}>
              {tab === "overview" && <Properties r={r} onEdit={(k) => (k === "revision" ? setTab("revisions") : k === "desired" ? runAction(r.actions.find((a) => a.name === "start")?.enabled ? "start" : "stop") : runAction(r.actions.find((a) => a.name === "boxStart")?.enabled ? "boxStart" : "boxStop"))} />}
              {tab === "revisions" && <Revisions r={r} />}
              {tab === "variables" && <EnvVars r={r} />}
              {tab === "events" && <Events r={r} />}
              {tab === "metrics" && <Metrics r={r} />}
              {tab === "logs" && <LogViewer env={r.env} services={[r.id]} compact />}
              {tab === "notes" && noted && <Notes resourceKey={noted.key} resourceName={noted.name} env={r.env} />}
              {tab === "containers" && (
                <div className="grid gap-5">
                  {placedHere.length ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {placedHere.map((s) => (
                        <ResourceCard key={s.key} r={s} onOpen={onOpen} compact />
                      ))}
                    </div>
                  ) : (
                    <Empty title={maybeHere.length ? "No tasks known to run on this host" : "No tasks on this host"} />
                  )}
                  {maybeHere.length > 0 && (
                    <section className="grid gap-3">
                      <h3 className="eyebrow">Placement not read — may run here</h3>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {maybeHere.map((s) => (
                          <ResourceCard key={s.key} r={s} onOpen={onOpen} compact />
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Sheet>
  );
}

// Every action inline on larger screens. Phones keep the first available action and the ticket button in
// the row and fold the rest into a "More" sheet, where disabled actions still say why.
function Actions({ r, run }: { r: ResourceView; run(name: Action["name"]): void }) {
  const phone = usePhone();
  const [more, setMore] = useState(false);
  const ticket = <CreateTicketButton {...resourceTicket(r)} env={r.env} target={r.id} className="max-sm:h-10 max-sm:px-3.5" />;
  const button = (a: Action, className?: string) => {
    const I = ACTION_ICON[a.name];
    // Disabled: why. Enabled with a warning (permission not verified, autoscaling overrides the count): the warning,
    // marked on the button and repeated at the top of the confirmation.
    return (
      <Button key={a.name} size="sm" disabled={!a.enabled} title={a.enabled ? a.warning : a.why} onClick={() => run(a.name)} className={cx(a.danger && "enabled:hover:!border-down/50 enabled:hover:!text-down", className)}>
        <I className="size-3.5" strokeWidth={1.75} /> {a.label}
        {a.enabled && a.warning && <TriangleAlert className="size-3 text-degraded" aria-label="warning" />}
      </Button>
    );
  };
  if (!phone) {
    return (
      <div className="flex flex-wrap gap-2">
        {r.actions.map((a) => button(a))}
        {ticket}
      </div>
    );
  }
  const first = r.actions.find((a) => a.enabled);
  const rest = r.actions.filter((a) => a !== first);
  return (
    <div className="flex w-full gap-2">
      {first && button(first, "h-10 flex-1 px-3.5")}
      {ticket}
      {rest.length > 0 && (
        <Button size="sm" onClick={() => setMore(true)} aria-haspopup="dialog" className="h-10 px-3.5">
          <MoreHorizontal className="size-4" /> More
        </Button>
      )}
      <AnimatePresence>
        {more && (
          <Modal onClose={() => setMore(false)} aria-label={`${r.name} actions`}>
            <div className="px-5 pb-2 pt-1 font-display text-2xl">{r.name}</div>
            <ul className="px-3 pb-4">
              {rest.map((a) => {
                const I = ACTION_ICON[a.name];
                return (
                  <li key={a.name}>
                    <button
                      disabled={!a.enabled}
                      onClick={() => {
                        setMore(false);
                        run(a.name);
                      }}
                      className={cx("press flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[16px] enabled:hover:bg-panel-2 disabled:opacity-45", a.danger ? "text-down" : "text-fg")}
                    >
                      <I className="size-4 flex-none text-fg-3" strokeWidth={1.75} />
                      <span className="min-w-0 flex-1">
                        {a.label}
                        {!a.enabled && a.why && <span className="block text-xs text-fg-3">{a.why}</span>}
                        {a.enabled && a.warning && <span className="block text-xs text-degraded">{a.warning}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

function Value({ it }: { it: PropertyItem }) {
  const [copied, setCopied] = useState(false);
  const tone = it.tone === "ok" ? "text-up" : it.tone === "warn" ? "text-degraded" : it.tone === "bad" ? "text-down" : it.tone === "muted" ? "text-fg-3" : "text-fg";
  const inner = it.href ? (
    <a href={it.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline pointer-coarse:-my-3 pointer-coarse:py-3">
      {it.value}
      <ExternalLink className="size-3 opacity-60" />
    </a>
  ) : (
    it.value
  );
  return (
    <span className={cx("group/v inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]", it.mono && "font-mono text-[13px]", tone)}>
      {inner}
      {it.copy && (
        <button
          className="rounded opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/v:opacity-100 pointer-coarse:-m-3 pointer-coarse:p-3 pointer-coarse:opacity-100"
          aria-label={`Copy ${it.label}`}
          onClick={() => {
            copy(it.value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check className="size-3 text-up" /> : <Copy className="size-3 text-fg-3 hover:text-fg" />}
        </button>
      )}
    </span>
  );
}

function Properties({ r, onEdit }: { r: ResourceView; onEdit(kind: NonNullable<PropertyItem["edit"]>): void }) {
  if (!r.properties.length) return <Empty title="No properties available" hint={r.reasons[0]} />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {r.properties.map((g, gi) => (
        <motion.section
          key={g.title}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...enter, delay: Math.min(gi, 6) * 0.03 }}
          className={cx("rounded-2xl border border-line bg-panel", (g.title === "Tasks" || g.title === "Deployments") && "lg:col-span-2")}
        >
          <h3 className="eyebrow border-b border-line px-4 py-3">{g.title}</h3>
          <dl className="divide-y divide-line">
            {g.items.map((it) => (
              // Phones stack the label above the value; wider screens use label / value / action columns.
              <div key={it.label} className="group grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-[14px] sm:grid-cols-[minmax(120px,38%)_1fr_auto] sm:py-2">
                <dt className="text-fg-3 max-sm:text-xs sm:text-fg-2">{it.label}</dt>
                <dd className="min-w-0 max-sm:order-last max-sm:col-span-2">
                  <Value it={it} />
                </dd>
                {it.edit && !r.readOnly ? (
                  <button onClick={() => onEdit(it.edit!)} className="press inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-accent hover:bg-accent-soft pointer-coarse:min-h-10 pointer-coarse:px-3" aria-label={`Change ${it.label}`}>
                    <Pencil className="size-3" /> change
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </dl>
        </motion.section>
      ))}
    </div>
  );
}

function Revisions({ r }: { r: ResourceView }) {
  const { data, error, isLoading } = useSWR<RevisionView[]>(`/api/services/${r.env}/${r.id}/revisions`, { refreshInterval: 15_000 });
  const act = useServiceAction();
  const { fresh } = useFresh(data?.map((v) => v.arn));
  const liveIdx = data?.findIndex((x) => x.live) ?? -1;
  const live = liveIdx >= 0 ? data?.[liveIdx] : undefined;
  return (
    <Swap id={isLoading ? "loading" : error ? "error" : data?.length ? "list" : "empty"}>
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : error ? (
        <Empty title="Could not load revisions" hint={(error as Error).message} />
      ) : !data?.length ? (
        <Empty title="No revisions registered" />
      ) : (
        <ol className="relative space-y-1.5 before:absolute before:bottom-3 before:left-[19px] before:top-3 before:w-px before:bg-line">
          <AnimatePresence>
            {data.map((v, i) => {
              const g = revisionGuard(r, v);
              const label = v.live ? "Live" : liveIdx >= 0 && i > liveIdx ? "Roll back" : "Roll forward";
              return (
                <Row key={v.arn} index={i} fresh={fresh.has(v.arn)} className={cx("relative flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border px-3 py-2.5 transition-colors duration-200 sm:flex-nowrap", v.live ? "border-line bg-panel-2" : "border-transparent hover:border-line hover:bg-panel-2/60")}>
                  <span className={cx("relative z-10 grid size-[22px] flex-none place-items-center rounded-full border bg-panel", v.live ? "border-up/60" : "border-line-strong")}>{v.live && <span className="size-2 rounded-full bg-up" />}</span>
                  <div className="w-14 flex-none font-mono text-[14px] text-fg-2">rev {v.revision}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {v.commit ? (
                        <a href={v.commit.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent hover:underline pointer-coarse:-my-3 pointer-coarse:inline-block pointer-coarse:py-3">{shortSha(v.sha)}</a>
                      ) : (
                        <span className="font-mono text-xs text-fg-3">{v.tag}</span>
                      )}
                      <span className="truncate text-[14px]">{v.commit?.title ?? ""}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-fg-3">
                      {v.commit && <span>{v.commit.author}</span>}
                      <span>registered {stamp(v.registeredAt)}</span>
                      {v.live && <Chip tone="ok">live</Chip>}
                      {v.ci === "success" && <Chip tone="ok">CI passed</Chip>}
                      {v.ci === "failure" && <Chip tone="bad">CI failed</Chip>}
                      {v.ci === "in_progress" && <Chip tone="accent">CI running</Chip>}
                      {v.imageCheck === "missing" ? (
                        <span title={v.imageCheckWhy}><Chip tone="bad">image missing</Chip></span>
                      ) : v.imageCheck === "unknown" ? (
                        <span title={v.imageCheckWhy}><Chip tone="muted">image unchecked</Chip></span>
                      ) : v.imageCheck === undefined && !v.imagePresent ? (
                        <Chip tone="bad">image expired</Chip>
                      ) : null}
                      {v.mutableTag && <span title={v.mutableTagWhy ?? `the tag ${v.tag} can point at another image`}><Chip tone="warn">moving tag</Chip></span>}
                      {/* "unknown" is truthy: every check is === true (F07). */}
                      {v.migrations === true && <Chip tone="warn">DB migrations vs live</Chip>}
                      {v.migrations === "unknown" && (
                        <Link href="/docs/github" title={v.migrationsWhy ? `Couldn't compare: ${v.migrationsWhy}` : "Couldn't compare these commits"} className="hover:underline">
                          <Chip tone="muted">migrations unchecked</Chip>
                        </Link>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    disabled={g.disabled}
                    title={g.why ?? (g.warnings.length ? g.warnings.join(" ") : undefined)}
                    onClick={() => act(r.env, r.id, r.name, "switch", v, { warnings: g.warnings, currentRevision: live?.revision })}
                    className="max-sm:ml-[38px]"
                  >
                    {label}
                    {!g.disabled && g.warnings.length > 0 && <TriangleAlert className="size-3 text-degraded" aria-label="warning" />}
                  </Button>
                </Row>
              );
            })}
          </AnimatePresence>
        </ol>
      )}
    </Swap>
  );
}

function Events({ r }: { r: ResourceView }) {
  const { data, error, isLoading } = useSWR<RawEvent[]>(`/api/services/${r.env}/${r.id}/events`, { refreshInterval: 5_000 });
  const { fresh } = useFresh(data?.map((e) => e.id));
  return (
    <Swap id={isLoading ? "loading" : error ? "error" : data?.length ? "list" : "empty"}>
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-9" />)}</div>
      ) : error ? (
        <Empty title="Could not load events" hint={(error as Error).message} />
      ) : !data?.length ? (
        <Empty title="No recent ECS events" />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
          <AnimatePresence>
            {data.map((e, i) => {
              const bad = /fail|unable|error|unhealthy|rolling back/i.test(e.message);
              const good = /steady state|completed/i.test(e.message);
              return (
                <Row key={e.id} index={i} fresh={fresh.has(e.id)} still={data.length > 100} className="flex flex-col gap-0.5 px-4 py-2.5 text-[14px] sm:flex-row sm:gap-4">
                  <span className="flex-none font-mono text-[12px] leading-5 text-fg-3 sm:w-36">{stamp(e.at)}</span>
                  <span className={cx("min-w-0", bad ? "text-down" : good ? "text-fg-2" : "text-fg")}>{e.message}</span>
                </Row>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </Swap>
  );
}

function Metrics({ r }: { r: ResourceView }) {
  const [minutes, setMinutes] = useState("60");
  const url = `/api/metrics?env=${r.env}&key=${encodeURIComponent(r.key)}&minutes=${minutes}`;
  const { data, error, isLoading } = useSWR<MetricSeries[]>(url, trackedJson, { refreshInterval: 60_000, keepPreviousData: true });
  // The x axis spans the window that was asked for, ending when the data was read (F13): an hour-old last point
  // reads "as of", never "now".
  const end = loadedAt(url);
  const range: [number, number] | undefined = end ? [end - Number(minutes) * 60_000, end] : undefined;
  return (
    <div className="space-y-4">
      <Segmented id={`mins-${r.key}`} size="sm" value={minutes} onChange={setMinutes} options={[{ value: "60", label: "1h" }, { value: "360", label: "6h" }, { value: "1440", label: "24h" }]} />
      {isLoading && !data ? (
        <div className="grid gap-4 lg:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-52" />)}</div>
      ) : error ? (
        <Empty title="Could not load metrics" hint={(error as Error).message} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data?.map((s) => (
            // Neutral grey whatever the service's state: a CPU line in red reads as an error (F36).
            <MetricChart key={s.id} series={s} range={range} />
          ))}
        </div>
      )}
    </div>
  );
}
