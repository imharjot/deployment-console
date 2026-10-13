"use client";
// Create & scale in the UI: the overview's "New" menu (copy a service, add an EC2 host, jump to what the console
// created) and the resource panel's Scale / Run task / Copy / Delete for services and Add like this / Terminate for
// hosts. Every flow is form → plan (a dry run of the very server function that will act: changes, warnings, cost) →
// confirmation → toast. Buttons are drawn with the guards the server applies (src/lib/provision.ts) — Delete and
// Terminate only appear for resources the console created — and the server checks everything again.
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ArrowLeft, Check as CheckIcon, CopyPlus, Layers, Loader2, Lock, Minus, Plus, Server, ServerCog, SquareTerminal, Trash2, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import useSWR, { useSWRConfig } from "swr";
import { postJson } from "@/lib/client/api";
import { useEnvInfo } from "@/lib/client/env";
import { usd } from "@/lib/costs";
import {
  FARGATE_CPU, addHostCheck, cloneCheck, commandProblem, deleteServiceCheck, fargateMemoryFor, fargateSizeProblem, imageProblem, instanceTypeProblem, newNameProblem,
  runTaskCheck, scaleCheck, serviceEstimate, splitCommand, terminateHostCheck, type Check, type ProvisionInfo, type ProvisionPlan, type ServiceFacts,
} from "@/lib/provision";
import type { ResourceView } from "@/lib/types";
import { Modal, Portal, enter, exit, popover, swap, usePhone } from "../motion";
import { useToast } from "../toast";
import { Button, Skeleton, cx } from "../ui";

type Kind = "clone" | "scale" | "run-task" | "add-host" | "delete-service" | "terminate-host";
export interface Flow {
  kind: Kind;
  env: string;
  service?: string; // clone: preselected source (in env); scale / run-task / delete: the service
  host?: string; // add-host: preselected source host; terminate: the host
}

const KIND: Record<Kind, { title: string; verb: string; icon: LucideIcon; danger?: boolean; form: boolean }> = {
  clone: { title: "Copy a service", verb: "Create service", icon: CopyPlus, form: true },
  scale: { title: "Scale", verb: "Scale", icon: Layers, form: true },
  "run-task": { title: "Run a one-off task", verb: "Run task", icon: SquareTerminal, form: true },
  "add-host": { title: "Add EC2 host", verb: "Launch", icon: ServerCog, form: true },
  "delete-service": { title: "Delete service", verb: "Delete service", icon: Trash2, danger: true, form: false },
  "terminate-host": { title: "Terminate host", verb: "Terminate host", icon: Trash2, danger: true, form: false },
};

const FIELD_BOX =
  "rounded-lg border border-line bg-panel-2 px-3 text-[14px] text-fg outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-fg-3 focus:border-accent/70 focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-60";
const FIELD = `w-full ${FIELD_BOX}`;
const OK: Check = { ok: true };
const INSTANCE_TYPES = ["t3a.small", "t3a.medium", "t3a.large", "t3.medium", "t4g.medium", "m7g.large", "m6i.large", "c7g.large", "r7g.large"];

// `poll`: refresh every 15 s while shown (the panel's buttons). The overview's New menu loads once and refreshes
// when it opens instead (F48): it sits on every overview, and a 15 s poll there was a request nobody looked at.
export function useProvisionInfo(env: string, sources = false, poll = true) {
  return useSWR<ProvisionInfo>(env ? `/api/provision?env=${env}${sources ? "&sources=1" : ""}` : null, { refreshInterval: poll ? 15_000 : 0, keepPreviousData: true, revalidateOnFocus: false });
}

const factsOf = (s: ProvisionInfo["services"][number]): ServiceFacts => ({ desired: s.desired, inProgress: s.inProgress, isSelf: s.self, created: s.created, hasTaskDef: s.hasTaskDef });

// Opens a resource's panel on the overview (it listens for this event and reads ?r=).
function openResource(key: string) {
  const u = new URL(window.location.href);
  u.searchParams.set("r", key);
  window.history.replaceState(null, "", u);
  window.dispatchEvent(new Event("console:open"));
}

interface Item {
  kind: Kind;
  label: string;
  hint?: string;
  enabled: boolean;
  why?: string;
  warn?: string; // enabled, but AWS will probably refuse (F06)
  danger?: boolean;
}

// One place that turns guards + roles + the console's own AWS permissions (F06) into button states, for the panel and
// the menu alike.
function item(info: ProvisionInfo, kind: Kind, label: string, perm: "provision" | "act", check: Check, extra: Partial<Item> = {}): Item {
  const denied = info.can[perm] ? undefined : `needs ${perm === "act" ? info.can.actRole : info.can.provisionRole} role`;
  const gate = info.capability?.[kind];
  const blocked = denied ?? (check.ok ? undefined : check.error) ?? (gate && !gate.enabled ? gate.why ?? "the console's AWS role can't do this" : undefined);
  return { kind, label, enabled: !blocked, why: blocked, ...(gate?.enabled && gate.warning ? { warn: gate.warning } : {}), ...extra };
}

// Console-created hosts counted against provisioning.maxHosts: joined, still joining and launches in flight (R23), as
// the server counts them; an older server only lists the joined ones.
const hostTotal = (info: ProvisionInfo) => info.hostCount?.total ?? info.hosts.filter((h) => h.created).length;

function serviceItems(info: ProvisionInfo, name: string): Item[] {
  const s = info.services.find((x) => x.name === name);
  if (!s || s.self) return []; // the console's own service: nothing to offer, like its other actions
  const f = factsOf(s);
  const list = [
    item(info, "scale", "Scale", "provision", scaleCheck(f, info.limits)),
    item(info, "run-task", "Run task", "act", runTaskCheck(f, info.limits)),
    item(info, "clone", "Copy", "provision", cloneCheck({ isSelf: s.self, hasTaskDef: s.hasTaskDef, sourceProtected: info.protected, targetProtected: info.protected, launchType: s.launchType }, info.limits)),
  ];
  if (s.created) list.push(item(info, "delete-service", "Delete", "provision", deleteServiceCheck(f), { danger: true }));
  return list;
}

function hostItems(info: ProvisionInfo, id: string): Item[] {
  const h = info.hosts.find((x) => x.id === id);
  if (!h) return [];
  const list = [item(info, "add-host", "Add host like this", "provision", addHostCheck(h, info.limits, hostTotal(info), undefined, info.hostCountDetail))];
  if (h.created) list.push(item(info, "terminate-host", "Terminate", "provision", terminateHostCheck(h), { danger: true }));
  return list;
}

// ---------- entry points ----------

// Resource panel: inline buttons from `sm`; phones get one button that opens a sheet (disabled entries still say why).
export function ProvisionActions({ r }: { r: ResourceView }) {
  const phone = usePhone();
  const { data: info } = useProvisionInfo(r.kind === "service" || r.kind === "box" ? r.env : "");
  const [flow, setFlow] = useState<Flow | null>(null);
  const [sheet, setSheet] = useState(false);
  if (!info) return null;
  const items = r.kind === "service" ? serviceItems(info, r.id) : r.kind === "box" ? hostItems(info, r.id) : [];
  if (!items.length) return null;
  const start = (k: Kind) => {
    setSheet(false);
    setFlow(r.kind === "box" ? { kind: k, env: r.env, host: r.id } : { kind: k, env: r.env, service: r.id });
  };
  const icon = (k: Kind) => {
    const I = k === "add-host" ? Plus : KIND[k].icon;
    return <I className="size-3.5" strokeWidth={1.75} />;
  };
  return (
    <>
      {phone ? (
        <Button size="sm" onClick={() => setSheet(true)} aria-haspopup="dialog" className="h-10 w-full px-3.5">
          {r.kind === "box" ? <ServerCog className="size-4" strokeWidth={1.75} /> : <Layers className="size-4" strokeWidth={1.75} />}
          {r.kind === "box" ? "Capacity" : "Scale, run & copy"}
        </Button>
      ) : (
        <div className="flex flex-wrap gap-2 border-line sm:border-l sm:pl-2">
          {items.map((a) => (
            <Button key={a.kind} size="sm" disabled={!a.enabled} title={a.why ?? a.warn} onClick={() => start(a.kind)} className={cx(a.danger && "enabled:hover:!border-down/50 enabled:hover:!text-down")}>
              {icon(a.kind)} {a.label}
            </Button>
          ))}
        </div>
      )}
      <AnimatePresence>
        {sheet && (
          <Modal onClose={() => setSheet(false)} aria-label={`${r.name}: create & scale`}>
            <div className="px-5 pb-2 pt-1 font-display text-2xl">{r.name}</div>
            <ul className="px-3 pb-4">
              {items.map((a) => (
                <li key={a.kind}>
                  <button
                    disabled={!a.enabled}
                    onClick={() => start(a.kind)}
                    className={cx("press flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[16px] enabled:hover:bg-panel-2 disabled:opacity-45", a.danger ? "text-down" : "text-fg")}
                  >
                    <span className="text-fg-3">{icon(a.kind)}</span>
                    <span className="min-w-0 flex-1">
                      {a.label}
                      {(a.enabled ? a.warn : a.why) && <span className={cx("block text-xs", a.enabled ? "text-degraded" : "text-fg-3")}>{a.enabled ? a.warn : a.why}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Modal>
        )}
      </AnimatePresence>
      <AnimatePresence>{flow && <ProvisionDialog key={`${flow.kind}:${flow.service ?? flow.host}`} flow={flow} onClose={() => setFlow(null)} />}</AnimatePresence>
    </>
  );
}

// Overview header: "New" → copy a service / add an EC2 host, plus a list of what the console created here.
export function NewResourceMenu({ env }: { env: string }) {
  const phone = usePhone();
  const { data: info, mutate: reload } = useProvisionInfo(env, false, false);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const trigger = useRef<HTMLSpanElement>(null); // wraps the button: it is where the menu anchors
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setPos(null), []);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !menu.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      trigger.current?.querySelector("button")?.focus();
    };
    window.addEventListener("keydown", onKey);
    if (!phone) {
      window.addEventListener("pointerdown", onDown);
      window.addEventListener("resize", close);
    }
    menu.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [pos, phone, close]);

  if (!info) {
    return (
      <Button size="sm" disabled>
        <Plus className="size-3.5" /> New
      </Button>
    );
  }
  if (info.kind === "compose") return null; // docker compose: nothing to copy into or add a host to
  const ec2 = info.kind === "ec2" || info.kind === "mixed";
  const existing = hostTotal(info);
  const hostCheck = info.hosts.map((h) => addHostCheck(h, info.limits, existing, undefined, info.hostCountDetail)).find((c) => c.ok) ?? (info.hosts[0] ? addHostCheck(info.hosts[0], info.limits, existing, undefined, info.hostCountDetail) : { ok: false as const, status: 409, error: "no EC2 host to copy" });
  const items = [
    item(info, "clone", "Copy a service", "provision", info.limits.enabled ? OK : { ok: false, status: 403, error: "provisioning is turned off (console.config.json → provisioning.enabled)" }, { hint: "From any environment's service, with its task definition" }),
    ...(ec2 ? [item(info, "add-host", "Add EC2 host", "provision", hostCheck, { hint: "Like one of this environment's container instances" })] : []),
  ];
  const created = [
    ...info.services.filter((s) => s.created).map((s) => ({ key: `service:${s.name}`, label: s.display, sub: `service · ${s.desired} task${s.desired === 1 ? "" : "s"}`, icon: Layers })),
    ...info.hosts.filter((h) => h.created).map((h) => ({ key: `box:${h.id}`, label: h.name, sub: `${h.type} · ${h.state}`, icon: Server })),
  ];
  const row = "press flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] text-fg-2 enabled:hover:bg-panel-3 enabled:hover:text-fg disabled:opacity-45 pointer-coarse:py-3";
  const body = (
    <>
      {items.map((a) => {
        const I = KIND[a.kind].icon;
        return (
          <button
            key={a.kind}
            role="menuitem"
            disabled={!a.enabled}
            title={a.why}
            onClick={() => {
              close();
              setFlow({ kind: a.kind, env });
            }}
            className={row}
          >
            <I className="mt-0.5 size-4 flex-none text-fg-3" strokeWidth={1.75} />
            <span className="min-w-0">
              <span className="block font-medium text-fg">{a.label}</span>
              <span className={cx("block text-[12.5px] leading-snug", a.enabled && a.warn ? "text-degraded" : "text-fg-3")}>{a.enabled ? (a.warn ?? a.hint) : a.why}</span>
            </span>
          </button>
        );
      })}
      {created.length > 0 && (
        <>
          <div className="my-1 h-px bg-line" />
          <div className="eyebrow px-2.5 pb-1 pt-1.5">Created by the console</div>
          {created.map((c) => (
            <button
              key={c.key}
              role="menuitem"
              onClick={() => {
                close();
                openResource(c.key);
              }}
              className={cx(row, "items-center")}
            >
              <c.icon className="size-3.5 flex-none text-fg-3" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate text-fg">{c.label}</span>
              <span className="flex-none text-[12px] text-fg-3">{c.sub}</span>
            </button>
          ))}
        </>
      )}
    </>
  );
  const toggle = () => {
    if (pos) return close();
    void reload(); // fresh guards and "created by the console" each time the menu opens
    const b = trigger.current!.getBoundingClientRect();
    setPos({ top: b.bottom + 8, right: Math.max(8, window.innerWidth - b.right), width: 300 });
  };
  return (
    <>
      <span ref={trigger} className="inline-flex">
        <Button size="sm" onClick={toggle} aria-haspopup="menu" aria-expanded={!!pos} title="Copy a service or add capacity">
          <Plus className="size-3.5" /> New
        </Button>
      </span>
      {phone ? (
        <AnimatePresence>
          {pos && (
            <Modal onClose={close} z="z-[80]" aria-label="New">
              <div ref={menu} role="menu" className="p-2 pb-3">
                {body}
              </div>
            </Modal>
          )}
        </AnimatePresence>
      ) : (
        <Portal>
          <AnimatePresence>
            {pos && (
              <motion.div ref={menu} {...popover} role="menu" aria-label="New" style={{ ...pos, transformOrigin: "top right" }} className="fixed z-[80] rounded-xl border border-line bg-panel p-1.5 text-left shadow-float">
                {body}
              </motion.div>
            )}
          </AnimatePresence>
        </Portal>
      )}
      <AnimatePresence>{flow && <ProvisionDialog key={flow.kind} flow={flow} onClose={() => setFlow(null)} />}</AnimatePresence>
    </>
  );
}

// ---------- the dialog: form → plan → confirm ----------

function ProvisionDialog({ flow, onClose }: { flow: Flow; onClose(): void }) {
  const k = KIND[flow.kind];
  const { data: info, error } = useProvisionInfo(flow.env, flow.kind === "clone");
  const envInfo = useEnvInfo(flow.env);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const [step, setStep] = useState<"form" | "review">(k.form ? "form" : "review");
  const [body, setBody] = useState<Record<string, unknown> | null>(null);
  const [plan, setPlan] = useState<ProvisionPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Capture phase: Esc closes only this dialog, not the panel underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      if (!busy) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const review = useCallback(
    async (b: Record<string, unknown>) => {
      setBusy(true);
      setErr(null);
      try {
        const p = await postJson<ProvisionPlan>(`/api/provision/${flow.kind}?dryRun=1`, b);
        setBody(b);
        setPlan(p);
        setStep("review");
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [flow.kind],
  );

  // Deletes have nothing to fill in: go straight to the plan.
  const started = useRef(false);
  useEffect(() => {
    if (k.form || started.current) return;
    started.current = true;
    void review(flow.kind === "terminate-host" ? { env: flow.env, id: flow.host } : { env: flow.env, service: flow.service });
  }, [k.form, flow, review]);

  const confirm = async (input: { confirm: string; reason?: string }) => {
    if (!body || !plan) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await postJson<Record<string, unknown>>(`/api/provision/${flow.kind}`, { ...body, ...input });
      done(flow, body, res);
      void mutate((key) => typeof key === "string" && (key.startsWith(`/api/overview?env=${flow.env}`) || key.startsWith(`/api/provision?env=${flow.env}`) || key.includes(`/api/services/${flow.env}/`)));
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const done = (f: Flow, b: Record<string, unknown>, res: Record<string, unknown>) => {
    if (f.kind === "clone") {
      const name = String(b.name);
      toast.push({ tone: "ok", title: `Creating ${name}`, body: `${f.env} · ${b.desired ? "first rollout starting" : "created with 0 tasks — start it when ready"}` });
      openResource(`service:${name}`);
    } else if (f.kind === "scale") toast.push({ tone: "ok", title: `Scaling ${f.service} to ${b.desired}`, body: `${f.env}. Tasks start or stop over the next minute.` });
    else if (f.kind === "run-task") {
      const logs = res.logs as { group: string; stream?: string } | undefined;
      toast.push(
        { tone: "ok", title: `Task ${String(res.taskId ?? "").slice(0, 12)} started`, body: logs ? `Logs: ${logs.group}${logs.stream ? ` · ${logs.stream}` : ""}` : "Its output goes wherever the container logs.", link: logs ? { href: `/logs?env=${f.env}&service=${f.service}`, label: "Open logs" } : undefined },
        12_000,
      );
    } else if (f.kind === "add-host") toast.push({ tone: "ok", title: `Launching ${(res.instanceIds as string[] | undefined)?.length ?? b.count} EC2 host${b.count === 1 ? "" : "s"}`, body: `${((res.instanceIds as string[] | undefined) ?? []).join(", ")} · they join the cluster in a few minutes.` });
    else if (f.kind === "delete-service") toast.push({ tone: "ok", title: `Deleting ${f.service}`, body: `${f.env}. Its tasks stop within a minute.` });
    else toast.push({ tone: "ok", title: `Terminating ${f.host}`, body: `${f.env}. ECS drops it from the cluster once it is gone.` });
  };

  const I = k.icon;
  const subject = flow.service ?? flow.host;
  return (
    <Modal onClose={busy ? undefined : onClose} aria-labelledby="provision-title" className="sm:max-w-lg">
      <header className="flex flex-none items-center gap-3 border-b border-line px-5 pb-3.5 pt-1 sm:pt-4">
        <I className={cx("size-4", k.danger ? "text-down" : "text-fg-3")} strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <h2 id="provision-title" className="truncate font-display text-2xl leading-tight">{k.title}</h2>
          <div className="truncate font-mono text-[12px] text-fg-3">
            {flow.env}
            {subject && flow.kind !== "clone" && flow.kind !== "add-host" ? ` · ${subject}` : ""}
          </div>
        </div>
        <button onClick={onClose} disabled={busy} className="press grid size-8 flex-none place-items-center rounded-lg text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:size-10" aria-label="Close">
          <X className="size-4" />
        </button>
      </header>
      {error ? (
        <div className="p-5 text-[14px] text-down">{(error as Error).message}</div>
      ) : !info || (step === "review" && !plan && !err) ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <>
          {/* The form stays mounted (hidden) during the review, so Back returns to exactly what was typed. */}
          {k.form && (
            <div className={cx("flex min-h-0 flex-1 flex-col", step !== "form" && "hidden")}>
              <FormStep flow={flow} info={info} shell={{ busy, err: step === "form" ? err : null, onCancel: onClose, onReview: review }} />
            </div>
          )}
          <AnimatePresence initial={false}>
            {step === "review" && (
              <motion.div key="review" {...swap} exit={{ opacity: 0, transition: { duration: 0 } }} className="flex min-h-0 flex-1 flex-col">
                {plan ? (
                  <ReviewStep
                    plan={plan}
                    danger={!!k.danger}
                    verb={k.verb}
                    protectedEnv={info.protected}
                    envLabel={envInfo?.label ?? flow.env}
                    busy={busy}
                    err={err}
                    onBack={
                      k.form
                        ? () => {
                            setStep("form");
                            setErr(null);
                          }
                        : undefined
                    }
                    onCancel={onClose}
                    onConfirm={confirm}
                  />
                ) : (
                  <div className="space-y-4 p-5">
                    <ErrorBox err={err} />
                    <div className="flex justify-end">
                      <Button variant="ghost" onClick={onClose}>Close</Button>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </Modal>
  );
}

function ErrorBox({ err }: { err: string | null }) {
  return (
    <AnimatePresence>
      {err && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto", transition: enter }} exit={{ opacity: 0, height: 0, transition: exit }} className="overflow-hidden">
          <div role="alert" className="rounded-lg border border-down/30 px-3 py-2 text-xs text-down">{err}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <label className="block text-[14px]">
      <span className="text-fg-2">{label}</span>
      <div className="mt-1.5">{children}</div>
      {error ? <p className="mt-1 text-xs text-down [overflow-wrap:anywhere]">{error}</p> : hint ? <p className="mt-1 text-xs leading-relaxed text-fg-3 [overflow-wrap:anywhere]">{hint}</p> : null}
    </label>
  );
}

// Whole numbers with −/+ buttons that stay usable on a phone.
function Count({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange(n: number): void; label: string }) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const step = "press grid size-10 flex-none place-items-center rounded-lg border border-line bg-panel text-fg-2 enabled:hover:border-line-strong enabled:hover:text-fg disabled:opacity-40 sm:size-9";
  return (
    <div className="flex items-center gap-2">
      <button type="button" className={step} onClick={() => onChange(clamp(value - 1))} disabled={value <= min} aria-label={`Fewer ${label}`}>
        <Minus className="size-3.5" />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Math.trunc(Number(e.target.value)))}
        aria-label={label}
        className={cx(FIELD_BOX, "h-10 w-20 text-center tabular-nums sm:h-9")}
      />
      <button type="button" className={step} onClick={() => onChange(clamp((Number.isFinite(value) ? value : min) + 1))} disabled={value >= max} aria-label={`More ${label}`}>
        <Plus className="size-3.5" />
      </button>
      <span className="text-xs text-fg-3">max {max}</span>
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <footer className="flex flex-none flex-col-reverse gap-2 border-t border-line px-5 py-3 sm:flex-row sm:items-center sm:justify-end">{children}</footer>;
}

interface ShellProps {
  busy: boolean;
  err: string | null;
  onCancel(): void;
  onReview(b: Record<string, unknown>): void;
}

// A form's frame: scrolling fields, the error, and a footer whose "Review plan" is enabled once the body is valid.
function Shell({ body, problem, busy, err, onCancel, onReview, children }: ShellProps & { body?: Record<string, unknown>; problem?: string; children: ReactNode }) {
  const ref = useRef<HTMLFormElement>(null);
  // Keyboard users land in the first field when the dialog opens.
  useEffect(() => ref.current?.querySelector<HTMLElement>("select, input")?.focus(), []);
  return (
    <form
      ref={ref}
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (body && !problem && !busy) onReview(body);
      }}
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-5">
        {children}
        <ErrorBox err={err} />
      </div>
      <Footer>
        {problem && <span className="text-xs text-fg-3 max-sm:text-center sm:mr-auto">{problem}</span>}
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy} className="max-sm:h-11">Cancel</Button>
        <Button type="submit" variant="primary" disabled={!body || !!problem || busy} className="max-sm:h-11">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {busy ? "Checking…" : "Review plan"}
        </Button>
      </Footer>
    </form>
  );
}

type FormProps = { flow: Flow; info: ProvisionInfo; shell: ShellProps };

function FormStep({ flow, info, shell }: FormProps) {
  if (flow.kind === "clone") return <CloneForm flow={flow} info={info} shell={shell} />;
  if (flow.kind === "scale") return <ScaleForm flow={flow} info={info} shell={shell} />;
  if (flow.kind === "run-task") return <RunTaskForm flow={flow} info={info} shell={shell} />;
  return <AddHostForm flow={flow} info={info} shell={shell} />;
}

const gone = (shell: ShellProps) => (
  <Shell {...shell} problem="this service is gone">
    <p className="text-[14px] text-down">This service no longer exists.</p>
  </Shell>
);

function CloneForm({ flow, info, shell }: FormProps) {
  const sources = info.sources ?? [];
  const initial = sources.find((s) => s.env === flow.env && s.name === flow.service) ?? sources.find((s) => s.env === flow.env) ?? sources[0];
  const taken = info.services.map((s) => s.name);
  const suggest = (base: string) => {
    let n = `${base}-copy`;
    for (let i = 2; taken.includes(n); i++) n = `${base}-copy-${i}`;
    return n.slice(0, 255);
  };
  const [src, setSrc] = useState(initial ? `${initial.env}/${initial.name}` : "");
  const [name, setName] = useState(initial ? suggest(initial.name) : "");
  const [touched, setTouched] = useState(false);
  const [desired, setDesired] = useState(initial && initial.env !== flow.env ? 0 : 1);
  const [image, setImage] = useState("");
  const [cpu, setCpu] = useState(0); // 0 = the source's
  const [memory, setMemory] = useState(0);
  const source = sources.find((s) => `${s.env}/${s.name}` === src);
  const fargate = source?.launchType === "FARGATE";
  const effCpu = cpu || source?.cpu || 0;
  const effMem = memory || source?.memory || 0;

  const pick = (key: string) => {
    const s = sources.find((x) => `${x.env}/${x.name}` === key);
    setSrc(key);
    setCpu(0);
    setMemory(0);
    if (s) {
      if (!touched) setName(suggest(s.name));
      setDesired(s.env !== flow.env ? 0 : 1);
    }
  };
  const envs = [...new Set(sources.map((s) => s.env))];
  const srcCheck = source ? cloneCheck({ isSelf: source.self, hasTaskDef: true, sourceProtected: source.protected, targetProtected: info.protected, launchType: source.launchType }, info.limits) : OK;
  const nameErr = name ? newNameProblem(name, taken) : undefined;
  const imageErr = image.trim() ? imageProblem(image.trim()) : undefined;
  const desiredErr = !Number.isInteger(desired) || desired < 0 || desired > info.limits.maxTasks ? `0–${info.limits.maxTasks} tasks` : undefined;
  const sizeErr = fargate && (cpu || memory) ? fargateSizeProblem(effCpu, effMem) : undefined;
  const problem = !source ? "pick a service to copy" : !srcCheck.ok ? srcCheck.error : !name ? "name the new service" : (nameErr ?? imageErr ?? desiredErr ?? sizeErr);
  const est = source && Number.isInteger(desired) ? serviceEstimate(source.launchType, effCpu || undefined, effMem || undefined, Math.max(0, desired)) : undefined;
  const body = source ? { env: flow.env, sourceEnv: source.env, source: source.name, name, desired, image: image.trim() || undefined, cpu: cpu || undefined, memory: memory || undefined } : undefined;

  if (!sources.length) {
    return (
      <Shell {...shell} problem="nothing to copy">
        <p className="text-[14px] text-fg-2">No service in this region can be copied (the console never copies itself).</p>
      </Shell>
    );
  }
  return (
    <Shell {...shell} body={body} problem={problem}>
      <Field label="Service to copy" error={!srcCheck.ok ? srcCheck.error : undefined} hint={source ? `${source.launchType === "FARGATE" ? "Fargate" : source.launchType}${source.cpu && source.memory ? ` · ${source.cpu / 1024} vCPU · ${source.memory / 1024} GB` : ""} · ${source.image?.split("/").pop() ?? ""}` : undefined}>
        <select value={src} onChange={(e) => pick(e.target.value)} className={cx(FIELD, "h-10 px-2.5 sm:h-9")}>
          {envs.map((e) => (
            <optgroup key={e} label={`${sources.find((s) => s.env === e)?.envLabel ?? e}${e === flow.env ? " (this environment)" : ""}`}>
              {sources.filter((s) => s.env === e).map((s) => (
                <option key={`${e}/${s.name}`} value={`${e}/${s.name}`}>{s.display === s.name ? s.name : `${s.display} (${s.name})`}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      <Field label={`New service name in ${flow.env}`} error={nameErr} hint="Also the name of its task-definition family.">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value.trim());
            setTouched(true);
          }}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          className={cx(FIELD, "h-10 font-mono sm:h-9", nameErr && "border-down/50")}
        />
      </Field>
      <Field label="Tasks" error={desiredErr} hint={source && source.env !== flow.env ? "Copied across environments: start with 0, check its variables, then start it." : "0 creates it stopped."}>
        <Count value={desired} min={0} max={info.limits.maxTasks} onChange={setDesired} label="tasks" />
      </Field>
      <Field label="Image (optional)" error={imageErr} hint="A full image URI with a tag or digest. Empty: the source's image.">
        <input value={image} onChange={(e) => setImage(e.target.value)} placeholder={source?.image ?? "registry/repo:tag"} spellCheck={false} autoComplete="off" autoCapitalize="off" className={cx(FIELD, "h-10 font-mono text-[13px] sm:h-9", imageErr && "border-down/50")} />
      </Field>
      {fargate && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="CPU" error={sizeErr}>
            <select
              value={cpu}
              onChange={(e) => {
                const c = Number(e.target.value);
                setCpu(c);
                const mems = fargateMemoryFor(c || source?.cpu || 0);
                if (mems.length && !mems.includes(memory || source?.memory || 0)) setMemory(mems[0]);
              }}
              className={cx(FIELD, "h-10 px-2.5 sm:h-9")}
            >
              <option value={0}>Same as source{source?.cpu ? ` (${source.cpu / 1024} vCPU)` : ""}</option>
              {FARGATE_CPU.map((c) => <option key={c} value={c}>{c / 1024} vCPU ({c})</option>)}
            </select>
          </Field>
          <Field label="Memory">
            <select value={memory} onChange={(e) => setMemory(Number(e.target.value))} className={cx(FIELD, "h-10 px-2.5 sm:h-9")}>
              <option value={0}>Same as source{source?.memory ? ` (${source.memory / 1024} GB)` : ""}</option>
              {fargateMemoryFor(effCpu).map((m) => <option key={m} value={m}>{m / 1024} GB</option>)}
            </select>
          </Field>
        </div>
      )}
      {est && (
        <p className="text-xs text-fg-3">
          {est.monthlyUsd > 0 ? <>About <span className="font-medium tabular-nums text-fg-2">{usd(est.monthlyUsd)}/month</span> at list price — the plan has the estimate with your pricing.</> : est.note}
        </p>
      )}
    </Shell>
  );
}

function ScaleForm({ flow, info, shell }: FormProps) {
  const s = info.services.find((x) => x.name === flow.service);
  const [desired, setDesired] = useState(Math.min(info.limits.maxTasks, (s?.desired ?? 0) + 1));
  if (!s) return gone(shell);
  const check = scaleCheck(factsOf(s), info.limits, desired);
  const per = serviceEstimate(s.launchType, s.cpu, s.memory, 1);
  return (
    <Shell {...shell} body={{ env: flow.env, service: s.name, desired }} problem={check.ok ? undefined : check.error}>
      <p className="text-[14px] leading-relaxed text-fg-2">
        <span className="font-medium text-fg">{s.display}</span> runs <span className="tabular-nums">{s.desired}</span> task{s.desired === 1 ? "" : "s"} now. Scaling changes the count without a new deployment; stop and start stay in the regular actions.
      </p>
      <Field label="Desired tasks" error={check.ok ? undefined : check.error}>
        <Count value={desired} min={1} max={info.limits.maxTasks} onChange={setDesired} label="tasks" />
      </Field>
      {per.monthlyUsd > 0 && Number.isInteger(desired) && desired !== s.desired && (
        <p className="text-xs text-fg-3">
          {desired > s.desired ? "+" : "−"}
          <span className="font-medium tabular-nums text-fg-2">{usd(Math.abs(per.monthlyUsd * (desired - s.desired)))}/month</span> at Fargate list price.
        </p>
      )}
    </Shell>
  );
}

function RunTaskForm({ flow, info, shell }: FormProps) {
  const s = info.services.find((x) => x.name === flow.service);
  const [container, setContainer] = useState(s?.main ?? s?.containers[0] ?? "");
  const [command, setCommand] = useState("");
  if (!s) return gone(shell);
  const split = command.trim() ? splitCommand(command) : null;
  const cmdErr = !split ? undefined : !split.ok ? split.error : commandProblem(split.args);
  const check = runTaskCheck(factsOf(s), info.limits);
  const args = split?.ok ? split.args : undefined;
  return (
    <Shell {...shell} body={{ env: flow.env, service: s.name, ...(args ? { container, command: args } : {}) }} problem={!check.ok ? check.error : cmdErr}>
      <p className="text-[14px] leading-relaxed text-fg-2">
        Starts one task of <span className="font-medium text-fg">{s.display}</span>&apos;s current task definition with its networking, variables and role — for a migration, a smoke test or a script. It isn&apos;t restarted when it exits.
      </p>
      {s.containers.length > 1 && (
        <Field label="Container">
          <select value={container} onChange={(e) => setContainer(e.target.value)} className={cx(FIELD, "h-10 px-2.5 font-mono text-[13px] sm:h-9")}>
            {s.containers.map((c) => <option key={c} value={c}>{c}{c === s.main ? " (main)" : ""}</option>)}
          </select>
        </Field>
      )}
      <Field label="Command (optional)" error={cmdErr} hint="Empty runs the image's own command. Quotes group words; nothing is expanded — start with sh -c '…' if you need a shell. Don't put secrets here: ECS and CloudTrail show it.">
        <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm run db:migrate" spellCheck={false} autoComplete="off" autoCapitalize="off" className={cx(FIELD, "h-10 font-mono text-[13px] sm:h-9", cmdErr && "border-down/50")} />
      </Field>
      {args && !cmdErr && (
        <div className="flex flex-wrap gap-1" aria-label="Arguments">
          {args.map((a, i) => <code key={i} className="rounded-md border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[12.5px] text-fg-2">{a || " "}</code>)}
        </div>
      )}
    </Shell>
  );
}

function AddHostForm({ flow, info, shell }: FormProps) {
  const hosts = info.hosts;
  const existing = hostTotal(info);
  const detail = info.hostCountDetail;
  const [from, setFrom] = useState(flow.host ?? hosts.find((h) => !h.asg)?.id ?? hosts[0]?.id ?? "");
  const [count, setCount] = useState(1);
  const [type, setType] = useState("");
  const h = hosts.find((x) => x.id === from);
  const allowed = info.limits.allowedInstanceTypes;
  const room = Math.max(1, info.limits.maxHosts - existing);
  const check = h ? addHostCheck(h, info.limits, existing, count, detail) : ({ ok: false, status: 404, error: "pick a host to copy" } as Check);
  const eff = type || h?.type || "";
  const typeErr = eff ? instanceTypeProblem(eff, allowed) : undefined;
  return (
    <Shell {...shell} body={h ? { env: flow.env, from: h.id, count, instanceType: type || undefined } : undefined} problem={!check.ok ? check.error : typeErr}>
      <Field label="Launch like" error={h?.asg && !check.ok ? check.error : undefined} hint={h ? `${h.type} · ${h.state}${h.launchTemplate ? ` · from launch template ${h.launchTemplate}` : " · AMI, subnet, security groups, profile and user data are copied"}` : undefined}>
        <select value={from} onChange={(e) => setFrom(e.target.value)} className={cx(FIELD, "h-10 px-2.5 sm:h-9")}>
          {hosts.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.id}){x.asg ? " · Auto Scaling" : ""}</option>)}
        </select>
      </Field>
      <Field label="How many" error={h && !h.asg && !check.ok ? check.error : undefined} hint={`At most ${info.limits.maxHosts} console-created hosts per environment (${existing} now${detail ? ` — ${detail}` : ""}).`}>
        <Count value={count} min={1} max={room} onChange={setCount} label="hosts" />
      </Field>
      <Field label="Instance type" error={typeErr} hint={allowed?.length ? "Limited by provisioning.allowedInstanceTypes." : "Empty: the same type as the source host."}>
        {allowed?.length ? (
          <select value={type} onChange={(e) => setType(e.target.value)} className={cx(FIELD, "h-10 px-2.5 font-mono text-[13px] sm:h-9")}>
            <option value="">Same as source{h ? ` (${h.type})` : ""}</option>
            {allowed.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        ) : (
          <>
            <input value={type} onChange={(e) => setType(e.target.value.trim())} list="provision-instance-types" placeholder={h?.type ?? "t3a.medium"} spellCheck={false} autoComplete="off" autoCapitalize="off" className={cx(FIELD, "h-10 font-mono text-[13px] sm:h-9", typeErr && "border-down/50")} />
            <datalist id="provision-instance-types">{INSTANCE_TYPES.map((t) => <option key={t} value={t} />)}</datalist>
          </>
        )}
      </Field>
    </Shell>
  );
}

function ReviewStep({ plan, danger, verb, protectedEnv, envLabel, busy, err, onBack, onCancel, onConfirm }: {
  plan: ProvisionPlan; danger: boolean; verb: string; protectedEnv: boolean; envLabel: string; busy: boolean; err: string | null;
  onBack?: () => void; onCancel(): void; onConfirm(i: { confirm: string; reason?: string }): void;
}) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const one = plan.confirm.expected === "yes";
  const valid = (one || typed === plan.confirm.expected) && (!plan.confirm.needReason || reason.trim().length >= 3);
  // Focus what the person has to do next: type the name, give a reason, or just confirm.
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>(!one ? "input" : plan.confirm.needReason ? "textarea" : "button[type=submit]")?.focus();
  }, [one, plan.confirm.needReason]);
  const est = plan.estimate;
  return (
    <form
      ref={formRef}
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) onConfirm({ confirm: one ? "yes" : typed, reason: reason.trim() || undefined });
      }}
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-5">
        {protectedEnv && (
          <div className="eyebrow flex items-center gap-1.5 !text-down">
            <Lock className="size-3" /> {envLabel} · protected · affects live traffic
          </div>
        )}
        <p className={cx("text-[16px] font-medium leading-snug", danger && "text-down")}>{plan.summary}</p>
        <ul className="space-y-1.5">
          {plan.changes.map((c) => (
            <li key={c} className="flex gap-2 text-[14px] leading-relaxed text-fg-2">
              <CheckIcon className="mt-[3px] size-3.5 flex-none text-fg-3" strokeWidth={2} />
              <span className="min-w-0 break-words">{c}</span>
            </li>
          ))}
        </ul>
        {plan.warnings.length > 0 && (
          <ul className="space-y-1.5 rounded-xl border border-degraded/30 bg-degraded/8 p-3">
            {plan.warnings.map((w) => (
              <li key={w} className="flex gap-2 text-xs leading-relaxed text-degraded">
                <AlertTriangle className="mt-px size-3.5 flex-none" />
                <span className="min-w-0 break-words">{w}</span>
              </li>
            ))}
          </ul>
        )}
        {est && (
          <div className="rounded-xl border border-line bg-panel-2 px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="eyebrow">Estimate</span>
              <span className="text-[16px] font-medium tabular-nums">
                {est.monthlyUsd === 0 ? "no added cost" : `${est.monthlyUsd < 0 ? "−" : plan.action === "scale" ? "+" : ""}${usd(Math.abs(est.monthlyUsd))}/month`}
              </span>
            </div>
            <p className="mt-1 text-[12.5px] leading-snug text-fg-3">{est.note}</p>
          </div>
        )}
        {!one && (
          <label className="block text-[14px]">
            <span className="text-fg-2">
              Type <code className="rounded-md border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[13px] text-fg">{plan.confirm.expected}</code> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              className={cx(FIELD, "mt-2 h-10 font-mono", typed && typed !== plan.confirm.expected && "border-down/50")}
            />
          </label>
        )}
        {plan.confirm.needReason && (
          <label className="block text-[14px]">
            <span className="text-fg-2">Reason (goes to the audit log)</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className={cx(FIELD, "mt-2 resize-none py-2")} placeholder={danger ? "e.g. canary finished, no longer needed" : "e.g. load test for the checkout release"} />
          </label>
        )}
        <ErrorBox err={err} />
      </div>
      <Footer>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack} disabled={busy} className="max-sm:h-11 sm:mr-auto">
            <ArrowLeft className="size-3.5" /> Back
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy} className="max-sm:h-11">Cancel</Button>
        <Button type="submit" variant={danger ? "danger" : "primary"} disabled={!valid || busy} className="max-sm:h-11">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {busy ? "Submitting…" : verb}
        </Button>
      </Footer>
    </form>
  );
}
