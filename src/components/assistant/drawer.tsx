"use client";
// The assistant drawer (master plan §6 C9, AGENT_ARCHITECTURE §10): "Explain why this service is unhealthy, show the
// evidence, and prepare a safe action for review." Ask a question with a model connection (the last one used; the
// scripted demo model with the simulated account) → POST /api/assistant → an incident-investigator run, followed live
// in the Automation UI's <RunView compact> (/api/events?run=, replayed after a reconnect): the answer with its
// citations, the evidence with ages, a proposed change as a plan card with "Review in Approvals" or approve / reject
// here, and the AI / AWS / health outcomes kept apart. Text that looks like a secret is never sent.
//
// It is a modal sheet (one Escape closes it; the page under it waits). Its body carries role="dialog" aria-modal, so
// panels underneath that close on Escape (the ECS and map resource panels) leave the key to it.
import { Bot, BotOff, ChevronDown, CornerDownLeft, Loader2, Maximize2, OctagonAlert, RotateCcw, Sparkles, SquarePen, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import { RunView } from "../agents/run-view";
import { Sheet } from "../motion";
import { Button, Chip, IconButton, Skeleton, cx } from "../ui";
import { useMe } from "../user-menu";
import { getJson } from "@/lib/client/api";
import { trackedJson, useEnvList } from "@/lib/client/env";
import { useRegions } from "@/lib/client/region";
import { ecsNoteTarget } from "@/lib/notes";
import { RunBoundary } from "./boundary";
import { ProposalDecision } from "./decide";
import { MAX_QUESTION, checkQuestion, ecsStateWord, normalizeConnections, pickConnection, questionFor, type ThreadEntry } from "./model";
import { OFF_TEXT, ecsSubject, useAgentsStatus } from "./status";
import { ask, chooseConnection, clearContext, clearThread, retry, useAssistant } from "./store";

export default function AssistantDrawer({ onClose }: { onClose(): void }) {
  const { thread } = useAssistant();
  const { off, stop } = useAgentsStatus();
  const scroller = useRef<HTMLDivElement>(null);
  // A new question scrolls into view; after that the person reads at their own pace.
  const newest = thread[thread.length - 1]?.key;
  useEffect(() => {
    const el = scroller.current;
    if (el && newest) el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [newest]);

  return (
    <Sheet onClose={onClose} as="aside" z="z-[70]" aria-label="Assistant" className="flex h-full w-full flex-col overflow-hidden border-l border-line bg-panel shadow-float sm:w-[560px] sm:rounded-l-2xl">
      <div role="dialog" aria-modal="true" aria-labelledby="assistant-title" className="flex min-h-0 flex-1 flex-col">
        <header className="flex flex-none items-start justify-between gap-3 border-b border-line px-4 pb-3.5 pt-[max(1rem,env(safe-area-inset-top))] sm:px-5">
          <div className="min-w-0">
            <h2 id="assistant-title" className="flex items-center gap-2 font-display text-[26px] leading-tight">
              <Sparkles className="size-[18px] text-accent" strokeWidth={1.75} aria-hidden /> Assistant
            </h2>
            <p className="mt-0.5 text-xs text-fg-3">Answers cite what the console read. Changes wait for a person.</p>
          </div>
          <div className="flex flex-none items-center gap-0.5">
            {thread.length > 0 && (
              <IconButton label="New conversation" onClick={clearThread}>
                <SquarePen className="size-4" strokeWidth={1.75} />
              </IconButton>
            )}
            <Link href="/assistant" onClick={onClose} aria-label="Open the assistant page (history)" title="Open the assistant page (history)" className="press grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:size-10">
              <Maximize2 className="size-4" strokeWidth={1.75} />
            </Link>
            <IconButton label="Close (Esc)" onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          </div>
        </header>
        {stop && (
          <p role="status" className="flex flex-none items-start gap-2 border-b border-down/25 bg-down/8 px-4 py-2 text-[13.5px] leading-5 text-fg-2 sm:px-5">
            <OctagonAlert className="mt-0.5 size-3.5 flex-none text-down" strokeWidth={1.75} aria-hidden />
            <span>
              <b className="font-medium text-down">Emergency stop is on.</b> The assistant can still investigate and propose, but nothing can change until an admin turns the stop off.
            </span>
          </p>
        )}
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {off ? <Off /> : thread.length ? (
            <ol aria-label="Conversation" className="space-y-7">
              {thread.map((e) => (
                <Entry key={e.key} e={e} />
              ))}
            </ol>
          ) : (
            <Welcome />
          )}
        </div>
        {!off && (
          <footer className="flex-none space-y-2 border-t border-line px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
            <Composer />
            <ConnectionPicker />
          </footer>
        )}
      </div>
    </Sheet>
  );
}

function Entry({ e }: { e: ThreadEntry }) {
  return (
    <li className="space-y-3">
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-panel-3 px-3.5 py-2.5 text-[14px] leading-relaxed text-fg">
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{e.question}</p>
          {e.resourceName && (
            <div className="mt-1.5">
              <Chip mono tone="muted">about {e.resourceName}</Chip>
            </div>
          )}
        </div>
      </div>
      {e.error ? (
        <div role="alert" className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border border-down/25 bg-down/6 px-3 py-2.5 text-[13.5px] leading-relaxed text-down">
          <span className="min-w-0 flex-1 basis-56 [overflow-wrap:anywhere]">{e.error}</span>
          {e.code !== "refused" && (
            <Button size="sm" onClick={() => retry(e.key)}>
              <RotateCcw className="size-3.5" /> Try again
            </Button>
          )}
        </div>
      ) : !e.runId ? (
        <div role="status" className="flex items-center gap-2 text-[13.5px] text-fg-3">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Starting the investigation…
        </div>
      ) : (
        <RunBoundary runId={e.runId}>
          <RunView runId={e.runId} compact proposalActions={(p) => <ProposalDecision proposal={p} runId={e.runId!} />} />
        </RunBoundary>
      )}
    </li>
  );
}

interface IssueLike {
  env?: unknown;
  envLabel?: unknown;
  key?: unknown;
  name?: unknown;
  state?: unknown;
  kind?: unknown;
}

// What to ask first: the problems the sampler sees right now (the shell's /api/issues, same request), plus a general
// question. Clicking one asks it — scoped to the resource's inventory key, like the panels' "Why is this unhealthy?".
function Welcome() {
  const issues = useSWR<IssueLike[]>("/api/issues", trackedJson, { refreshInterval: 10_000, keepPreviousData: true }).data;
  const envs = useEnvList().data;
  const home = useRegions().data?.home;
  const list = (Array.isArray(issues) ? issues : [])
    .filter((x) => typeof x.key === "string" && typeof x.name === "string" && typeof x.state === "string" && typeof x.kind === "string" && x.kind !== "env" && x.key !== "env")
    .slice(0, 3)
    .map((x) => {
      const [key, name, state, kind] = [x.key as string, x.name as string, x.state as string, x.kind as string];
      const env = envs?.find((e) => e.id === x.env);
      const r = { kind, id: key.slice(key.indexOf(":") + 1), name, state, subtitle: "" }; // an overview key is "<kind>:<id>"
      const target = ecsNoteTarget(r, env?.cluster, env?.region, home);
      const { subject } = ecsSubject(r, target?.key, typeof x.envLabel === "string" ? x.envLabel : env?.label);
      return {
        text: questionFor("why", subject),
        about: target ? { key: target.key, name: subject.name } : undefined,
        label: `Why is ${name}${subject.envLabel ? ` in ${subject.envLabel}` : ""} ${ecsStateWord(state)}?`,
      };
    });
  const suggestions: { text: string; label: string; about?: { key: string; name: string } }[] = [
    ...list,
    { text: "What needs attention right now? Look at every environment and tell me what is unhealthy and why.", label: "What needs attention right now?" },
  ];
  return (
    <div className="space-y-6 py-6">
      <div className="grid place-items-center gap-2 text-center">
        <span className="grid size-11 place-items-center rounded-2xl border border-accent/30 bg-accent-soft text-accent">
          <Sparkles className="size-5" strokeWidth={1.5} aria-hidden />
        </span>
        <div className="font-display text-2xl">Ask about your services</div>
        <p className="max-w-sm text-[13.5px] leading-relaxed text-fg-3">
          It reads status, events, logs and metrics through the console&apos;s own operations, cites what it read, and prepares a change for a person to approve. It never changes anything on its own and never sees secret values.
        </p>
      </div>
      <ul aria-label="Suggested questions" className="space-y-2">
        {suggestions.map((s) => (
          <li key={s.label}>
            <button
              onClick={() => void ask(s.text, s.about)}
              className="press flex w-full items-center gap-2.5 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-left text-[14px] text-fg-2 hover:border-line-strong hover:bg-panel-2 hover:text-fg pointer-coarse:min-h-11"
            >
              <Sparkles className="size-3.5 flex-none text-accent" strokeWidth={1.75} aria-hidden />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{s.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Off() {
  const admin = useMe().data?.user?.role === "admin";
  return (
    <div className="grid place-items-center gap-2 py-16 text-center">
      <BotOff className="size-6 text-fg-3" strokeWidth={1.5} aria-hidden />
      <div className="font-display text-2xl">Agents are turned off</div>
      <p className="max-w-sm text-[13.5px] leading-relaxed text-fg-3">{OFF_TEXT}</p>
      {admin && (
        <Link href="/automation#agents" className="mt-1 text-[14px] font-medium text-accent hover:underline">
          Open Automation → Agents
        </Link>
      )}
    </div>
  );
}

function Composer() {
  const { context } = useAssistant();
  const [text, setText] = useState("");
  const id = useId();
  const check = checkQuestion(text);
  const problem = !check.empty ? check.message : undefined;
  const send = () => {
    if (!check.ok) return;
    void ask(text);
    setText("");
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className="space-y-2"
    >
      {context && (
        <div className="flex items-center gap-1.5 text-[12.5px] text-fg-3">
          About
          <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-line bg-panel-2 py-px pl-1.5 pr-0.5 font-mono text-fg-2">
            <span className="max-w-[16rem] truncate" title={context.key}>{context.name}</span>
            <button type="button" onClick={clearContext} aria-label={`Stop asking about ${context.name}`} className="grid size-5 place-items-center rounded text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:size-8">
              <X className="size-3" />
            </button>
          </span>
        </div>
      )}
      <div
        className={cx(
          "flex items-end gap-2 rounded-xl border bg-panel-2 p-1.5 pl-3 transition-[border-color,box-shadow] duration-200 focus-within:shadow-[0_0_0_3px_var(--accent-soft)]",
          problem ? "border-down/50 focus-within:border-down/60" : "border-line focus-within:border-accent/70",
        )}
      >
        <label htmlFor={`${id}-q`} className="sr-only">Ask the assistant</label>
        <textarea
          id={`${id}-q`}
          data-autofocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          maxLength={MAX_QUESTION + 200}
          spellCheck
          aria-invalid={!!problem}
          aria-describedby={`${id}-hint`}
          placeholder={context ? `Ask about ${context.name}…` : "Why is a service unhealthy? What changed? What should I check?"}
          className="max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-relaxed text-fg outline-none [field-sizing:content] placeholder:text-fg-3"
        />
        <Button type="submit" variant="primary" size="sm" disabled={!check.ok} aria-label="Send" title="Send (Enter · Shift+Enter for a new line)" className="mb-0.5 h-8 px-3 pointer-coarse:h-10">
          <CornerDownLeft className="size-3.5" /> <span className="max-sm:hidden">Send</span>
        </Button>
      </div>
      <div id={`${id}-hint`} aria-live="polite" className="text-[12.5px] leading-relaxed">
        {problem ? (
          <p role="alert" className="text-down">
            {problem}{" "}
            {check.secrets.length > 0 && (
              <Link href="/docs/environment-variables" className="font-medium underline underline-offset-2">How variables work</Link>
            )}
          </p>
        ) : (
          <p className="sr-only">Enter sends, Shift+Enter starts a new line. Never paste secrets.</p>
        )}
      </div>
    </form>
  );
}

const connectionsKey = ["assistant-connections", "/api/agents/connections"] as const;
const fetchConnections = async ([, url]: readonly [string, string]) => normalizeConnections(await getJson<unknown>(url));

// The model connection to ask with, and who pays for it. Personal connections are their owner's only; the server
// re-checks every use.
function ConnectionPicker() {
  const { connectionId } = useAssistant();
  const { data, error } = useSWR(connectionsKey, fetchConnections, { revalidateOnFocus: false });
  if (!data) {
    return error ? (
      <p className="text-[12.5px] text-fg-3">Couldn&apos;t load model connections: {(error as Error).message}</p>
    ) : (
      <Skeleton className="h-8 w-56" />
    );
  }
  const chosen = pickConnection(data, connectionId);
  if (!chosen) {
    return (
      <p className="text-[13px] text-degraded">
        No model connection you can use.{" "}
        <Link href="/automation#connections" className="font-medium text-accent hover:underline">Add one in Automation → Connections</Link>.
      </p>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2.5 text-[12.5px] text-fg-3">
      <label title="The model connection this question runs on" className="relative inline-flex h-8 min-w-0 max-w-[60%] flex-none items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-fg-2 hover:border-line-strong pointer-coarse:h-10">
        <Bot className="size-3.5 flex-none text-fg-3" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 truncate">{chosen.label}</span>
        <ChevronDown className="size-3 flex-none text-fg-3" aria-hidden />
        <select aria-label="Model connection" value={chosen.id} onChange={(e) => chooseConnection(e.target.value)} className="absolute inset-0 cursor-pointer appearance-none opacity-0">
          {data.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.usable}>
              {c.label}
              {c.providerLabel ? ` · ${c.providerLabel}` : ""}
              {!c.usable && c.why ? ` (${c.why})` : ""}
            </option>
          ))}
        </select>
      </label>
      {chosen.payer && (
        <span className="min-w-0 flex-1 truncate" title={`Who pays: ${chosen.payer}`}>
          Pays: {chosen.payer}
        </span>
      )}
    </div>
  );
}
