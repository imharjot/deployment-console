"use client";
import { AnimatePresence, motion } from "motion/react";
import { Bell, CheckCircle2, ExternalLink, KeyRound, Loader2, Lock, Send, Ticket, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Modal } from "@/components/motion";
import { IntegrationIcon, type IntegrationList } from "@/components/ticket-button";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, IconButton, Segmented, Skeleton, TimeAgo, cx } from "@/components/ui";
import { ApiError } from "@/lib/client/api";
import type { EnvFilter } from "@/lib/plugins/events";
import type { IntegrationView } from "@/lib/plugins/types";
import { SectionTitle } from "../../_components/page-frame";
import { Select } from "@/components/select";

interface Delivery {
  id: string;
  integration: string;
  event: string;
  at: number;
  ok: boolean;
  detail: string;
}

const LIST = "/api/integrations";
const DELIVERIES = "/api/integrations/deliveries";

// postJson only POSTs; PUT/DELETE need the same CSRF header the proxy requires on every non-GET.
async function send<T>(method: "PUT" | "POST" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", "x-console-csrf": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let j: unknown = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new ApiError(res.status, (j as { error?: string })?.error ?? `HTTP ${res.status}`);
  return j as T;
}

export default function IntegrationsPage() {
  const { data, error, isLoading } = useSWR<IntegrationList>(LIST, { refreshInterval: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const current = data?.integrations.find((i) => i.id === open);

  return (
    <div className="space-y-8">
      {data && !data.admin && (
        <div className="flex items-center gap-2 rounded-xl border border-line bg-panel-2 px-4 py-3 text-[14px] text-fg-2">
          <Lock className="size-4 text-fg-3" /> Only admins can change integrations. Enabled ticket integrations are available from the Ticket button across the console.
        </div>
      )}

      {error ? (
        <Empty title="Could not load integrations" hint={(error as Error).message} />
      ) : isLoading && !data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
          {data?.integrations.map((it, i) => (
            <Card key={it.id} it={it} index={i} admin={!!data.admin} onConfigure={() => setOpen(it.id)} />
          ))}
        </div>
      )}

      {data?.admin && <Deliveries names={new Map(data.integrations.map((i) => [i.id, i]))} />}

      <AnimatePresence>{current && data && <ConfigDialog key={current.id} it={current} list={data} onClose={() => setOpen(null)} />}</AnimatePresence>
    </div>
  );
}

function Status({ it }: { it: IntegrationView }) {
  if (!it.configured) return <Chip tone="muted">Not configured</Chip>;
  return it.enabled ? (
    <Chip tone="ok">
      <span className="size-1.5 rounded-full bg-up" /> Enabled
    </Chip>
  ) : (
    <Chip>Disabled</Chip>
  );
}

function Card({ it, index, admin, onConfigure }: { it: IntegrationView; index: number; admin: boolean; onConfigure(): void }) {
  const notify = it.capabilities.includes("notify");
  return (
    <motion.article
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.22, delay: index * 0.03 }}
      className="flex min-w-0 flex-col rounded-2xl border border-line bg-panel p-4 shadow-card"
    >
      <div className="flex items-start gap-3">
        <div className={cx("grid size-10 flex-none place-items-center rounded-xl border bg-panel-2", it.enabled ? "border-line-strong text-fg" : "border-line text-fg-3")}>
          <IntegrationIcon name={it.icon} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold">{it.name}</h3>
            <Status it={it} />
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-3">{it.description}</p>
        </div>
      </div>
      <div className="mb-4 mt-3 flex flex-wrap gap-1.5">
        {notify && (
          <Chip>
            <Bell className="size-3" /> Notifications
          </Chip>
        )}
        {it.capabilities.includes("tickets") && (
          <Chip>
            <Ticket className="size-3" /> Tickets
          </Chip>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3">
        <span className="min-w-0 truncate text-xs text-fg-3">
          {it.lastDelivery ? (
            <span className={cx("inline-flex items-center gap-1", it.lastDelivery.ok ? "text-fg-2" : "text-down")}>
              {it.lastDelivery.ok ? <CheckCircle2 className="size-3.5 text-up" /> : <XCircle className="size-3.5" />}
              {it.lastDelivery.ok ? "Delivered" : "Failed"} <TimeAgo at={it.lastDelivery.at} />
            </span>
          ) : notify ? (
            "No deliveries yet"
          ) : (
            "Files tickets on demand"
          )}
        </span>
        {admin && (
          <Button size="sm" onClick={onConfigure}>
            {it.configured ? "Configure" : "Set up"}
          </Button>
        )}
      </div>
    </motion.article>
  );
}

// ---------- configure dialog ----------

type SecretState = { mode: "saved" | "edit" | "clear"; value: string };

function Switch({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-[14px] font-medium pointer-coarse:min-h-10">
      <span className={cx("relative h-5 w-9 rounded-full border transition-colors duration-200", checked ? "border-accent bg-accent" : "border-line-strong bg-panel-3")}>
        <motion.span className="absolute left-0.5 top-0.5 size-3.5 rounded-full bg-white shadow" initial={false} animate={{ x: checked ? 16 : 0 }} transition={{ duration: 0.18, ease: "easeOut" }} />
      </span>
      {label}
    </button>
  );
}

const inputCls = "h-9 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14px] outline-none transition-colors placeholder:text-fg-3 focus:border-accent pointer-coarse:h-10";

function ConfigDialog({ it, list, onClose }: { it: IntegrationView; list: IntegrationList; onClose(): void }) {
  const notify = it.capabilities.includes("notify");
  const saved = it.config ?? {};
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(it.fields.filter((f) => f.type !== "secret").map((f) => [f.key, typeof saved[f.key] === "string" ? (saved[f.key] as string) : ""])));
  const [secrets, setSecrets] = useState<Record<string, SecretState>>(() => Object.fromEntries(it.fields.filter((f) => f.type === "secret").map((f) => [f.key, { mode: saved[f.key] ? "saved" : "edit", value: "" }])));
  const [enabled, setEnabled] = useState(it.configured ? it.enabled : true);
  const [types, setTypes] = useState<string[]>(it.events?.types ?? []);
  const [envs, setEnvs] = useState<EnvFilter>(it.events?.envs ?? "all");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const toast = useToast();
  const { mutate } = useSWRConfig();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Secrets: omitted = keep the saved value, a string = replace, null = clear.
  const config = useMemo(() => {
    const out: Record<string, string | null> = { ...values };
    for (const [k, s] of Object.entries(secrets)) {
      if (s.mode === "clear") out[k] = null;
      else if (s.mode === "edit" && s.value.trim()) out[k] = s.value;
    }
    return out;
  }, [values, secrets]);
  const missing = it.fields.filter((f) => f.required && (f.type === "secret" ? secrets[f.key].mode !== "saved" && !secrets[f.key].value.trim() : !values[f.key]?.trim())).map((f) => f.label);
  const envMode = envs === "all" || envs === "protected" ? envs : "custom";

  async function save() {
    setBusy("save");
    setResult(null);
    try {
      await send("PUT", `${LIST}/${it.id}`, { enabled, config, ...(notify ? { events: { types, envs } } : {}) });
      await mutate(LIST);
      toast.push({ tone: "ok", title: `${it.name} saved`, body: enabled ? "Enabled" : "Saved as disabled" });
      onClose();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setResult(null);
    try {
      const r = await send<{ message: string }>("POST", `${LIST}/${it.id}/test`, { config });
      setResult({ ok: true, text: r.message });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
      mutate(DELIVERIES);
      mutate(LIST);
    }
  }

  async function remove() {
    setBusy("remove");
    try {
      await send("DELETE", `${LIST}/${it.id}`);
      await mutate(LIST);
      toast.push({ tone: "info", title: `${it.name} removed`, body: "Its saved credentials were deleted." });
      onClose();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
      setBusy(null);
    }
  }

  return (
    // Centred on wide screens, a bottom sheet on phones; while saving, the scrim and swipe-down don't close it.
    <Modal onClose={busy ? undefined : onClose} aria-labelledby="integration-title" className="max-w-lg">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <div className="grid size-9 place-items-center rounded-xl border border-line bg-panel-2 text-fg-2">
          <IntegrationIcon name={it.icon} className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="integration-title" className="font-display text-2xl leading-tight">{it.name}</h2>
          {it.docsUrl && (
            <a href={it.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
              Setup docs <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        <IconButton label="Close" onClick={onClose} disabled={!!busy}>
          <X className="size-4" />
        </IconButton>
      </header>

      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing.length) save();
        }}
      >
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <div className="space-y-4">
            {it.fields.map((f, i) => (
              <div key={f.key} className="text-[14px]">
                <label htmlFor={`f-${f.key}`} className="flex items-center gap-1 text-fg-2">
                  {f.label}
                  {f.required && <span className="text-down">*</span>}
                </label>
                <div className="mt-1.5">
                  {f.type === "secret" ? (
                    <SecretInput id={`f-${f.key}`} state={secrets[f.key]} required={!!f.required} wasSaved={!!saved[f.key]} placeholder={f.placeholder} autoFocus={i === 0} onChange={(s) => setSecrets((m) => ({ ...m, [f.key]: s }))} />
                  ) : f.type === "select" ? (
                    <Select
                      id={`f-${f.key}`}
                      value={values[f.key]}
                      onChange={(x) => setValues((v) => ({ ...v, [f.key]: x }))}
                      base={inputCls}
                      options={[{ value: "", label: "—" }, ...(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))]}
                    />
                  ) : (
                    <input
                      id={`f-${f.key}`}
                      type={f.type === "url" ? "url" : "text"}
                      value={values[f.key]}
                      placeholder={f.placeholder}
                      autoFocus={i === 0}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      className={inputCls}
                    />
                  )}
                </div>
                {f.help && <p className="mt-1 text-[12.5px] text-fg-3">{f.help}</p>}
              </div>
            ))}
          </div>

          {notify && (
            <div className="space-y-4 rounded-xl border border-line bg-panel-2/50 p-4">
              <fieldset>
                <legend className="eyebrow mb-2">Send these events</legend>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {list.eventTypes.map((t) => (
                    <label key={t.value} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-[14px] hover:bg-panel-3 pointer-coarse:py-2">
                      <input type="checkbox" className="accent-[var(--accent)]" checked={types.includes(t.value)} onChange={(e) => setTypes((xs) => (e.target.checked ? [...xs, t.value] : xs.filter((x) => x !== t.value)))} />
                      {t.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div>
                <div className="eyebrow mb-2">Environments</div>
                <Segmented
                  id={`envs-${it.id}`}
                  size="sm"
                  value={envMode}
                  onChange={(v) => setEnvs(v === "custom" ? list.envs.map((e) => e.id) : v)}
                  options={[
                    { value: "all", label: "All" },
                    { value: "protected", label: "Protected only" },
                    { value: "custom", label: "Choose…" },
                  ]}
                />
                {Array.isArray(envs) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {list.envs.map((e) => {
                      const on = envs.includes(e.id);
                      return (
                        <button
                          key={e.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setEnvs(on ? envs.filter((x) => x !== e.id) : [...envs, e.id])}
                          className={cx("rounded-md border px-2 py-0.5 text-xs transition-colors pointer-coarse:px-3 pointer-coarse:py-2", on ? "border-accent/50 bg-accent-soft text-accent" : "border-line text-fg-3 hover:text-fg-2")}
                        >
                          {e.label}
                          {e.protected && " · protected"}
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="mt-2 text-[12.5px] text-fg-3">CI failures match the environment their branch deploys to. Repeats of the same alert within 60 s are dropped.</p>
              </div>
            </div>
          )}

          <AnimatePresence>
            {result && (
              <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                role="status"
                className={cx("flex items-start gap-2 rounded-lg px-3 py-2 text-xs", result.ok ? "bg-up/10 text-up" : "bg-down/10 text-down")}
              >
                {result.ok ? <CheckCircle2 className="mt-px size-3.5 flex-none" /> : <XCircle className="mt-px size-3.5 flex-none" />}
                <span className="break-words">{result.text}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
          <div className="flex items-center gap-3">
            <Switch checked={enabled} onChange={setEnabled} label={enabled ? "Enabled" : "Disabled"} />
            {it.configured && (
              <button type="button" onClick={remove} disabled={!!busy} className="text-xs text-fg-3 hover:text-down pointer-coarse:px-1 pointer-coarse:py-3">
                Remove
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={test} disabled={!!busy || missing.length > 0} title={missing.length ? `Fill in ${missing.join(", ")}` : notify ? "Send a test notification" : "Check credentials without creating a ticket"}>
              {busy === "test" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
              {notify ? "Send test" : "Test connection"}
            </Button>
            <Button type="submit" variant="primary" disabled={!!busy || missing.length > 0} title={missing.length ? `Fill in ${missing.join(", ")}` : undefined}>
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}

function SecretInput({ id, state, required, wasSaved, placeholder, autoFocus, onChange }: { id: string; state: SecretState; required: boolean; wasSaved: boolean; placeholder?: string; autoFocus?: boolean; onChange(s: SecretState): void }) {
  if (state.mode === "saved" || state.mode === "clear") {
    return (
      <div className={cx("flex h-9 items-center justify-between rounded-lg border border-line bg-panel-2 px-3 pointer-coarse:h-11 pointer-coarse:pr-1", state.mode === "clear" && "border-dashed")}>
        <span className="inline-flex items-center gap-2 text-fg-2">
          <KeyRound className="size-3.5 text-fg-3" />
          {state.mode === "saved" ? <span className="font-mono tracking-wider">•••• saved</span> : <span className="text-fg-3">will be cleared on save</span>}
        </span>
        <span className="flex gap-1">
          {state.mode === "saved" && !required && (
            <button type="button" id={id} onClick={() => onChange({ mode: "clear", value: "" })} className="rounded-md px-2 py-0.5 text-xs text-fg-3 hover:bg-panel-3 hover:text-down pointer-coarse:py-2.5">
              Clear
            </button>
          )}
          <button type="button" id={state.mode === "saved" && !required ? undefined : id} onClick={() => onChange({ mode: state.mode === "clear" ? "saved" : "edit", value: "" })} className="rounded-md px-2 py-0.5 text-xs font-medium text-accent hover:bg-accent-soft pointer-coarse:py-2.5">
            {state.mode === "clear" ? "Undo" : "Replace"}
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <input
        id={id}
        type="password"
        value={state.value}
        placeholder={placeholder ?? (wasSaved ? "new value" : "")}
        autoFocus={autoFocus || wasSaved}
        autoComplete="new-password"
        spellCheck={false}
        onChange={(e) => onChange({ mode: "edit", value: e.target.value })}
        className={inputCls}
      />
      {wasSaved && (
        <Button type="button" variant="ghost" onClick={() => onChange({ mode: "saved", value: "" })}>
          Keep saved
        </Button>
      )}
    </div>
  );
}

// ---------- deliveries ----------

function Deliveries({ names }: { names: Map<string, IntegrationView> }) {
  const { data, error } = useSWR<Delivery[]>(DELIVERIES, { refreshInterval: 15_000 });
  return (
    <section className="space-y-3">
      <SectionTitle>Recent deliveries</SectionTitle>
      <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
        {error ? (
          <Empty title="Could not load deliveries" hint={(error as Error).message} />
        ) : !data ? (
          <div className="space-y-px p-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : !data.length ? (
          <Empty icon={<Send className="size-5" />} title="No deliveries yet" hint="Notifications and test sends appear here, newest first. Kept for 14 days." />
        ) : (
          <ul className="divide-y divide-line">
            <AnimatePresence initial={false}>
              {data.map((d) => {
                const it = names.get(d.integration);
                return (
                  <motion.li key={d.id} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-[14px] sm:grid-cols-[18px_140px_minmax(0,1fr)_auto]">
                    {d.ok ? <CheckCircle2 className="size-4 text-up" /> : <XCircle className="size-4 text-down" />}
                    <span className="hidden items-center gap-1.5 truncate text-fg-2 sm:inline-flex">
                      <IntegrationIcon name={it?.icon ?? ""} className="size-3.5 flex-none text-fg-3" />
                      {it?.name ?? d.integration}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate" title={d.detail}>
                        {d.detail}
                      </span>
                      <span className="text-[12px] text-fg-3">
                        <span className="sm:hidden">{it?.name ?? d.integration} · </span>
                        {d.event}
                      </span>
                    </span>
                    <TimeAgo at={d.at} className="text-xs text-fg-3" />
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </section>
  );
}
