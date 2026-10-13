"use client";
// A change an agent proposed, as a person reviews it (AGENT_ARCHITECTURE §6 "approval", §9.8 "understandable approval
// preview"): what changes, where, why (with links to the evidence it cites and how old that is), who else is affected,
// the cost and capacity bounds, how success will be judged, and the exact plan the approval binds (its hash) with the
// request's expiry. Approving binds this plan: if anything in it changes before the change runs, the request is
// invalidated and the agent has to ask again. `actions` holds the caller's buttons (Approvals, the assistant drawer).
import { AlertTriangle, ChevronRight, Clock, Fingerprint } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Chip, cx, useNow } from "@/components/ui";
import { stamp } from "@/lib/client/format";
import { evidenceAnchor } from "./evidence-list";
import { PROPOSAL_STATE, evidenceAge, planFacts, shortHash, untilText } from "./rules";
import type { EvidenceItem, ProposalView } from "./types";

// Text with its evidence citations (E1, [E2]) turned into links to the evidence entries.
export function Cited({ text, runId, known }: { text: string; runId: string; known?: ReadonlySet<string> }) {
  const parts = text.split(/(\bE\d{1,4}\b)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^E\d{1,4}$/.test(p) && (!known || known.has(p)) ? (
          <a key={i} href={`#${evidenceAnchor(runId, p)}`} className="rounded px-0.5 font-mono text-[0.92em] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export function PlanCard({ proposal, evidence, runId, maxAgeSeconds, actions, compact, className }: {
  proposal: ProposalView;
  evidence?: readonly EvidenceItem[];
  runId: string;
  maxAgeSeconds?: number;
  actions?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const now = useNow();
  const f = planFacts(proposal, evidence);
  const state = PROPOSAL_STATE[proposal.state] ?? { label: proposal.state, tone: "muted" as const };
  const known = new Set((evidence ?? []).map((e) => e.id));
  const oldest = f.evidence.oldest !== undefined ? evidenceAge(f.evidence.oldest, now, maxAgeSeconds) : undefined;
  const titleId = `plan-${proposal.grantId}`;
  const row = (label: string, value: ReactNode) => (
    <>
      <dt className="pt-px text-[12.5px] text-fg-3">{label}</dt>
      <dd className="min-w-0 text-[13.5px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]">{value}</dd>
    </>
  );
  return (
    <article aria-labelledby={titleId} className={cx("rounded-2xl border border-line bg-panel shadow-card", className)}>
      <header className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1 basis-48">
          <div className="eyebrow mb-0.5">Proposed change</div>
          <h3 id={titleId} className="text-[15px] font-semibold leading-snug">{f.summary}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip mono>{proposal.op}</Chip>
          <Chip tone={state.tone}>{state.label}</Chip>
        </div>
      </header>
      <div className="space-y-3 px-4 py-3">
        {!!f.warnings.length && (
          <ul role="note" className="space-y-1 rounded-xl border border-degraded/25 bg-degraded/6 px-3 py-2">
            {f.warnings.map((w) => (
              <li key={w} className="flex gap-2 text-[13.5px] leading-relaxed text-degraded">
                <AlertTriangle className="mt-[3px] size-3.5 flex-none" aria-hidden /> <span className="min-w-0">{w}</span>
              </li>
            ))}
          </ul>
        )}
        {proposal.state === "invalidated" && (proposal.invalidationReason ?? proposal.reason) && (
          <p role="note" className="rounded-xl border border-down/25 bg-down/6 px-3 py-2 text-[13.5px] text-down">Invalidated — {proposal.invalidationReason ?? proposal.reason}. Nothing ran; the agent has to ask again.</p>
        )}
        {proposal.state === "rejected" && proposal.reason && <p role="note" className="rounded-xl border border-line bg-panel-2 px-3 py-2 text-[13.5px] text-fg-2">Rejected: {proposal.reason}</p>}
        <dl className="grid grid-cols-[minmax(84px,auto)_1fr] gap-x-3 gap-y-1.5">
          {row(
            "What changes",
            <ul className="space-y-0.5">
              {f.what.map((c, i) => (
                <li key={i} className="flex gap-1.5">
                  <ChevronRight className="mt-[4px] size-3 flex-none text-fg-3" aria-hidden />
                  <span>{c}</span>
                </li>
              ))}
            </ul>,
          )}
          {row("Where", f.where.length ? <span className="font-mono text-[12.5px]">{f.where.join(", ")}</span> : <span className="text-fg-3">—</span>)}
          {f.why && row("Why", <Cited text={f.why} runId={runId} known={known} />)}
          {row(
            "Evidence",
            f.evidence.found.length || f.evidence.missing.length ? (
              <span>
                {f.evidence.found.map((e, i) => (
                  <Fragment key={e.id}>
                    {i > 0 && ", "}
                    <a href={`#${evidenceAnchor(runId, e.id)}`} className="font-mono text-accent underline decoration-accent/40 underline-offset-2">{e.id}</a>
                  </Fragment>
                ))}
                {f.evidence.missing.length > 0 && <span className="text-degraded"> · cites {f.evidence.missing.join(", ")}, which this run doesn&apos;t have</span>}
                {f.refreshed && <span className="text-fg-3"> · {f.refreshed} re-read just before asking (the older evidence was past the policy&apos;s limit)</span>}
                {f.stale && <span className="text-degraded"> · older than the policy allows, and it couldn&apos;t be read again — check the service yourself before approving</span>}
                {oldest && now > 0 && (
                  <span className={cx(oldest.stale && maxAgeSeconds !== undefined ? "text-degraded" : "text-fg-3")}>
                    {" "}· oldest {oldest.text}
                    {oldest.stale && maxAgeSeconds !== undefined ? " — older than the policy allows; it is refreshed before the change runs" : ""}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-fg-3">none cited</span>
            ),
          )}
          {!compact && row("Affected", f.consumers === undefined ? <span className="text-fg-3">not reported</span> : f.consumers.length ? f.consumers.join(", ") : "nothing else reads what changes")}
          {!compact && row("Bounds", f.bounds.length ? f.bounds.join(" · ") : <span className="text-fg-3">no cost change estimated; one change, within the run&apos;s limits</span>)}
          {row("Done when", f.success)}
          {row(
            "Plan",
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="inline-flex items-center gap-1 font-mono text-[12.5px]" title={`Approving binds exactly this plan: ${f.planHash}`}>
                <Fingerprint className="size-3 text-fg-3" aria-hidden /> {shortHash(f.planHash)}
              </span>
              <span className="inline-flex items-center gap-1 text-[12.5px] text-fg-3" title={f.expiresAt ? stamp(f.expiresAt) : undefined}>
                <Clock className="size-3" aria-hidden /> {proposal.state === "pending" ? `expires ${untilText(f.expiresAt, now)}` : f.expiresAt ? `expiry ${stamp(f.expiresAt)}` : "no expiry"}
              </span>
            </span>,
          )}
        </dl>
      </div>
      {actions && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">{actions}</footer>}
    </article>
  );
}
