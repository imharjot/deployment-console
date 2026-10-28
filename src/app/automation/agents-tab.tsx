"use client";
// Agents: the switch that turns the agent platform on or off for this console (admins), the worker that runs agent
// steps, and the agent definitions — named, versioned policies (instructions, tools, mode, limits) that agent tokens,
// workflows and runs use. Six templates are built in; a definition starts from one, and every change is a new version
// (older versions stay readable, so a run can always say which policy it ran under).
//
// The switch: CONSOLE_AGENTS on the server decides when it is set (the toggle then shows that and is disabled);
// otherwise an admin decides here; otherwise agents are on with the simulated account and off against a real one.
// Off: agent tokens get 503 and the worker starts nothing. The emergency stop is separate and always wins.
import { AnimatePresence } from "motion/react";
import { AlertTriangle, Archive, Bot, ChevronRight, History, Loader2, Pencil, Plus, Power, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useConfirm } from "@/components/confirm";
import { Modal } from "@/components/motion";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, IconButton, Skeleton, Switch, TimeAgo, cx } from "@/components/ui";
import type { Me } from "@/components/user-menu";
import { MODE_LABEL, TEMPLATES, agentsSwitchText, shortHash } from "@/components/agents/rules";
import type { AgentSettings, DefinitionItem } from "@/components/agents/types";
import { ApiError, getJson, postJson } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { SectionTitle } from "../_components/page-frame";
import { useSetStop, useStop } from "./stop-banner";

const SETTINGS = "/api/agents/settings";
const DEFINITIONS = "/api/agents/definitions";

export function AgentsTab({ me }: { me: Me }) {
  const admin = me.perms.includes("admin");
  return (
    <div className="space-y-8">
      <Switches admin={admin} mode={me.source} />
      <Definitions />
    </div>
  );
}

function Switches({ admin, mode }: { admin: boolean; mode: string }) {
  const { data, error, isLoading } = useSWR<AgentSettings>(SETTINGS, { refreshInterval: 30_000 });
  const { mutate } = useSWRConfig();
  const ask = useConfirm();
  const toast = useToast();
  const setStop = useSetStop();
  const live = useStop().data; // the same source as the banner, so the two never disagree
  if (isLoading) return <Skeleton className="h-36 rounded-2xl" />;
  if (error || !data) return <div className="rounded-2xl border border-line bg-panel shadow-card"><Empty title="Couldn't load the agents switch" hint={(error as Error | undefined)?.message} /></div>;
  const sw = agentsSwitchText(data.enabled, mode);
  const on = data.enabled.on;
  const flip = () =>
    ask({
      env: "",
      title: on ? "Turn agents off on this console?" : "Turn agents on?",
      description: on
        ? "Agent tokens are refused (503) and no agent step starts — assistants, workflows and connected agents all stop. Their runs and requests stay on record."
        : "Agents can act within their policies: reads and investigations, and changes only as their policies and approvals allow. The emergency stop still overrides this.",
      danger: on,
      expected: "yes",
      confirmLabel: on ? "Turn agents off" : "Turn agents on",
      run: async () => {
        const r = await postJson<AgentSettings>(SETTINGS, { enabled: !on });
        toast.push({ tone: r.overridden ? "error" : "ok", title: r.overridden ? "Saved, but CONSOLE_AGENTS decides" : `Agents ${r.enabled.on ? "on" : "off"}`, body: r.note });
        await mutate((k) => typeof k === "string" && (k.startsWith(SETTINGS) || k.startsWith("/api/agents/emergency-stop")));
      },
    });
  const w = data.worker;
  const stop = live ?? data.stop;
  return (
    <section className="space-y-3" aria-label="Agents switch">
      <SectionTitle>This console</SectionTitle>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4 shadow-card">
          <div className="flex items-start gap-3">
            <div className={cx("grid size-9 flex-none place-items-center rounded-xl border", on ? "border-up/30 bg-up/8 text-up" : "border-line bg-panel-2 text-fg-3")} aria-hidden>
              <Power className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-[15px] font-semibold">Agents {on ? "on" : "off"}</h3>
              <p className="mt-0.5 text-[13.5px] leading-relaxed text-fg-3">{sw.text}</p>
            </div>
            {admin && <Switch checked={on} onChange={flip} aria-label="Agents on this console" disabled={sw.locked} className="mt-1 flex-none" />}
          </div>
          {!admin && <p className="text-[13px] text-fg-3">Only an admin can change this.</p>}
          {w && (
            <div className="border-t border-line pt-3 text-[13.5px] text-fg-2">
              {w.started ? (
                <>
                  Worker running{w.draining ? " (draining for shutdown)" : ""} · {w.inflight} step{w.inflight === 1 ? "" : "s"} in flight
                  <div className="mt-1 flex flex-wrap gap-1">
                    {w.handlers.length ? w.handlers.map((h) => <Chip key={h} mono>{h}</Chip>) : <span className="text-degraded">no step handlers installed yet — runs queue until they are</span>}
                  </div>
                </>
              ) : (
                <span className="inline-flex items-start gap-1.5 text-degraded">
                  <AlertTriangle className="mt-[3px] size-3.5 flex-none" aria-hidden /> The step worker didn&apos;t start on this server: runs stay queued. Check the server log from startup.
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4 shadow-card">
          <div>
            <h3 className="text-[15px] font-semibold">Emergency stop {stop.on ? <Chip tone="bad">on</Chip> : <Chip tone="muted">off</Chip>}</h3>
            <p className="mt-0.5 text-[13.5px] leading-relaxed text-fg-3">
              Stops every agent change at once, whatever the policies say; reads go on. Use it when something an agent does looks wrong — then look at Runs.
            </p>
            {stop.on && (
              <p className="mt-1.5 text-[13.5px] text-fg-2">
                {stop.by && <>By {stop.by} </>}
                {stop.at ? <TimeAgo at={stop.at} /> : null}
                {stop.reason && <> · “{stop.reason}”</>}
              </p>
            )}
          </div>
          {admin && (
            <div>
              <Button variant={stop.on ? "secondary" : "danger"} onClick={() => setStop(!stop.on)}>
                {stop.on ? "Lift the stop" : "Emergency stop"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------- definitions ----------

const toolList = (t: DefinitionItem["tools"]): string[] => (Array.isArray(t) ? t : [...(t?.read ?? []), ...(t?.propose ?? []), ...(t?.act ?? [])]);

function Definitions() {
  const { data, error, isLoading } = useSWR<{ definitions: DefinitionItem[] }>(DEFINITIONS, { refreshInterval: 60_000, shouldRetryOnError: false });
  const [creating, setCreating] = useState<string | null>(null);
  const [history, setHistory] = useState<DefinitionItem | null>(null);
  const [editing, setEditing] = useState<DefinitionItem | null>(null);
  const { mutate } = useSWRConfig();
  const ask = useConfirm();
  const toast = useToast();
  const unavailable = error instanceof ApiError && error.status === 404;
  const defs = (data?.definitions ?? []).filter((d) => !d.builtIn); // the templates are listed above
  const refresh = () => mutate((k) => typeof k === "string" && k.startsWith(DEFINITIONS));

  const archive = (d: DefinitionItem) =>
    ask({
      env: "",
      title: `Disable "${d.name}"?`,
      description: "New tokens and workflows can't use it. Runs already going keep the version they started with; its versions stay readable.",
      danger: true,
      expected: "yes",
      confirmLabel: "Disable",
      run: async () => {
        const res = await fetch(`${DEFINITIONS}/${encodeURIComponent(d.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "x-console-csrf": "1" }, body: JSON.stringify({ action: "archive" }) });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
        toast.push({ tone: "ok", title: `${d.name} disabled` });
        await refresh();
      },
    });

  return (
    <section className="space-y-3" aria-label="Agent definitions">
      <SectionTitle>Templates</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TEMPLATES.map((t) => (
          <article key={t.id} className="flex flex-col rounded-2xl border border-line bg-panel p-4 shadow-card" aria-labelledby={`tpl-${t.id}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 id={`tpl-${t.id}`} className="text-[15px] font-semibold">{t.name}</h3>
              <Chip tone={MODE_LABEL[t.mode].tone}>{MODE_LABEL[t.mode].label}</Chip>
              {!t.llm && <Chip tone="muted">no model</Chip>}
            </div>
            <p className="mt-1.5 flex-1 text-[13.5px] leading-relaxed text-fg-2">{t.blurb}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setCreating(t.id)} disabled={unavailable} tip={unavailable ? "Agent definitions aren't available on this console yet" : undefined}>
                <Plus className="size-3.5" /> Make my own
              </Button>
              <a href={`#connect`} className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs font-medium text-fg-2 hover:bg-panel-3 hover:text-fg pointer-coarse:h-9">Connect an agent with it</a>
            </div>
          </article>
        ))}
      </div>

      <SectionTitle className="pt-3">Your definitions</SectionTitle>
      <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
        {isLoading ? (
          <div className="space-y-px p-2">{Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : unavailable ? (
          <Empty icon={<Bot className="size-5" />} title="Agent definitions aren't available on this console yet" hint="The six templates above still work: pick one when you connect an agent." />
        ) : error ? (
          <Empty title="Couldn't load definitions" hint={(error as Error).message} />
        ) : defs.length ? (
          <ul className="divide-y divide-line">
            {defs.map((d) => (
              <li key={`${d.id}@${d.version}`} className={cx("flex flex-wrap items-start gap-3 px-4 py-3", d.archivedAt && "opacity-60")}>
                <div className="min-w-0 flex-1 basis-60">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[14.5px] font-medium">{d.name}</span>
                    <Chip mono>v{d.version}</Chip>
                    <Chip tone={MODE_LABEL[d.mode]?.tone}>{MODE_LABEL[d.mode]?.label ?? d.mode}</Chip>
                    {d.archivedAt && <Chip tone="muted">disabled</Chip>}
                  </div>
                  <div className="mt-1 text-[12.5px] text-fg-3">
                    {toolList(d.tools).length} tools · policy <span className="font-mono" title={d.policyHash}>{shortHash(d.policyHash)}</span> · <span title={stamp(d.createdAt)}>saved <TimeAgo at={d.createdAt} /></span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {!d.archivedAt && (
                    <IconButton label={`Edit ${d.name} (saves a new version)`} onClick={() => setEditing(d)}>
                      <Pencil className="size-4" />
                    </IconButton>
                  )}
                  <IconButton label={`Versions of ${d.name}`} onClick={() => setHistory(d)}>
                    <History className="size-4" />
                  </IconButton>
                  {!d.archivedAt && (
                    <IconButton label={`Disable ${d.name}`} onClick={() => archive(d)} className="hover:!text-down">
                      <Archive className="size-4" />
                    </IconButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No definitions of your own yet" hint="Start from a template: name it, narrow its scope and tools, and save. Agent tokens and workflows can then use it." />
        )}
      </div>

      <AnimatePresence>
        {creating && (
          <DefinitionDialog
            key="new"
            template={creating}
            onClose={() => setCreating(null)}
            onDone={async (d) => {
              setCreating(null);
              toast.push({ tone: "ok", title: `${d.name} saved`, body: `Version ${d.version}` });
              await refresh();
            }}
          />
        )}
        {history && <VersionsDialog key="hist" def={history} onClose={() => setHistory(null)} />}
        {editing && (
          <EditDialog
            key="edit"
            def={editing}
            onClose={() => setEditing(null)}
            onDone={async (d) => {
              setEditing(null);
              toast.push({ tone: "ok", title: `${d.name} saved`, body: `Version ${d.version}. Tokens made from an earlier version keep theirs.` });
              await refresh();
            }}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

// A new definition from a template: a name, and optionally instructions and a narrower scope. The tools and limits are
// the template's (narrowing them further is a later version); the server validates and hashes the policy.
function DefinitionDialog({ template, onClose, onDone }: { template: string; onClose(): void; onDone(d: DefinitionItem): void }) {
  const tpl = TEMPLATES.find((t) => t.id === template)!;
  const [name, setName] = useState(`${tpl.name} (mine)`);
  const [instructions, setInstructions] = useState("");
  const [envs, setEnvs] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const scopeEnvs = envs.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      // A narrower scope is the template's own policy with its environments set (the server re-validates it).
      let policy: DefinitionItem["policy"];
      if (scopeEnvs.length) {
        const t = await getJson<{ definition: DefinitionItem }>(`${DEFINITIONS}/${encodeURIComponent(template)}`);
        if (!t.definition.policy) throw new Error("the template's policy couldn't be read");
        policy = { ...t.definition.policy, scope: { ...t.definition.policy.scope, envs: scopeEnvs } };
      }
      const r = await postJson<{ definition: DefinitionItem } & Partial<DefinitionItem>>(DEFINITIONS, {
        template, name: name.trim(), ...(instructions.trim() ? { instructions: instructions.trim() } : {}), ...(policy ? { policy } : {}),
      });
      onDone((r.definition ?? r) as DefinitionItem);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal onClose={busy ? undefined : onClose} aria-labelledby="def-title" className="max-w-lg">
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div>
            <h2 id="def-title" className="font-display text-[26px] leading-tight">New agent definition</h2>
            <p className="mt-1 text-[13.5px] leading-relaxed text-fg-3">From the {tpl.name} template ({MODE_LABEL[tpl.mode].label.toLowerCase()}). A definition can only narrow what its template allows.</p>
          </div>
          <IconButton type="button" label="Close" onClick={onClose} disabled={busy}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-[13.5px] font-medium text-fg-2">Name</span>
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="h-10 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14.5px] outline-none focus:border-accent focus:bg-panel" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13.5px] font-medium text-fg-2">Environments (optional)</span>
            <input value={envs} onChange={(e) => setEnvs(e.target.value)} placeholder="staging, dev" className="h-10 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14.5px] outline-none placeholder:text-fg-3 focus:border-accent focus:bg-panel" />
            <span className="mt-1.5 block text-[12.5px] text-fg-3">Leave empty for everything the person using it can reach.</span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13.5px] font-medium text-fg-2">Extra instructions (optional)</span>
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} maxLength={4000} placeholder="Focus on the checkout path. Prefer a restart over a rollback." className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[14px] outline-none placeholder:text-fg-3 focus:border-accent focus:bg-panel" />
            <span className="mt-1.5 block text-[12.5px] text-fg-3">Guidance for the model. It can&apos;t widen the policy: tools, scope, mode and limits are enforced by the console.</span>
          </label>
          {err && <div role="alert" className="rounded-lg border border-down/25 bg-down/10 px-3 py-2 text-[13.5px] text-down">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy && <Loader2 className="size-4 animate-spin" />} Save version 1
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function VersionsDialog({ def, onClose }: { def: DefinitionItem; onClose(): void }) {
  const { data, error, isLoading } = useSWR<{ definition?: DefinitionItem; versions?: DefinitionItem[] }>(`${DEFINITIONS}/${encodeURIComponent(def.id)}`);
  const versions = (data?.versions ?? (data?.definition ? [data.definition] : [def])).slice().sort((a, b) => b.version - a.version);
  return (
    <Modal onClose={onClose} aria-labelledby="ver-title" className="max-w-lg">
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div>
          <h2 id="ver-title" className="font-display text-[24px] leading-tight">{def.name}</h2>
          <p className="mt-1 text-[13.5px] text-fg-3">Every version stays readable; runs record the one they used.</p>
        </div>
        <IconButton label="Close" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 overflow-y-auto px-5 py-4">
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : error ? (
          <Empty title="Couldn't load versions" hint={(error as Error).message} />
        ) : (
          <ol className="space-y-2">
            {versions.map((v) => (
              <li key={v.version} className="rounded-xl border border-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5 text-[14px]">
                  <Chip mono>v{v.version}</Chip>
                  <Chip tone={MODE_LABEL[v.mode]?.tone}>{MODE_LABEL[v.mode]?.label ?? v.mode}</Chip>
                  <span className="text-[12.5px] text-fg-3" title={stamp(v.createdAt)}>
                    <TimeAgo at={v.createdAt} />
                  </span>
                </div>
                <details className="group mt-1">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12.5px] text-fg-3 hover:text-fg-2 [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="size-3 transition-transform duration-200 group-open:rotate-90" aria-hidden /> {toolList(v.tools).length} tools · policy {shortHash(v.policyHash)}
                  </summary>
                  <div className="mt-1 flex flex-wrap gap-1">{toolList(v.tools).map((t) => <Chip key={t} mono>{t}</Chip>)}</div>
                </details>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}

// A new version of a definition: its name and instructions (the policy stays; a narrower one is a new definition).
function EditDialog({ def, onClose, onDone }: { def: DefinitionItem; onClose(): void; onDone(d: DefinitionItem): void }) {
  const { data } = useSWR<{ definition: DefinitionItem }>(`${DEFINITIONS}/${encodeURIComponent(def.id)}`, { revalidateOnFocus: false });
  const [name, setName] = useState(def.name);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const text = instructions ?? data?.definition.instructions ?? "";
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${DEFINITIONS}/${encodeURIComponent(def.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "x-console-csrf": "1" }, body: JSON.stringify({ action: "save", name: name.trim(), instructions: text }),
      });
      const j = (await res.json().catch(() => ({}))) as { definition?: DefinitionItem; error?: string };
      if (!res.ok || !j.definition) throw new Error(j.error ?? `HTTP ${res.status}`);
      onDone(j.definition);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal onClose={busy ? undefined : onClose} aria-labelledby="edit-def-title" className="max-w-lg">
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          <div>
            <h2 id="edit-def-title" className="font-display text-[24px] leading-tight">Edit {def.name}</h2>
            <p className="mt-1 text-[13.5px] text-fg-3">Saving makes version {def.version + 1}. Its policy ({MODE_LABEL[def.mode]?.label.toLowerCase() ?? def.mode}, {toolList(def.tools).length} tools) stays as it is.</p>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[13.5px] font-medium text-fg-2">Name</span>
            <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className="h-10 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14.5px] outline-none focus:border-accent focus:bg-panel" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13.5px] font-medium text-fg-2">Instructions</span>
            <textarea value={text} onChange={(e) => setInstructions(e.target.value)} rows={6} maxLength={8000} className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[14px] outline-none focus:border-accent focus:bg-panel" />
          </label>
          {err && <div role="alert" className="rounded-lg border border-down/25 bg-down/10 px-3 py-2 text-[13.5px] text-down">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy && <Loader2 className="size-4 animate-spin" />} Save version {def.version + 1}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
