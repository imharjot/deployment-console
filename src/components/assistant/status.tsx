"use client";
// Whether the assistant can be used here, for the shell and the panels: the agents switch and the emergency stop
// (GET /api/agents/settings, any signed-in person). The header's Ask button, the read-only emergency-stop banner every
// person sees while the stop is on, and the panels' "Explain this" / "Why is this unhealthy?" buttons.
import { OctagonAlert, Sparkles } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";
import { ecsStateWord, ecsUnhealthy, mapStateWord, mapUnhealthy, questionFor, type AskSubject } from "./model";
import { ask, openAssistant } from "./store";
import { Button, IconButton, Kbd, TimeAgo, cx } from "../ui";
import { useMe } from "../user-menu";

interface AgentsSettings {
  enabled?: { on?: unknown; source?: unknown };
  stop?: { on?: unknown; by?: unknown; at?: unknown; reason?: unknown };
}

// `on` is undefined until the switch has been read (or when the console has no agents API): callers treat that as
// usable and let the server answer, so an older console never hides the assistant for no reason.
export function useAgentsStatus() {
  const { data } = useSWR<AgentsSettings>("/api/agents/settings", { refreshInterval: 30_000, keepPreviousData: true });
  const s = data && typeof data === "object" ? data : undefined;
  const enabled = s?.enabled && typeof s.enabled.on === "boolean" ? s.enabled.on : undefined;
  const stop = s?.stop && s.stop.on === true
    ? { on: true as const, by: typeof s.stop.by === "string" ? s.stop.by : undefined, at: typeof s.stop.at === "number" ? s.stop.at : undefined, reason: typeof s.stop.reason === "string" ? s.stop.reason : undefined }
    : undefined;
  return { enabled, off: enabled === false, envForced: s?.enabled?.source === "env", stop };
}

export const OFF_TEXT = "Agents are turned off on this console, so the assistant can't run. An admin can turn them on in Automation → Agents.";

// The emergency stop, read-only, for everyone while it's on (admins change it in Automation).
export function EmergencyStopBanner({ className }: { className?: string }) {
  const { stop } = useAgentsStatus();
  const admin = useMe().data?.user?.role === "admin";
  if (!stop) return null;
  return (
    <div role="status" className={cx("flex items-start gap-2 border-b border-down/25 bg-down/8 px-4 py-2 text-[13.5px] text-fg-2 sm:px-6", className)}>
      <OctagonAlert className="mt-0.5 size-3.5 flex-none text-down" strokeWidth={1.75} />
      <p className="min-w-0 flex-1 leading-5 [overflow-wrap:anywhere]">
        <b className="font-medium text-down">Emergency stop is on.</b> Agents can read and explain, but nothing an agent asks for can change anything until an admin turns it off.
        {(stop.by || stop.at) && (
          <span className="text-fg-3">
            {" "}Set{stop.by ? ` by ${stop.by}` : ""}
            {stop.at ? <> <TimeAgo at={stop.at} /></> : null}
            {stop.reason ? ` — ${stop.reason}` : ""}.
          </span>
        )}
        {admin && (
          <>
            {" "}
            <Link href="/automation#agents" className="text-accent hover:underline">Manage in Automation</Link>
          </>
        )}
      </p>
    </div>
  );
}

// The header's Ask button. With agents switched off it can't be used: a tooltip says why on larger screens, and
// phones (no tooltips) don't show it at all.
export function AskButton() {
  const { off } = useAgentsStatus();
  if (off) {
    return (
      <Button size="sm" disabled title={OFF_TEXT} aria-label={`Ask the assistant (unavailable: ${OFF_TEXT})`} className="h-8 max-sm:!hidden">
        <Sparkles className="size-3.5" strokeWidth={1.75} /> Ask
      </Button>
    );
  }
  return (
    <>
      <IconButton label="Ask the assistant (g i)" onClick={() => openAssistant()} className="sm:hidden">
        <Sparkles className="size-[18px]" strokeWidth={1.75} />
      </IconButton>
      <button
        onClick={() => openAssistant()}
        title="Ask the assistant (g i)"
        className="press hidden h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-lg border border-accent/40 px-2.5 text-xs font-medium text-fg-2 hover:border-accent/70 hover:bg-accent-soft hover:text-fg sm:flex"
      >
        <Sparkles className="size-3.5 text-accent" strokeWidth={1.75} /> Ask <span className="hidden lg:inline-flex"><Kbd>g i</Kbd></span>
      </button>
    </>
  );
}

// "Explain this" for any resource, "Why is this unhealthy?" for one that isn't ok: each starts an incident-investigator
// run scoped to the resource and opens the drawer. Hidden while agents are off.
export function AskAbout({ subject, unhealthy, className, size = "sm" }: { subject: AskSubject; unhealthy: boolean; className?: string; size?: "sm" | "md" }) {
  const { off } = useAgentsStatus();
  if (off) return null;
  const go = (mode: "explain" | "why") => void ask(questionFor(mode, subject), { key: subject.key, name: subject.name });
  return (
    <div className={cx("flex flex-wrap items-center gap-2", className)}>
      {unhealthy && (
        <Button size={size} onClick={() => go("why")} className="border-accent/40 enabled:hover:!border-accent/70" title="Start an investigation of this resource: the assistant reads its status, events, logs and metrics, cites them, and prepares a safe action for a person to review.">
          <Sparkles className="size-3.5 text-accent" strokeWidth={1.75} /> Why is this unhealthy?
        </Button>
      )}
      <Button size={size} variant="ghost" onClick={() => go("explain")} title="Ask the assistant to explain this resource from what the console can read.">
        <Sparkles className="size-3.5 text-fg-3" strokeWidth={1.75} /> Explain this
      </Button>
    </div>
  );
}

// The subject of an ECS overview resource (its inventory key when the panel knows it).
export function ecsSubject(r: { kind: string; id: string; name: string; state: string }, key: string | undefined, envLabel: string | undefined): { subject: AskSubject; unhealthy: boolean } {
  const kind = r.kind === "service" ? "service" : r.kind === "box" ? "host" : r.kind === "loadbalancer" ? "load balancer" : r.kind === "cache" ? "cache" : r.kind === "database" ? "database" : r.kind;
  return {
    subject: { key, fallbackRef: key ? undefined : `${r.kind}:${r.id}`, name: r.name || r.id, kind, envLabel, stateWord: ecsStateWord(r.state) },
    unhealthy: ecsUnhealthy(r.state),
  };
}

// The subject of a cloud-map resource.
export function mapSubject(r: { key: string; name: string; health: string }, kindLabel: string, envLabel: string | undefined): { subject: AskSubject; unhealthy: boolean } {
  return { subject: { key: r.key, name: r.name, kind: kindLabel, envLabel, stateWord: mapStateWord(r.health) }, unhealthy: mapUnhealthy(r.health) };
}
