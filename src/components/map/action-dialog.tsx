"use client";
// Run one inventory action (deploy code, purge a queue, invalidate a CDN path…) on one resource:
// form (generated from the action's JSON Schema) → plan (POST /api/inventory/action with dryRun: true) → review →
// confirmation (useConfirm: the resource name and a reason when the action is dangerous or the environment is
// protected, one click otherwise) → run → toast, and the map refreshes. The server checks everything again.
// A plan may carry `echo` (the state it was made against): the run sends it back, and the server refuses when the
// resource moved since — the dialog then plans again. Inputs with several ways to give the same thing (a .zip upload,
// a .zip in S3, a container image) group their fields (`x-group` / `x-groups`): one group at a time (F42).
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ArrowLeft, Check as CheckIcon, FileUp, Loader2, Lock, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useSWRConfig } from "swr";
import { ApiError, postJson } from "@/lib/client/api";
import type { ActionInfo, Resource } from "@/lib/inventory/types";
import { useConfirm } from "../confirm";
import { Modal, enter, exit, swap } from "../motion";
import { useToast } from "../toast";
import { Button, Skeleton, cx } from "../ui";
import { formSchema, groupsFor, hasFields, type Schema } from "./action-form";
import { INVENTORY_KEY } from "./data";
import { Select } from "@/components/select";

// The JSON Schema subset actions use, and which fields a person fills in: ./action-form.ts.
export { formSchema, groupsFor, type Schema, type XGroup } from "./action-form";

export interface ActionPlan {
  summary: string;
  echo?: Record<string, unknown>; // sent back with the confirmation: the state the plan was made against
  changes?: string[];
  warnings?: string[];
  estimate?: { monthlyUsd: number; note: string };
  confirm?: string | { expected: string; needReason?: boolean };
}

type FieldKind = "string" | "text" | "number" | "integer" | "boolean" | "enum" | "list" | "json" | "file";
type FileValue = { name: string; size: number; b64: string };
type Value = string | boolean | FileValue | null;

const FILE_DEFAULT_MAX = 5 * 1024 * 1024;
const FIELD =
  "w-full rounded-lg border border-line bg-panel-2 px-3 text-[14px] text-fg outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-fg-3 focus:border-accent/70 focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-60";

export function fieldKind(name: string, s: Schema): FieldKind {
  if (/Base64$/.test(name) && (!s.type || s.type === "string")) return "file";
  if (s.enum?.length) return "enum";
  switch (s.type) {
    case "boolean":
      return "boolean";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "array":
      return s.items?.type === "string" && !s.items.enum ? "list" : "json";
    case "string":
      // Keys, paths and URIs (≤ a few KB) stay one line; only long free text gets a textarea.
      return (s.maxLength ?? 0) > 4096 || /\n/.test(String(s.default ?? "")) ? "text" : "string";
    default:
      return "json";
  }
}

export const humanize = (name: string) => {
  if (name === "zipBase64") return "Code package (.zip)";
  if (name === "contentBase64") return "File";
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const fileMax = (s: Schema) => (s.maxLength ? Math.floor((s.maxLength * 3) / 4) : FILE_DEFAULT_MAX);
const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function initial(name: string, s: Schema): Value {
  const k = fieldKind(name, s);
  const d = s.default;
  if (k === "boolean") return typeof d === "boolean" ? d : false;
  if (k === "file") return null;
  if (d === undefined || d === null) return "";
  if (k === "list") return Array.isArray(d) ? d.join("\n") : String(d);
  if (k === "json") return JSON.stringify(d, null, 2);
  return String(d);
}

// Values → the action's input, with one message per invalid field. Empty optional fields are left out.
export function toInput(schema: Schema, values: Record<string, Value>): { input: Record<string, unknown>; errors: Record<string, string> } {
  const input: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const req = new Set(schema.required ?? []);
  for (const [name, s] of Object.entries(schema.properties ?? {})) {
    const k = fieldKind(name, s);
    const v = values[name];
    const empty = v === null || v === undefined || (typeof v === "string" && v.trim() === "");
    if (k === "boolean") {
      input[name] = !!v;
      continue;
    }
    if (empty) {
      if (req.has(name)) errors[name] = k === "file" ? "Choose a file" : "Required";
      continue;
    }
    if (k === "file") {
      input[name] = (v as FileValue).b64;
      continue;
    }
    const text = String(v);
    if (k === "integer" || k === "number") {
      const n = Number(text);
      if (!Number.isFinite(n) || (k === "integer" && !Number.isInteger(n))) errors[name] = k === "integer" ? "A whole number" : "A number";
      else if (s.minimum !== undefined && n < s.minimum) errors[name] = `At least ${s.minimum}`;
      else if (s.maximum !== undefined && n > s.maximum) errors[name] = `At most ${s.maximum}`;
      else input[name] = n;
      continue;
    }
    if (k === "enum") {
      const opt = s.enum!.find((o) => String(o) === text);
      if (opt === undefined) errors[name] = "Pick one of the options";
      else input[name] = opt;
      continue;
    }
    if (k === "list") {
      const items = text.split("\n").map((x) => x.trim()).filter(Boolean);
      if (s.maxItems !== undefined && items.length > s.maxItems) errors[name] = `At most ${s.maxItems} lines`;
      else if (s.items?.pattern && items.some((x) => !new RegExp(s.items!.pattern!).test(x))) errors[name] = `Each line must match ${s.items.pattern}`;
      else input[name] = items;
      continue;
    }
    if (k === "json") {
      try {
        input[name] = JSON.parse(text);
      } catch {
        errors[name] = "Not valid JSON";
      }
      continue;
    }
    if (s.minLength !== undefined && text.length < s.minLength) errors[name] = `At least ${s.minLength} characters`;
    else if (s.maxLength !== undefined && text.length > s.maxLength) errors[name] = `At most ${s.maxLength} characters`;
    else if (s.pattern && !new RegExp(s.pattern).test(text)) errors[name] = `Must match ${s.pattern}`;
    else input[name] = text;
  }
  return { input, errors };
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error ?? new Error("could not read the file"));
    fr.onload = () => {
      const s = String(fr.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    fr.readAsDataURL(file);
  });
}

function summarize(result: unknown): string | undefined {
  if (result === null || result === undefined) return undefined;
  if (typeof result !== "object") return String(result);
  const parts = Object.entries(result as Record<string, unknown>)
    .filter(([k, v]) => v !== null && v !== undefined && typeof v !== "object" && k !== "url")
    .slice(0, 3)
    .map(([k, v]) => `${humanize(k).toLowerCase()}: ${String(v)}`);
  return parts.length ? parts.join(" · ") : undefined;
}

// A result that carries a link (S3 download-object → { url }) opens in a new tab and is never shown inline.
function linkOf(result: unknown): string | undefined {
  const url = (result as { url?: unknown } | null)?.url;
  return typeof url === "string" && /^https:\/\//.test(url) ? url : undefined;
}
function openInNewTab(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ActionDialog({ r, action, env, initial: preset, onClose }: { r: Resource; action: ActionInfo; env?: { label: string; protected: boolean }; initial?: Record<string, unknown>; onClose(): void }) {
  const full = useMemo(() => ((action.input ?? {}) as Schema), [action.input]);
  const groups = useMemo(() => groupsFor(full, r.props), [full, r.props]);
  const [group, setGroup] = useState<string | undefined>(() => groups[0]?.id);
  const schema = useMemo(() => formSchema(full, group), [full, group]);
  const fields = Object.entries(schema.properties ?? {});
  const hasForm = hasFields(full);
  const [step, setStep] = useState<"form" | "review">(hasForm ? "form" : "review");
  const [values, setValues] = useState<Record<string, Value>>(() =>
    Object.fromEntries(Object.entries(full.properties ?? {}).map(([n, s]) => [n, preset && n in preset ? initial(n, { ...s, default: preset[n] }) : initial(n, s)])),
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [sent, setSent] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [replanned, setReplanned] = useState(false);
  const ask = useConfirm();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const danger = action.risk === "danger";
  const prot = !!env?.protected;
  const { input, errors } = useMemo(() => toInput(schema, values), [schema, values]);
  const valid = !Object.keys(errors).length;

  // Esc closes this dialog (not the panel under it), unless the confirmation above it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.getElementById("confirm-title")) return;
      e.stopImmediatePropagation();
      if (!busy) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const review = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setErr(null);
      try {
        const res = await postJson<{ plan?: ActionPlan } & Partial<ActionPlan>>("/api/inventory/action", { key: r.key, provider: action.provider, action: action.id, input: body, dryRun: true });
        const p = res.plan ?? (typeof res.summary === "string" ? (res as ActionPlan) : null);
        if (!p) throw new Error("The server returned no plan for this action.");
        setSent(body);
        setPlan(p);
        setStep("review");
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [r.key, action.provider, action.id],
  );

  // Nothing to fill in: go straight to the plan.
  const started = useRef(false);
  useEffect(() => {
    if (hasForm || started.current) return;
    started.current = true;
    void review({});
  }, [hasForm, review]);

  const run = () => {
    if (!plan || !sent) return;
    const c = plan.confirm;
    const server = typeof c === "string" ? c : c?.expected;
    const strict = danger || prot;
    const expected = server && server !== "yes" ? server : strict ? r.name : "yes";
    const needReason = (typeof c === "object" && !!c?.needReason) || strict;
    ask({
      env: r.env ?? "",
      protectedEnv: prot,
      envLabel: env?.label ?? r.env ?? "Shared",
      title: `${action.title}?`,
      description: (
        <>
          <span className="font-medium text-fg">{r.name}</span> · {plan.summary}
        </>
      ),
      danger,
      expected,
      needReason,
      confirmLabel: action.title,
      run: async ({ confirm, reason }) => {
        let res: { result?: unknown; operationId?: string; approval?: { id?: string } };
        try {
          res = await postJson<{ result?: unknown; operationId?: string; approval?: { id?: string } }>("/api/inventory/action", { key: r.key, provider: action.provider, action: action.id, input: { ...sent, ...(plan.echo ?? {}) }, confirm, reason });
        } catch (e) {
          const msg = (e as Error).message;
          // The resource changed since the plan (protection, revision…): plan again and show the new one.
          if (e instanceof ApiError && e.status === 409 && /dry run again|changed since|plan again/i.test(msg)) {
            setReplanned(true);
            void review(sent);
            return;
          }
          if ((e instanceof ApiError && e.code === "outcome_unknown") || /outcome unknown/i.test(msg))
            throw new Error(`Outcome unknown — AWS may have made the change. Check the resource before retrying.${e instanceof ApiError && e.operationId ? ` (operation ${e.operationId})` : ""}`);
          throw e;
        }
        const link = linkOf(res?.result);
        const op = res?.operationId ? ` · operation ${res.operationId}` : "";
        if (res?.approval) toast.push({ tone: "info", title: "Sent for approval", body: `${action.title} on ${r.name} waits for an approver (Automation → Approvals).` }, 8000);
        else if (link) {
          openInNewTab(link);
          toast.push({ tone: "ok", title: "Download link ready", body: "It opened in a new tab and expires in a few minutes. Blocked? Use the link below.", link: { href: link, label: "Open the download" } }, 15_000);
        } else toast.push({ tone: "ok", title: `${action.title}: AWS accepted`, body: `${summarize(res?.result) ?? `${r.name}${r.env ? ` · ${env?.label ?? r.env}` : ""}`}${op}${action.verifies ? ` · done when: ${action.verifies}` : ""}` }, 8000);
        void mutate((k) => typeof k === "string" && (k === INVENTORY_KEY || k.startsWith(`/api/inventory/detail?key=${encodeURIComponent(r.key)}`) || k.startsWith(`/api/inventory/actions?key=${encodeURIComponent(r.key)}`)));
        onClose();
      },
    });
  };

  return (
    <Modal z="z-[85]" onClose={busy ? undefined : onClose} aria-labelledby="map-action-title" className="sm:max-w-lg">
      <header className="flex flex-none items-center gap-3 border-b border-line px-5 pb-3.5 pt-1 sm:pt-4">
        <div className="min-w-0 flex-1">
          <h2 id="map-action-title" className={cx("truncate font-display text-2xl leading-tight", danger && "text-down")}>{action.title}</h2>
          <div className="truncate font-mono text-[12px] text-fg-3">
            {r.name} · {env?.label ?? r.env ?? "Shared"}
          </div>
        </div>
        <button onClick={onClose} disabled={busy} className="press grid size-8 flex-none place-items-center rounded-lg text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:size-10" aria-label="Close">
          <X className="size-4" />
        </button>
      </header>

      {/* The form stays mounted (hidden) during the review, so Back returns to exactly what was typed. */}
      {hasForm && (
        <form
          className={cx("flex min-h-0 flex-1 flex-col", step !== "form" && "hidden")}
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(Object.fromEntries(fields.map(([n]) => [n, true])));
            setReplanned(false);
            if (valid && !busy) void review(input);
          }}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-5">
            <p className="text-[14px] leading-relaxed text-fg-2">{action.summary ?? action.description}</p>
            {(action.note || action.warning) && (
              <p className="flex gap-1.5 rounded-lg border border-degraded/30 bg-degraded/8 px-3 py-2 text-xs leading-relaxed text-degraded">
                <AlertTriangle className="mt-px size-3.5 flex-none" /> {action.warning ?? action.note}
              </p>
            )}
            {groups.length > 1 && (
              <fieldset className="space-y-1.5">
                <legend className="text-[14px] text-fg-2">How</legend>
                <div className="flex flex-wrap gap-1.5">
                  {groups.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      aria-pressed={group === g.id}
                      onClick={() => setGroup(g.id)}
                      className={cx("press h-9 rounded-lg border px-3 text-[14px] pointer-coarse:h-10", group === g.id ? "border-accent/50 bg-accent-soft text-fg" : "border-line bg-panel text-fg-2 hover:border-line-strong hover:text-fg")}
                    >
                      {g.title}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            {groups.length === 1 && <p className="text-xs text-fg-3">{groups[0].title}</p>}
            {fields.map(([name, s], i) => (
              <SchemaField
                key={name}
                name={name}
                s={s}
                required={!!schema.required?.includes(name)}
                value={values[name]}
                error={touched[name] ? errors[name] : undefined}
                autoFocus={i === 0}
                onChange={(v) => {
                  setValues((x) => ({ ...x, [name]: v }));
                  setTouched((t) => ({ ...t, [name]: true }));
                }}
                onBlur={() => setTouched((t) => ({ ...t, [name]: true }))}
                onFileError={(m) => setErr(m)}
              />
            ))}
            <ErrorBox err={step === "form" ? err : null} />
          </div>
          <Footer>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="max-sm:h-11">Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy || (!valid && Object.keys(touched).length > 0)} className="max-sm:h-11">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {busy ? "Planning…" : "Review plan"}
            </Button>
          </Footer>
        </form>
      )}

      <AnimatePresence initial={false}>
        {step === "review" && (
          <motion.div key="review" {...swap} exit={{ opacity: 0, transition: { duration: 0 } }} className="flex min-h-0 flex-1 flex-col">
            {plan ? (
              <>
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-5">
                  {prot && (
                    <div className="eyebrow flex items-center gap-1.5 !text-down">
                      <Lock className="size-3" /> {env?.label ?? r.env} · protected
                    </div>
                  )}
                  {replanned && <p className="rounded-lg border border-degraded/30 bg-degraded/8 px-3 py-2 text-xs text-degraded">The resource changed since the last plan. This is a new plan: check it and confirm again.</p>}
                  <p className={cx("text-[16px] font-medium leading-snug", danger && "text-down")}>{plan.summary}</p>
                  {!!plan.changes?.length && (
                    <ul className="space-y-1.5">
                      {plan.changes.map((c) => (
                        <li key={c} className="flex gap-2 text-[14px] leading-relaxed text-fg-2">
                          <CheckIcon className="mt-[3px] size-3.5 flex-none text-fg-3" strokeWidth={2} />
                          <span className="min-w-0 break-words">{c}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!!plan.warnings?.length && (
                    <ul className="space-y-1.5 rounded-xl border border-degraded/30 bg-degraded/8 p-3">
                      {plan.warnings.map((w) => (
                        <li key={w} className="flex gap-2 text-xs leading-relaxed text-degraded">
                          <AlertTriangle className="mt-px size-3.5 flex-none" />
                          <span className="min-w-0 break-words">{w}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {plan.estimate && (
                    <div className="rounded-xl border border-line bg-panel-2 px-3 py-2.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="eyebrow">Estimate</span>
                        <span className="text-[16px] font-medium tabular-nums">
                          {plan.estimate.monthlyUsd === 0 ? "no added cost" : `${plan.estimate.monthlyUsd < 0 ? "−" : "+"}$${Math.abs(plan.estimate.monthlyUsd).toFixed(2)}/month`}
                        </span>
                      </div>
                      <p className="mt-1 text-[12.5px] leading-snug text-fg-3">{plan.estimate.note}</p>
                    </div>
                  )}
                  {(action.undo || action.verifies) && (
                    <dl className="space-y-1 text-xs leading-relaxed text-fg-2">
                      {action.undo && (
                        <div>
                          <dt className="inline font-medium text-fg">Undo: </dt>
                          <dd className="inline">{action.undo}</dd>
                        </div>
                      )}
                      {action.verifies && (
                        <div>
                          <dt className="inline font-medium text-fg">Done when: </dt>
                          <dd className="inline">{action.verifies}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                  <p className="text-xs text-fg-3">
                    Nothing has changed yet. {danger || prot ? "You'll type the resource name and a reason next." : "You'll confirm once more next."}
                  </p>
                </div>
                <Footer>
                  {hasForm && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setStep("form");
                        setErr(null);
                      }}
                      className="max-sm:h-11 sm:mr-auto"
                    >
                      <ArrowLeft className="size-3.5" /> Back
                    </Button>
                  )}
                  <Button type="button" variant="ghost" onClick={onClose} className="max-sm:h-11">Cancel</Button>
                  <Button type="button" variant={danger ? "danger" : "primary"} onClick={run} data-autofocus className="max-sm:h-11">
                    {action.title}…
                  </Button>
                </Footer>
              </>
            ) : err ? (
              <div className="space-y-4 p-5">
                <ErrorBox err={err} />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={onClose}>Close</Button>
                  <Button onClick={() => void review({})}>Try again</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3 p-5" aria-busy>
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-10" />
                <Skeleton className="h-16" />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <footer className="flex flex-none flex-col-reverse gap-2 border-t border-line px-5 py-3 sm:flex-row sm:items-center sm:justify-end">{children}</footer>;
}

function ErrorBox({ err }: { err: string | null }) {
  return (
    <AnimatePresence>
      {err && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto", transition: enter }} exit={{ opacity: 0, height: 0, transition: exit }} className="overflow-hidden">
          <div role="alert" className="rounded-lg border border-down/30 px-3 py-2 text-xs text-down [overflow-wrap:anywhere]">{err}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SchemaField({ name, s, required, value, error, autoFocus, onChange, onBlur, onFileError }: {
  name: string;
  s: Schema;
  required: boolean;
  value: Value;
  error?: string;
  autoFocus?: boolean;
  onChange(v: Value): void;
  onBlur(): void;
  onFileError(msg: string | null): void;
}) {
  const id = useId();
  const k = fieldKind(name, s);
  const label = s.title ?? humanize(name);
  const hint = s.description;
  const describedBy = `${id}-hint`;
  const common = { id, onBlur, autoFocus, "aria-invalid": !!error || undefined, "aria-describedby": describedBy };
  const errCls = error ? "border-down/50" : "";
  let control: ReactNode;
  if (k === "boolean") {
    return (
      <label className="flex cursor-pointer items-start gap-2.5 text-[14px]">
        <input type="checkbox" {...common} checked={!!value} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
        <span>
          <span className="text-fg">{label}</span>
          {hint && <span id={describedBy} className="mt-0.5 block text-xs leading-relaxed text-fg-3">{hint}</span>}
        </span>
      </label>
    );
  }
  if (k === "enum") {
    control = (
      <Select
        {...common}
        value={String(value ?? "")}
        onChange={(v) => onChange(v)}
        base={cx(FIELD, "h-10 sm:h-9", errCls)}
        options={[...(required ? [] : [{ value: "", label: "—" }]), ...s.enum!.map((o) => ({ value: String(o), label: String(o) }))]}
      />
    );
  } else if (k === "integer" || k === "number") {
    control = <input type="number" inputMode={k === "integer" ? "numeric" : "decimal"} step={k === "integer" ? 1 : "any"} min={s.minimum} max={s.maximum} {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={cx(FIELD, "h-10 w-40 tabular-nums sm:h-9", errCls)} />;
  } else if (k === "text" || k === "list" || k === "json") {
    control = (
      <textarea
        {...common}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        rows={k === "json" ? 5 : 3}
        spellCheck={k === "text"}
        placeholder={k === "list" ? "one per line" : k === "json" ? "{ }" : undefined}
        className={cx(FIELD, "resize-y py-2", k !== "text" && "font-mono text-[13px]", errCls)}
      />
    );
  } else if (k === "file") {
    const f = value as FileValue | null;
    const max = fileMax(s);
    control = (
      <div className="flex flex-wrap items-center gap-2">
        <label className={cx("press inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line bg-panel px-3 text-[14px] text-fg shadow-card hover:border-line-strong focus-within:border-accent/70 focus-within:shadow-[0_0_0_3px_var(--accent-soft)] sm:h-9", errCls)}>
          <FileUp className="size-3.5 text-fg-3" />
          {f ? "Replace file" : "Choose file"}
          <input
            type="file"
            {...common}
            accept={name === "zipBase64" ? ".zip,application/zip" : undefined}
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              if (file.size > max) {
                onFileError(`${file.name} is ${mb(file.size)}; the limit here is ${mb(max)}.`);
                return;
              }
              onFileError(null);
              try {
                onChange({ name: file.name, size: file.size, b64: await readBase64(file) });
              } catch (x) {
                onFileError((x as Error).message);
              }
            }}
          />
        </label>
        <span className="min-w-0 truncate text-xs text-fg-3">{f ? `${f.name} · ${mb(f.size)}` : `up to ${mb(max)}, read in your browser`}</span>
      </div>
    );
  } else {
    control = <input type="text" {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} maxLength={s.maxLength} spellCheck={false} autoComplete="off" autoCapitalize="off" className={cx(FIELD, "h-10 sm:h-9", errCls)} />;
  }
  return (
    <div className="block text-[14px]">
      <label htmlFor={id} className="text-fg-2">
        {label}
        {required && <span className="text-fg-3"> · required</span>}
      </label>
      <div className="mt-1.5">{control}</div>
      <p id={describedBy} className={cx("mt-1 text-xs leading-relaxed [overflow-wrap:anywhere]", error ? "text-down" : "text-fg-3")}>{error ?? hint}</p>
    </div>
  );
}
