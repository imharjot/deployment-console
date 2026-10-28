"use client";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowRight, CheckCircle2, ChevronDown, Database, ExternalLink, GitCommitHorizontal, HelpCircle, ShieldAlert, TriangleAlert } from "lucide-react";
import { Fragment, useState } from "react";
import useSWR from "swr";
import { FreshnessBanner } from "@/components/freshness-banner";
import { enter, exit } from "@/components/motion";
import { StateBadge } from "@/components/state";
import { Chip, Empty, Skeleton, TimeAgo, cx, useClockAt } from "@/components/ui";
import { loadedAt, trackedJson } from "@/lib/client/env";
import { hopOf, keptFreshness, needsPromotion, releasesHeadline, repoName, shortSha } from "@/lib/client/format";
import { isStale } from "@/lib/freshness";
import type { ReleaseStage, ReleaseStep, ReleaseView, State } from "@/lib/types";
import { Page, PageHeader, TAP } from "../_components/page-frame";

const RELEASES = "/api/releases";

export default function ReleasesPage() {
  const { data, error, isLoading, mutate } = useSWR<ReleaseView[]>(RELEASES, trackedJson, { refreshInterval: 60_000, keepPreviousData: true });
  // R21: kept data after a failed refresh says how old it is; once stale, stage states show UNKNOWN.
  const fresh = keptFreshness({ data, error, loadedAt: loadedAt(RELEASES), source: "ECS and GitHub", staleAfterMs: 3 * 60_000 });
  const now = useClockAt((n) => (fresh?.observedAt && n && !isStale(fresh, n) ? fresh.observedAt + fresh.staleAfterMs + 1 : undefined));
  const stale = !!fresh && !!now && isStale(fresh, now);
  const head = data ? releasesHeadline(data) : undefined;
  return (
    <Page>
      <PageHeader
        title="Releases"
        description={
          <>
            What runs where, in promotion order, and what each next environment would get.
            {head && <> <b className={cx("font-medium", head.tone === "ok" ? "text-up" : head.tone === "warn" ? "text-degraded" : "text-fg-2")}>{head.text}</b></>}
          </>
        }
      />
      <FreshnessBanner f={fresh} onRetry={() => void mutate()} />
      {error && !data && <Empty title="Could not load releases" hint={(error as Error).message} />}
      {isLoading && !data && <div className="space-y-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}</div>}
      {data && !data.length && <Empty title="No services with a repository yet" hint="Map a service to GitHub with the tag console:repo=owner/name (or services.<name>.repo in console.config.json)." />}
      {data?.map((r, i) => <Release key={r.service} r={r} i={i} stale={stale} />)}
    </Page>
  );
}

// The promotion chain runs left to right when its card is wide, top to bottom when narrow (container query).
function Stage({ s, repo, state }: { s: ReleaseStage; repo?: string; state: State }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-panel-2/60 px-3.5 py-3 @2xl:min-w-[160px] @2xl:flex-1">
      <div className="eyebrow mb-1.5 flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1 truncate">{s.protected && <ShieldAlert className="size-3 flex-none text-down" />}{s.label}</span>
        <StateBadge state={state} />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 @2xl:block">
        {s.sha ? (
          <a href={`https://github.com/${repo}/commit/${s.sha}`} target="_blank" rel="noreferrer" className={cx("font-mono text-[16px] text-accent hover:underline", TAP)}>{shortSha(s.sha)}</a>
        ) : (
          <span className="font-mono text-[14px] text-degraded">no sha (moving tag)</span>
        )}
        <div className="text-[12px] text-fg-3">revision {s.revision ?? "—"}</div>
      </div>
    </div>
  );
}

// One step of the chain (F08): "in sync" only when proven, "N waiting", "<to> is N ahead", "diverged", or unknown.
function Hop({ step, from, to, open, onToggle }: { step: ReleaseStep; from: ReleaseStage; to: ReleaseStage; open: boolean; onToggle(): void }) {
  const h = hopOf(step, from.sha, to.sha, to.label);
  const expandable = step.commits.length > 0;
  return (
    <button
      onClick={onToggle}
      disabled={!expandable}
      aria-expanded={expandable ? open : undefined}
      title={h.warning ?? step.note}
      className="press flex min-h-10 flex-none flex-wrap items-center justify-center gap-x-2.5 gap-y-1 rounded-lg px-3 py-1.5 text-center enabled:hover:bg-panel-3/50 disabled:cursor-default @2xl:w-32 @2xl:flex-col @2xl:flex-nowrap @2xl:px-1"
    >
      <ArrowDown className="size-4 flex-none text-fg-3 @2xl:hidden" aria-hidden />
      {h.kind === "sync" ? (
        <span className="inline-flex items-center gap-1 text-[13px] text-up"><CheckCircle2 className="size-4" /> in sync</span>
      ) : h.kind === "waiting" ? (
        <span className="flex items-baseline gap-1.5 @2xl:flex-col @2xl:items-center @2xl:gap-0">
          <span className="text-[16px] font-semibold tabular-nums text-degraded @2xl:text-xl">{h.ahead}</span>
          <span className="text-[12px] text-fg-3">waiting{expandable ? <ChevronDown className={cx("ml-0.5 inline size-3 transition-transform duration-200 ease-smooth", open && "rotate-180")} /> : null}</span>
        </span>
      ) : h.kind === "unknown" ? (
        <span className="inline-flex items-center gap-1 text-[12px] text-fg-3"><HelpCircle className="size-3.5" /> {step.note ?? "unknown"}</span>
      ) : (
        <span className={cx("inline-flex items-center gap-1 text-[12.5px] leading-snug", h.kind === "diverged" ? "text-down" : "text-degraded")}>
          <TriangleAlert className="size-3.5 flex-none" /> {h.text}
          {expandable ? <ChevronDown className={cx("inline size-3 flex-none transition-transform duration-200 ease-smooth", open && "rotate-180")} /> : null}
        </span>
      )}
      {step.migrations === true && <Chip tone="warn"><Database className="size-3" />migrations</Chip>}
      {step.migrations === "unknown" && <span title={step.migrationsWhy ? `Couldn't compare: ${step.migrationsWhy}` : undefined}><Chip tone="muted"><Database className="size-3" />migrations unchecked</Chip></span>}
      <ArrowRight className="mt-1 size-4 text-fg-3 @max-2xl:hidden" aria-hidden />
    </button>
  );
}

function Release({ r, i, stale }: { r: ReleaseView; i: number; stale: boolean }) {
  const [open, setOpen] = useState<number | null>(i === 0 && needsPromotion(r) ? r.steps.findIndex((s) => s.commits.length > 0) : null);
  const step = open !== null && open >= 0 ? r.steps[open] : undefined;
  const warn = step ? hopOf(step, r.stages[open!]?.sha, r.stages[open! + 1]?.sha, r.stages[open! + 1]?.label ?? step.to).warning : undefined;
  return (
    <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...enter, delay: Math.min(i, 8) * 0.03 }} className="@container rounded-2xl border border-line bg-panel p-4 shadow-card sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[16px] font-semibold">{r.name}</div>
          {r.repo && <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer" className={cx("inline-flex items-center gap-1 font-mono text-[12px] text-fg-3 hover:text-fg", TAP)}>{repoName(r.repo)} <ExternalLink className="size-3" /></a>}
        </div>
        <div className="flex items-center gap-3">
          {r.note && <span className="text-xs text-fg-3">{r.note}</span>}
          {step?.compareUrl && <a href={step.compareUrl} target="_blank" rel="noreferrer" className={cx("inline-flex items-center gap-1 text-xs text-accent hover:underline", TAP)}>compare on GitHub <ExternalLink className="size-3" /></a>}
        </div>
      </div>
      <div className="flex flex-col gap-1 @2xl:flex-row @2xl:items-stretch @2xl:gap-2">
        {r.stages.map((s, k) => (
          <Fragment key={s.env}>
            {k > 0 && r.steps[k - 1] && <Hop step={r.steps[k - 1]} from={r.stages[k - 1]} to={s} open={open === k - 1} onToggle={() => setOpen((o) => (o === k - 1 ? null : k - 1))} />}
            <Stage s={s} repo={r.repo} state={stale ? "UNKNOWN" : s.state} />
          </Fragment>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {step && step.commits.length > 0 && (
          <motion.div key={open} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto", transition: enter }} exit={{ opacity: 0, height: 0, transition: exit }} className="overflow-hidden">
            <div className="mt-3 text-xs text-fg-3">{step.commits.length} commit{step.commits.length === 1 ? "" : "s"} {r.stages.find((s) => s.env === step.to)?.label} would get from {r.stages.find((s) => s.env === step.from)?.label}</div>
            {step.migrations === "unknown" && (
              <div className="mt-2 flex items-start gap-2 text-[13px] text-fg-3">
                <Database className="mt-0.5 size-3.5 flex-none" /> Couldn&apos;t check for database migrations{step.migrationsWhy ? `: ${step.migrationsWhy}` : "."}
              </div>
            )}
            {warn && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-down/25 bg-down/6 px-3 py-2 text-[13.5px] text-down">
                <TriangleAlert className="mt-px size-3.5 flex-none" /> {warn} Merge {r.stages.find((s) => s.env === step.to)?.label}&apos;s commits back into {r.stages.find((s) => s.env === step.from)?.label} first.
              </div>
            )}
            <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
              {step.commits.map((c) => (
                <li key={c.sha} className="flex items-start gap-3 px-3 py-2.5 text-[14px] @2xl:items-center @2xl:py-2">
                  <GitCommitHorizontal className="mt-0.5 size-3.5 flex-none text-fg-3 @2xl:mt-0" />
                  {/* Narrow: title, then sha · author · time. Wide: one line, sha first. */}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 @2xl:flex-row @2xl:items-center @2xl:gap-3">
                    <span className="min-w-0 truncate @2xl:order-2 @2xl:flex-1">{c.title}</span>
                    <span className="flex items-center gap-2 text-[12px] text-fg-3 @2xl:contents">
                      <a href={`https://github.com/${r.repo}/commit/${c.sha}`} target="_blank" rel="noreferrer" className={cx("flex-none font-mono text-xs text-accent hover:underline @2xl:order-1", TAP)}>{shortSha(c.sha)}</a>
                      <span className="min-w-0 truncate @2xl:order-3 @2xl:flex-none">{c.author} · <TimeAgo at={c.date} /></span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
