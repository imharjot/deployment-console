"use client";
import { AnimatePresence, motion } from "motion/react";
import { CircleDot, Hash, ListChecks, Loader2, Plug, SquareKanban, Ticket, TicketPlus, Webhook, X, Zap, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { postJson } from "@/lib/client/api";
import type { IntegrationView } from "@/lib/plugins/types";
import type { CiJob, CiRun, ResourceView, TestReport } from "@/lib/types";
import { EASE, EASE_IN, Modal } from "./motion";
import { useToast } from "./toast";
import { Button, Skeleton, cx } from "./ui";

// Plugins name a lucide icon; only these are bundled. Unknown names fall back to a plug.
const ICONS: Record<string, LucideIcon> = { hash: Hash, webhook: Webhook, "circle-dot": CircleDot, ticket: Ticket, zap: Zap, "list-checks": ListChecks, "square-kanban": SquareKanban };
export function IntegrationIcon({ name, className }: { name: string; className?: string }) {
  const I = ICONS[name] ?? Plug;
  return <I className={className} />;
}

// Dialog motion for pages that build their own dialog shell (prefer <Modal> from ./motion, which also
// becomes a bottom sheet on phones): fade + settle from 97%, no travel.
export const dialogMotion = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.28, ease: EASE } },
  exit: { opacity: 0, scale: 0.985, transition: { duration: 0.16, ease: EASE_IN } },
};
export const scrimMotion = { initial: { opacity: 0 }, animate: { opacity: 1, transition: { duration: 0.24 } }, exit: { opacity: 0, transition: { duration: 0.16 } } };

export interface IntegrationList {
  admin: boolean;
  integrations: IntegrationView[];
  eventTypes: { value: string; label: string }[];
  envs: { id: string; label: string; protected: boolean }[];
}

// ---------- prefills (markdown; every plugin renders or tolerates it) ----------

const origin = () => (typeof window === "undefined" ? "" : window.location.origin);
const fence = (s: string) => `\`\`\`\n${s}\n\`\`\``;

export function resourceTicket(r: Pick<ResourceView, "key" | "kind" | "env" | "name" | "state" | "reasons" | "sha" | "commit" | "checkedAt">) {
  const lines = [`**${r.name}** (${r.kind}) is **${r.state}** in **${r.env}**.`, ""];
  if (r.reasons.length) lines.push("Reasons:", ...r.reasons.map((x) => `- ${x}`), "");
  if (r.commit) lines.push(`- Commit: [${r.commit.sha.slice(0, 7)}](${r.commit.url}) ${r.commit.title} (${r.commit.author})`);
  else if (r.sha) lines.push(`- Commit: \`${r.sha.slice(0, 7)}\``);
  lines.push(`- Checked: ${new Date(r.checkedAt).toISOString()}`, `- Console: ${origin()}/?env=${encodeURIComponent(r.env)}&r=${r.key.split(":").map(encodeURIComponent).join(":")}`);
  return { title: `${r.name} is ${r.state} in ${r.env}`, body: lines.join("\n") };
}

export function logTicket(line: string, ts: number, stream: string, env?: string) {
  const service = stream.split("/")[1] ?? stream;
  const link = env ? `${origin()}/logs?env=${encodeURIComponent(env)}&service=${encodeURIComponent(service)}` : undefined;
  const body = [fence(line.length > 4_000 ? `${line.slice(0, 4_000)} …(+${line.length - 4_000} chars)` : line), "", `- Time: ${new Date(ts).toISOString()}`, `- Service: ${service}`, ...(env ? [`- Environment: ${env}`] : []), `- Stream: ${stream}`, ...(link ? [`- Logs: ${link}`] : [])];
  return { title: line.replace(/\s+/g, " ").trim().slice(0, 120) || "Log line", body: body.join("\n") };
}

export function ciTicket(run: Pick<CiRun, "title" | "workflow" | "branch" | "sha" | "actor" | "url" | "repo">, jobs?: CiJob[], tests?: TestReport | null) {
  const lines = [`CI run **${run.workflow}** failed on \`${run.branch}\` at \`${run.sha.slice(0, 7)}\` (${run.repo}, by ${run.actor}).`, ""];
  const failed = (jobs ?? []).filter((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
  if (failed.length) {
    lines.push("Failed jobs:");
    for (const j of failed) lines.push(`- ${j.name}${j.steps.some((s) => s.conclusion === "failure") ? ` → step: ${j.steps.filter((s) => s.conclusion === "failure").map((s) => s.name).join(", ")}` : ""}`);
    lines.push("");
  }
  if (tests?.failures.length) {
    lines.push(`Failed tests (${tests.failed} of ${tests.total}):`, ...tests.failures.slice(0, 20).map((f) => `- ${f.suite ? `${f.suite} › ` : ""}${f.name}`), "");
  }
  lines.push(`- GitHub run: ${run.url}`, `- Console: ${origin()}/ci`);
  return { title: `CI failed: ${run.title}`, body: lines.join("\n") };
}

const LAST = "console.ticket.integration";
const MAX_BODY = 8_000;

interface Props {
  title: string;
  body: string; // markdown, prefilled and editable
  env?: string;
  target?: string;
  size?: "sm" | "md";
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
}

// Hidden for roles without tickets:create. Opens a dialog to file the prefilled ticket in an enabled integration.
export function CreateTicketButton({ title, body, env, target, size = "sm", variant = "secondary", className }: Props) {
  const { data: me } = useSWR<{ perms?: string[] }>("/api/me");
  const [open, setOpen] = useState(false);
  if (!me?.perms?.includes("tickets:create")) return null;
  return (
    <>
      <Button size={size} variant={variant} className={className} onClick={() => setOpen(true)} title="Create a ticket in Jira, Linear, GitHub…">
        <TicketPlus className="size-3.5" /> Ticket
      </Button>
      <AnimatePresence>{open && <TicketDialog key="ticket" title={title} body={body} env={env} target={target} admin={!!me.perms?.includes("admin")} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

function TicketDialog({ title: initialTitle, body: initialBody, env, target, admin, onClose }: Omit<Props, "size" | "variant" | "className"> & { admin: boolean; onClose(): void }) {
  const { data, error } = useSWR<IntegrationList>("/api/integrations");
  const options = data?.integrations.filter((i) => i.enabled && i.capabilities.includes("tickets")) ?? [];
  const [picked, setPicked] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST);
    } catch {
      return null;
    }
  });
  const choice = options.find((o) => o.id === picked) ?? options[0];
  const [title, setTitle] = useState(initialTitle.slice(0, 250));
  const [body, setBody] = useState(initialBody.slice(0, MAX_BODY));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const titleRef = useRef<HTMLInputElement>(null);

  // Capture phase on window runs before the panels' own Escape handlers, so Esc closes only this dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      if (!busy) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);
  useEffect(() => titleRef.current?.focus(), [choice?.id]);

  async function create() {
    if (!choice || busy || !title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const t = await postJson<{ id: string; url: string }>("/api/tickets", { integration: choice.id, title, body, env, target });
      try {
        localStorage.setItem(LAST, choice.id);
      } catch {
        /* storage blocked */
      }
      toast.push({ tone: "ok", title: `${choice.name} ticket created`, body: t.id, link: { href: t.url, label: "Open ticket" } }, 10_000);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal z="z-[95]" onClose={busy ? undefined : onClose} aria-labelledby="ticket-title" className="sm:max-w-xl">
      <header className="flex flex-none items-center gap-3 border-b border-line px-5 pb-3.5 pt-1 sm:pt-4">
        <TicketPlus className="size-4 text-fg-3" strokeWidth={1.75} />
        <h2 id="ticket-title" className="flex-1 font-display text-2xl leading-tight">Create ticket</h2>
        <button onClick={onClose} disabled={busy} className="press grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:size-10" aria-label="Close">
          <X className="size-4" />
        </button>
      </header>

      {!data && !error ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-9" />
          <Skeleton className="h-40" />
        </div>
      ) : error ? (
        <div className="p-5 text-[14px] text-down">{(error as Error).message}</div>
      ) : !options.length ? (
        <div className="space-y-2 p-5 text-[14px] text-fg-2">
          <p className="font-medium text-fg">No ticket integration is enabled.</p>
          {admin ? (
            <p>
              Connect Jira, Linear, GitHub Issues, ClickUp or Asana in{" "}
              <Link href="/settings/integrations" onClick={onClose} className="font-medium text-accent hover:underline">
                Settings → Integrations
              </Link>
              .
            </p>
          ) : (
            <p>Ask an admin to connect Jira, Linear, GitHub Issues, ClickUp or Asana in Settings → Integrations.</p>
          )}
        </div>
      ) : (
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Integration">
              {options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={choice?.id === o.id}
                  onClick={() => setPicked(o.id)}
                  className={cx(
                    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[14px] font-medium transition-colors",
                    choice?.id === o.id ? "border-accent/50 bg-accent-soft text-accent" : "border-line text-fg-2 hover:border-line-strong hover:text-fg",
                  )}
                >
                  <IntegrationIcon name={o.icon} className="size-3.5" />
                  {o.name}
                </button>
              ))}
            </div>
            <label className="block text-[14px]">
              <span className="text-fg-2">Title</span>
              <input
                ref={titleRef}
                value={title}
                maxLength={250}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1.5 h-10 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14px] outline-none transition-[border-color,box-shadow] duration-200 focus:border-accent/70 focus:shadow-[0_0_0_3px_var(--accent-soft)]"
              />
            </label>
            <label className="block text-[14px]">
              <span className="flex items-center justify-between text-fg-2">
                Description <span className="text-[12px] text-fg-3">markdown · {body.length.toLocaleString()}/{MAX_BODY.toLocaleString()}</span>
              </span>
              <textarea
                value={body}
                maxLength={MAX_BODY}
                onChange={(e) => setBody(e.target.value)}
                rows={12}
                spellCheck={false}
                className="mt-1.5 w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-[13px] leading-relaxed outline-none transition-[border-color,box-shadow] duration-200 focus:border-accent/70 focus:shadow-[0_0_0_3px_var(--accent-soft)] max-sm:min-h-40"
              />
            </label>
            <AnimatePresence>
              {err && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="rounded-lg border border-down/30 px-3 py-2 text-xs text-down">
                  {err}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <footer className="flex flex-none items-center justify-end gap-2 border-t border-line px-5 py-3">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !title.trim() || !choice}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <TicketPlus className="size-3.5" />}
              {busy ? "Creating…" : `Create in ${choice?.name ?? "…"}`}
            </Button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
