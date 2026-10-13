"use client";
// A run's outcome as three separate badges — "AI completed", "AWS accepted", "verified healthy" — and its state as a
// chip. They are never merged: an accepted request is not a healthy service, and a finished answer is not a change.
import { Bot, CircleHelp, Cloud, HeartPulse } from "lucide-react";
import { Chip, cx } from "@/components/ui";
import { outcomeBadges, runStateInfo, type OutcomeContext } from "./rules";
import type { RunOutcome } from "./types";

const ICON = { ai: Bot, aws: Cloud, health: HeartPulse } as const;

// `context` (outcomeContext(run)) tells a change still in flight from an unknown outcome, and a run with no AI step of
// its own from one whose model hasn't answered; without it, `final` alone is used.
export function OutcomeBadges({ outcome, final, context, className }: { outcome: RunOutcome | undefined; final?: boolean; context?: OutcomeContext; className?: string }) {
  const badges = outcomeBadges(outcome, context ?? { final });
  if (!badges.length) return null;
  return (
    <ul aria-label="Outcome" className={cx("flex flex-wrap items-center gap-1.5", className)}>
      {badges.map((b) => {
        const Icon = ICON[b.key];
        return (
          <li key={b.key} title={b.hint}>
            <Chip tone={b.tone}>
              <Icon className="size-3" aria-hidden /> {b.label}
              <span className="sr-only">: {b.hint}</span>
            </Chip>
          </li>
        );
      })}
    </ul>
  );
}

export function RunStateChip({ state, className }: { state: string; className?: string }) {
  const s = runStateInfo(state);
  return (
    <span title={s.hint} className={className}>
      <Chip tone={s.tone}>
        {state === "outcome_unknown" && <CircleHelp className="size-3" aria-hidden />}
        {s.label}
      </Chip>
    </span>
  );
}
