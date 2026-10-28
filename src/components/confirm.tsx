"use client";
import { AnimatePresence, motion } from "motion/react";
import { Lock, TriangleAlert } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useSWRConfig } from "swr";
import { overviewKey, trackedJson, useEnvList } from "@/lib/client/env";
import { expectedConfirm } from "@/lib/actions";
import { postJson } from "@/lib/client/api";
import { opsOf, shortSha } from "@/lib/client/format";
import type { ActionName, ActionResult, EnvName, EnvOverview, RevisionView } from "@/lib/types";
import { Modal, enter, exit } from "./motion";
import { useToast } from "./toast";
import { Button, cx } from "./ui";

interface Ask {
  title: string;
  description: ReactNode;
  danger?: boolean;
  env: EnvName;
  protectedEnv?: boolean; // production-like: shown with a warning banner
  envLabel?: string;
  expected: string; // "yes" = one click; anything else must be typed
  needReason?: boolean;
  // Database migrations between the commits: true = they changed; "unknown" = couldn't check (F07). Both need the box.
  migrations?: true | "unknown";
  migrationsWhy?: string;
  warnings?: string[]; // said first, before anything is typed (F06, R24, F68)
  undo?: string; // how to take it back ("Start restores the remembered task count")
  verifies?: string; // what "done" means ("Verified when every task runs the new revision")
  confirmLabel: string;
  run: (input: { confirm: string; reason?: string; migrationAck?: boolean }) => Promise<void>;
}

const Ctx = createContext<(a: Ask) => void>(() => {});

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  return (
    <Ctx.Provider value={setAsk}>
      {children}
      <AnimatePresence>{ask && <Dialog key={ask.title} ask={ask} close={() => setAsk(null)} />}</AnimatePresence>
    </Ctx.Provider>
  );
}

function Dialog({ ask, close }: { ask: Ask; close: () => void }) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const oneClick = ask.expected === "yes";
  const valid = (oneClick || typed === ask.expected) && (!ask.needReason || reason.trim().length >= 3) && (!ask.migrations || ack);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, close]);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await ask.run({ confirm: oneClick ? "yes" : typed, reason: reason.trim() || undefined, migrationAck: ask.migrations ? ack : undefined });
      close();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const prod = !!ask.protectedEnv;
  const field = "w-full rounded-lg border bg-panel-2 px-3 text-[14px] outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-fg-3 focus:border-accent/70 focus:shadow-[0_0_0_3px_var(--accent-soft)]";
  return (
    <Modal z="z-[90]" onClose={busy ? undefined : close} aria-labelledby="confirm-title" className="sm:max-w-md">
      <form
        className="space-y-5 px-5 pb-5 pt-3 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div>
          {prod && (
            <div className="eyebrow mb-3 flex items-center gap-1.5 !text-down">
              <Lock className="size-3" /> {ask.envLabel ?? ask.env} · protected · affects live traffic
            </div>
          )}
          <h2 id="confirm-title" className="font-display text-[26px] leading-tight">{ask.title}</h2>
          {/* Warnings come first, before anything is typed. */}
          {!!ask.warnings?.length && (
            <ul role="note" className="mt-3 space-y-1 rounded-xl border border-degraded/30 bg-degraded/8 px-3 py-2">
              {ask.warnings.map((w) => (
                <li key={w} className="flex gap-2 text-[13.5px] leading-relaxed text-degraded">
                  <TriangleAlert className="mt-[3px] size-3.5 flex-none" aria-hidden /> <span className="min-w-0 [overflow-wrap:anywhere]">{w}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 text-[14px] leading-relaxed text-fg-2">{ask.description}</div>
          {(ask.undo || ask.verifies) && (
            <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] leading-relaxed">
              {ask.verifies && (
                <>
                  <dt className="text-fg-3">Done when</dt>
                  <dd className="text-fg-2">{ask.verifies}</dd>
                </>
              )}
              {ask.undo && (
                <>
                  <dt className="text-fg-3">Undo</dt>
                  <dd className="text-fg-2">{ask.undo}</dd>
                </>
              )}
            </dl>
          )}
        </div>

        {ask.migrations && (
          <label className="flex cursor-pointer gap-2.5 rounded-xl border border-degraded/30 p-3 text-[14px] leading-relaxed">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 [--check:var(--degraded)]" />
            {ask.migrations === true ? (
              <span>
                <b className="font-medium text-degraded">Database migrations changed between these commits.</b> Rolling back code does <b className="font-medium">not</b> undo them. I understand.
              </span>
            ) : (
              <span>
                <b className="font-medium text-degraded">Couldn&apos;t check whether database migrations changed between these commits</b> ({ask.migrationsWhy ?? "the comparison wasn't available"}). Rolling back code does <b className="font-medium">not</b> undo schema changes. I understand.
              </span>
            )}
          </label>
        )}

        {!oneClick && (
          <label className="block text-[14px]">
            <span className="text-fg-2">
              Type <code className="rounded-md border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[13px] text-fg">{ask.expected}</code> to confirm
            </span>
            <input
              ref={input}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              className={cx(field, "mt-2 h-10 font-mono", typed && typed !== ask.expected ? "border-down/50" : "border-line")}
            />
          </label>
        )}

        {ask.needReason && (
          <label className="block text-[14px]">
            <span className="text-fg-2">Reason (goes to the audit log)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              ref={oneClick ? (el) => el?.focus() : undefined}
              className={cx(field, "mt-2 resize-none border-line py-2")}
              placeholder="e.g. connection pool exhausted after the 14:00 deploy"
            />
          </label>
        )}

        <AnimatePresence>
          {err && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto", transition: enter }} exit={{ opacity: 0, height: 0, transition: exit }} className="overflow-hidden">
              <div className="rounded-lg border border-down/30 px-3 py-2 text-xs text-down">{err}</div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={close} disabled={busy} className="max-sm:h-11">
            Cancel
          </Button>
          {/* Nothing to type: focus starts on the action, or on Cancel (first in the DOM) when the action is destructive. */}
          <Button type="submit" variant={ask.danger ? "danger" : "primary"} disabled={!valid || busy} data-autofocus={oneClick && !ask.needReason && !ask.migrations && !ask.danger ? true : undefined} className="max-sm:h-11">
            {busy ? "Submitting…" : ask.confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export const useConfirm = () => useContext(Ctx);

const COPY: Record<ActionName, { verb: string; danger?: boolean; text: (svc: string) => string; verifies: string; undo: (o: { current?: number }) => string }> = {
  restart: {
    verb: "Restart",
    text: (s) => `Starts fresh tasks of ${s} on the same revision. With rolling deployments there is no downtime; a single task on one host may blip briefly.`,
    verifies: "The new tasks are running and the service is steady (checked for up to 15 minutes).",
    undo: () => "Nothing to undo — the same revision keeps running.",
  },
  stop: {
    verb: "Stop",
    danger: true,
    text: (s) => `Sets the desired count to 0. ${s} stops serving (and any scheduled work it runs) until you start it again. Its task count is remembered.`,
    verifies: "No task is running.",
    undo: () => "Start restores the remembered task count.",
  },
  start: {
    verb: "Start",
    text: (s) => `Starts ${s} again with the task count it had before it was stopped (1 if unknown).`,
    verifies: "The desired number of tasks is running and the service is steady.",
    undo: () => "Stop sets the count back to 0.",
  },
  switch: {
    verb: "Switch revision",
    text: (s) => `Rolls ${s} to another task-definition revision. The circuit breaker rolls back automatically if it fails to start.`,
    verifies: "Every task runs the new revision and the service is steady.",
    undo: ({ current }) => (current ? `Switch back to rev ${current} (database changes are not undone).` : "Switch back to the previous revision (database changes are not undone)."),
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Toaster = ReturnType<typeof useToast>;
type Mutate = ReturnType<typeof useSWRConfig>["mutate"];

// "AWS accepted" is not done (REVIEW): the toast says "verifying" and follows the overview until the sampler marks
// the change verified, or says it didn't settle. The overview it reads also refreshes the page's own copy.
async function followVerification(o: { env: EnvName; service: string; operationId: string; verb: string; display: string; toast: Toaster; mutate: Mutate }) {
  const id = o.toast.push({ tone: "busy", title: `${o.verb}: AWS accepted — verifying`, body: `${o.display} · ${o.env}. Done when the service is steady on the new state.` });
  const key = overviewKey(o.env)!;
  const until = Date.now() + 16 * 60_000;
  let reported = 0; // polls that carried operation notes at all: an older server never does
  for (let n = 1; Date.now() < until; n++) {
    await sleep(n === 1 ? 4_000 : 8_000);
    let ov: EnvOverview;
    try {
      ov = await trackedJson<EnvOverview>(key); // tracked: the overview judges freshness by when it arrived
      void o.mutate(key, ov, { revalidate: false });
    } catch {
      continue;
    }
    const svc = ov.services?.find((s) => s.id === o.service);
    const notes = opsOf(svc);
    if (svc && Array.isArray((svc as { operations?: unknown }).operations)) reported++;
    const note = notes.find((x) => x.id === o.operationId);
    if (!note) {
      if (n >= 3 && !reported) return o.toast.update(id, { tone: "ok", title: `${o.verb} submitted`, body: `${o.display} · ${o.env}. Watch the service card for the rollout.` }, 6000);
      continue;
    }
    if (note.verification === "accepted") continue;
    if (note.verification === "verified") return o.toast.update(id, { tone: "ok", title: `${o.verb} verified`, body: `${o.display} · ${o.env} is steady on the new state.` }, 6000);
    return o.toast.update(
      id,
      { tone: "error", title: note.verification === "failed" ? `${o.verb} did not stabilise` : `${o.verb}: outcome unknown`, body: `${o.display} · ${o.env}${note.detail ? ` — ${note.detail}` : ""}. Check the service before retrying.` },
      15_000,
    );
  }
  o.toast.update(id, { tone: "info", title: `${o.verb} still verifying`, body: `${o.display} · ${o.env}. The service panel shows the result.` }, 8000);
}

// One hook for every service action in the UI: builds the dialog, posts, reports progress, refreshes.
export function useServiceAction() {
  const ask = useConfirm();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const envs = useEnvList().data;
  return useCallback(
    (env: EnvName, service: string, display: string, action: ActionName, target?: RevisionView & { migrationsWhy?: string }, opts?: { warnings?: string[]; currentRevision?: number }) => {
      const c = COPY[action];
      const info = envs?.find((e) => e.id === env);
      const prot = info?.protected ?? true; // unknown → strictest
      const expected = expectedConfirm(prot, action, service, env, target?.sha);
      const migrations = action === "switch" && target ? (target.migrations === true ? true : target.migrations === "unknown" ? "unknown" : undefined) : undefined;
      ask({
        env,
        protectedEnv: prot,
        envLabel: info?.label,
        title: action === "switch" && target ? `${c.verb} to rev ${target.revision} (${shortSha(target.sha)})?` : `${c.verb} ${display}?`,
        description: c.text(display),
        danger: c.danger,
        expected,
        needReason: prot,
        migrations,
        migrationsWhy: target?.migrationsWhy,
        warnings: opts?.warnings?.filter(Boolean),
        verifies: c.verifies,
        undo: c.undo({ current: opts?.currentRevision }),
        confirmLabel: c.verb,
        run: async (input) => {
          const res = await postJson<Partial<ActionResult>>(`/api/services/${env}/${service}/actions`, { action, revisionArn: target?.arn, ...input });
          mutate((k) => typeof k === "string" && (k.startsWith(`/api/overview?env=${env}`) || k.includes(`/api/services/${env}/${service}`)));
          if (res?.operationId && res.verification === "accepted") void followVerification({ env, service, operationId: res.operationId, verb: c.verb, display, toast, mutate });
          else toast.push({ tone: "ok", title: `${c.verb} submitted`, body: `${display} · ${env}. Watching rollout…` });
        },
      });
    },
    [ask, toast, mutate, envs],
  );
}

// Power for an EC2 container instance or an RDS instance (resource views of kind "box" / "database").
export function useBoxAction() {
  const ask = useConfirm();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  return useCallback(
    (r: { env: EnvName; kind: string; id: string; name: string }, action: "start" | "stop", warning?: string) => {
      const host = r.kind === "box";
      const noun = host ? "instance" : "database";
      ask({
        env: r.env,
        title: `${action === "start" ? "Start" : "Stop"} ${noun} ${r.name}?`,
        description: host
          ? action === "start"
            ? "Starts the EC2 instance. ECS places its services again once the agent reconnects (usually 2–4 minutes)."
            : "Stops the EC2 instance. Every service placed on it goes offline until it is started again."
          : action === "start"
            ? "Starts the RDS instance (usually 3–8 minutes). Start the database before the services that need it."
            : "Stops the RDS instance. Services that use it will fail until it is started. AWS auto-starts a stopped instance after 7 days.",
        danger: action === "stop",
        warnings: warning ? [warning] : undefined,
        undo: action === "stop" ? `Start the ${noun} again.` : `Stop the ${noun} again.`,
        expected: "yes",
        confirmLabel: `${action === "start" ? "Start" : "Stop"} ${noun}`,
        run: async () => {
          const res = await postJson<Partial<ActionResult>>("/api/infra/box", { env: r.env, kind: host ? "host" : "database", id: r.id, action, confirm: "yes" });
          const accepted = res?.verification === "accepted";
          toast.push({
            tone: "ok",
            title: `${noun[0].toUpperCase()}${noun.slice(1)} ${action}${accepted ? ": AWS accepted" : " submitted"}`,
            body: accepted ? "AWS took the request; the power state on the card is the confirmation (it updates within a minute)." : "Power state will update in a few seconds.",
          }, 7000);
          mutate((k) => typeof k === "string" && k.startsWith(`/api/overview?env=${r.env}`));
        },
      });
    },
    [ask, toast, mutate],
  );
}
