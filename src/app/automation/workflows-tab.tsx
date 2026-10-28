"use client";
// Workflows (AGENT_ARCHITECTURE §7): repeatable agent work — a trigger (by hand, a schedule, a state change or an
// alarm), the services it acts on, a list of typed steps, limits and who pays. Start from a template, edit the draft in
// fields (never free JSON), then PREVIEW it: the console resolves the services it would act on and shows the trigger,
// the steps with who decides each change, the limits, the approvals, where results go and who pays. Publishing binds
// that preview (its hash); published versions never change — editing makes a new version. Disable stops new runs.
import { AnimatePresence } from "motion/react";
import { ArrowDown, ArrowLeft, ArrowUp, Eye, Loader2, Play, Plus, Power, Rocket, Save, Trash2, Workflow, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type ReactNode } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useConfirm } from "@/components/confirm";
import { Modal } from "@/components/motion";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, IconButton, Skeleton, TimeAgo, cx } from "@/components/ui";
import type { Me } from "@/components/user-menu";
import { MODE_LABEL, STEP_KIND_LABEL, TEMPLATES, WORKFLOW_STEP_KINDS, inputRows, newStep, rowsToInput, scopeText, shortHash, triggerLabel, type InputRow, type WorkflowStepKind } from "@/components/agents/rules";
import type { WorkflowItem } from "@/components/agents/types";
import type { WorkflowDraft, WorkflowNode, WorkflowPreview, WorkflowTrigger } from "@/lib/agents/workflows";
import type { ConnectionView } from "@/lib/agents/connection-rules";
import { ApiError, getJson, postJson } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { DataTable, type Column } from "../_components/data-table";
import { SectionTitle } from "../_components/page-frame";
import { Select } from "@/components/select";

const BASE = "/api/agents/workflows";
const STATE_TONE: Record<string, "ok" | "muted" | "accent"> = { published: "ok", draft: "accent", disabled: "muted" };
const INPUT = "h-9 w-full rounded-lg border border-line bg-panel-2 px-2.5 text-[14px] text-fg outline-none placeholder:text-fg-3 focus:border-accent focus:bg-panel pointer-coarse:h-10";
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

async function patchWorkflow<T>(id: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "x-console-csrf": "1" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string; problems?: string[] };
  if (!res.ok) throw new ApiError(res.status, [j.error ?? `HTTP ${res.status}`, ...(j.problems ?? [])].join(" · "), { code: j.code });
  return j as T;
}

interface WorkflowDetail {
  workflow: WorkflowItem & { draft?: WorkflowDraft; activeVersion?: number };
  draft?: WorkflowDraft;
  versions?: WorkflowItem[];
  problems?: string[]; // what stops the draft from being published, said before anyone previews it
}

export function WorkflowsTab({ me, workflowId }: { me: Me; workflowId?: string }) {
  if (workflowId)
    return (
      <div className="space-y-4">
        <a href="#workflows" className="inline-flex items-center gap-1.5 text-[13.5px] text-fg-3 hover:text-fg-2 pointer-coarse:py-2">
          <ArrowLeft className="size-3.5" aria-hidden /> All workflows
        </a>
        <WorkflowEditor id={workflowId} me={me} />
      </div>
    );
  return <WorkflowList />;
}

const columns: Column<WorkflowItem>[] = [
  {
    key: "name",
    header: "Workflow",
    slot: "title",
    cell: (w) => (
      <div className="min-w-0">
        <a href={`#workflows/${w.id}`} className="block truncate font-medium text-fg hover:underline @max-2xl:whitespace-normal">{w.name}</a>
        <div className="mt-0.5 font-mono text-[12px] text-fg-3">v{w.version}{w.hash ? ` · ${shortHash(w.hash)}` : ""}</div>
      </div>
    ),
  },
  { key: "state", header: "State", slot: "end", cell: (w) => <Chip tone={STATE_TONE[w.state] ?? "muted"}>{w.state}</Chip> },
  { key: "trigger", header: "Trigger", label: "trigger", slot: "meta", className: "text-fg-2", cell: (w) => triggerLabel((Array.isArray(w.trigger) ? w.trigger[0] : w.trigger) as Parameters<typeof triggerLabel>[0]) },
  { key: "scope", header: "Acts on", label: "on", slot: "meta", className: "text-fg-2 @min-2xl:max-w-[260px]", cell: (w) => (w.scope ? scopeText(w.scope) : null) },
  { key: "published", header: "Published", label: "published", slot: "meta", className: "whitespace-nowrap text-fg-2", cell: (w) => (w.publishedAt ? <span title={stamp(w.publishedAt)}><TimeAgo at={w.publishedAt} /></span> : null) },
];

function WorkflowList() {
  const { data, error, isLoading } = useSWR<{ workflows: WorkflowItem[] }>(BASE, { refreshInterval: 60_000, shouldRetryOnError: false });
  const [creating, setCreating] = useState(false);
  const unavailable = error instanceof ApiError && error.status === 404;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-[14px] leading-relaxed text-fg-3">
          A workflow is agent work you can repeat: on a schedule, when a service goes down, or by hand. Nothing runs before you have seen its preview — which services it acts on, who decides each change and who pays.
        </p>
        <Button variant="primary" onClick={() => setCreating(true)} disabled={unavailable} className="max-sm:w-full">
          <Plus className="size-4" /> New workflow
        </Button>
      </div>
      <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
        {isLoading ? (
          <div className="space-y-px p-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : unavailable ? (
          <Empty icon={<Workflow className="size-5" />} title="Workflows aren't available on this console yet" hint="The workflow engine hasn't been installed on this server." />
        ) : error ? (
          <Empty title="Couldn't load workflows" hint={(error as Error).message} />
        ) : data?.workflows.length ? (
          <DataTable label="Workflows" rows={data.workflows} rowKey={(w) => `${w.id}@${w.version}`} columns={columns} rowClassName={(w) => w.state === "disabled" && "opacity-60"} />
        ) : (
          <Empty icon={<Workflow className="size-5" />} title="No workflows yet" hint="Start from a template: a daily digest, a non-production schedule, an approved remediation…" />
        )}
      </div>
      <AnimatePresence>{creating && <TemplateGallery key="new" onClose={() => setCreating(false)} />}</AnimatePresence>
    </div>
  );
}

function TemplateGallery({ onClose }: { onClose(): void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { mutate } = useSWRConfig();
  const create = async (template: string, name: string) => {
    setBusy(template);
    setErr(null);
    try {
      const r = await postJson<{ workflow?: WorkflowItem } & Partial<WorkflowItem>>(BASE, { template, name });
      const w = (r.workflow ?? r) as WorkflowItem;
      await mutate((k) => typeof k === "string" && k.startsWith(BASE));
      onClose();
      router.push(`/automation#workflows/${encodeURIComponent(w.id)}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  };
  return (
    <Modal onClose={busy ? undefined : onClose} aria-labelledby="tpl-title" className="max-w-3xl">
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div>
          <h2 id="tpl-title" className="font-display text-[26px] leading-tight">Start from a template</h2>
          <p className="mt-1 text-[13.5px] leading-relaxed text-fg-3">You get a draft to edit. Nothing runs until you preview and publish it.</p>
        </div>
        <IconButton label="Close" onClick={onClose} disabled={!!busy}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="grid min-h-0 gap-2 overflow-y-auto px-5 py-4 sm:grid-cols-2">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={!!busy}
            onClick={() => create(t.id, t.name)}
            className="press flex flex-col items-start gap-1 rounded-xl border border-line p-3 text-left transition-colors [--press-scale:0.985] hover:border-line-strong hover:bg-panel-2 disabled:opacity-60"
          >
            <span className="flex flex-wrap items-center gap-1.5 text-[14.5px] font-semibold">
              {busy === t.id && <Loader2 className="size-3.5 animate-spin" />}
              {t.name}
              <Chip tone={MODE_LABEL[t.mode].tone}>{MODE_LABEL[t.mode].label}</Chip>
              {!t.llm && <Chip tone="muted">no model</Chip>}
            </span>
            <span className="text-[13px] leading-relaxed text-fg-3">{t.blurb}</span>
          </button>
        ))}
      </div>
      {err && <div role="alert" className="mx-5 mb-4 rounded-lg border border-down/25 bg-down/10 px-3 py-2 text-[13.5px] text-down">{err}</div>}
    </Modal>
  );
}

// ---------- the editor ----------

function WorkflowEditor({ id, me }: { id: string; me: Me }) {
  const key = `${BASE}/${encodeURIComponent(id)}`;
  const { data, error, isLoading, mutate } = useSWR<WorkflowDetail>(key, (u: string) => getJson<WorkflowDetail>(u), { revalidateOnFocus: false });
  const { mutate: mutateAll } = useSWRConfig();
  const conns = useSWR<{ connections: ConnectionView[] }>("/api/agents/connections", { revalidateOnFocus: false });
  const ask = useConfirm();
  const toast = useToast();
  const wf = data?.workflow;
  const server = data?.draft ?? wf?.draft;
  const [draft, setDraft] = useState<WorkflowDraft | undefined>(server);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"save" | "preview" | "publish" | "disable" | "run" | null>(null);
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  // A new server copy (first load, or after a save) replaces the form unless the person has unsaved edits.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the form follows the server copy until it is edited
    if (server && !dirty) setDraft(server);
  }, [server, dirty]);

  const edit = (f: (d: WorkflowDraft) => WorkflowDraft) => {
    setDraft((d) => (d ? f(d) : d));
    setDirty(true);
    setPreview(null); // a preview binds exactly what it showed
  };
  const refresh = async () => {
    await mutate();
    await mutateAll((k) => typeof k === "string" && k.startsWith(BASE) && k !== key);
  };
  const run = async <T,>(what: NonNullable<typeof busy>, body: unknown, ok: (r: T) => void | Promise<void>) => {
    setBusy(what);
    setErr(null);
    try {
      const r = await patchWorkflow<T>(id, body);
      await ok(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run("save", { action: "save", draft }, async () => {
      setDirty(false);
      toast.push({ tone: "ok", title: "Draft saved" });
      await refresh();
    });
  const doPreview = async () => {
    if (dirty) {
      setBusy("save");
      try {
        await patchWorkflow(id, { action: "save", draft });
        setDirty(false);
        await refresh();
      } catch (e) {
        setErr((e as Error).message);
        setBusy(null);
        return;
      }
    }
    await run<{ preview?: WorkflowPreview } & Partial<WorkflowPreview>>("preview", { action: "preview" }, (r) => setPreview((r.preview ?? r) as WorkflowPreview));
  };
  const publish = () =>
    preview &&
    ask({
      env: "",
      title: `Publish ${draft?.name ?? "this workflow"}?`,
      description: (
        <>
          Exactly the preview you saw becomes version {wf?.version ?? ""}: {preview.resources.length} service{preview.resources.length === 1 ? "" : "s"}, {preview.steps.length} steps, paid by {preview.payer}. Its triggers start runs from now on; a published version never changes.
        </>
      ),
      expected: "yes",
      confirmLabel: "Publish",
      run: async () => {
        await patchWorkflow(id, { action: "publish", previewHash: preview.previewHash });
        toast.push({ tone: "ok", title: "Published" });
        setPreview(null);
        await refresh();
      },
    });
  // Start the published version by hand, with your rights; the run opens in Runs.
  const runNow = () =>
    run<{ runId: string }>("run", { action: "run" }, (r) => {
      toast.push({ tone: "ok", title: "Run started" });
      router.push(`/automation#runs/${encodeURIComponent(r.runId)}`);
    });
  const disable = () =>
    ask({
      env: "",
      title: `Disable ${wf?.name ?? "this workflow"}?`,
      description: "Its triggers stop before their next fire, and nobody can start it. Runs already going finish (or can be stopped under Runs).",
      danger: true,
      expected: "yes",
      confirmLabel: "Disable",
      run: async () => {
        await patchWorkflow(id, { action: "disable" });
        toast.push({ tone: "ok", title: "Disabled" });
        await refresh();
      },
    });

  if (isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (error || !wf) return <div className="rounded-2xl border border-line bg-panel shadow-card"><Empty title="Couldn't load this workflow" hint={(error as Error | undefined)?.message} /></div>;
  if (!draft) return <div className="rounded-2xl border border-line bg-panel shadow-card"><Empty title="This workflow has no editable draft" hint="The server didn't return its steps." /></div>;
  const connections = (conns.data?.connections ?? []).filter((c) => c.usable && c.status !== "revoked");
  const versions = (data?.versions ?? [wf]).slice().sort((a, b) => b.version - a.version);
  const ids = draft.steps.map((s) => s.id);
  const mode = draft.policy?.mode;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="eyebrow mb-1">Workflow · v{wf.version}{draft.template ? ` · from ${draft.template}` : ""}</div>
          <h2 className="text-[19px] font-semibold leading-snug">{draft.name || "Untitled workflow"}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip tone={STATE_TONE[wf.state] ?? "muted"}>{wf.state}</Chip>
            {mode && <Chip tone={MODE_LABEL[mode]?.tone}>{MODE_LABEL[mode]?.label ?? mode}</Chip>}
            {dirty && <Chip tone="warn">unsaved changes</Chip>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(wf.state === "published" || wf.activeVersion !== undefined) && (
            <>
              <Button onClick={runNow} disabled={!!busy} title={`Start the published version${wf.activeVersion !== undefined ? ` (v${wf.activeVersion})` : ""} now, with your rights`}>
                {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run now
              </Button>
              <Button variant="danger" onClick={disable} disabled={!!busy}>
                <Power className="size-4" /> Disable
              </Button>
            </>
          )}
          <Button onClick={save} disabled={!dirty || !!busy}>
            {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save draft
          </Button>
          <Button variant="primary" onClick={doPreview} disabled={!!busy}>
            {busy === "preview" ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />} Preview
          </Button>
        </div>
      </header>
      {wf.state === "published" && (
        <p className="rounded-xl border border-line bg-panel-2 px-3 py-2 text-[13.5px] text-fg-2">Version {wf.version} is published and can&apos;t change. Saving your edits makes a new draft version; the published one keeps running until you publish the new one.</p>
      )}
      {err && <div role="alert" className="rounded-xl border border-down/25 bg-down/10 px-3 py-2 text-[13.5px] leading-relaxed text-down [overflow-wrap:anywhere]">{err}</div>}
      {!dirty && !!data?.problems?.length && (
        <div role="note" className="rounded-xl border border-degraded/30 bg-degraded/6 px-3 py-2 text-[13.5px] leading-relaxed text-degraded">
          <b className="font-semibold">Before it can be published:</b>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {data.problems.slice(0, 12).map((p) => (
              <li key={p} className="[overflow-wrap:anywhere]">{p}</li>
            ))}
          </ul>
        </div>
      )}

      {preview && <PreviewPanel p={preview} onPublish={publish} onClose={() => setPreview(null)} busy={!!busy} />}

      <Card title="Basics">
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="Name">
            {(id) => <input id={id} className={INPUT} maxLength={80} value={draft.name} onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))} />}
          </Labeled>
          <Labeled label="Who pays (connection)" hint={draft.steps.some((s) => s.kind === "model") ? "Model steps need one; it must allow background runs for schedules and events." : "No model step: nothing to pay for."}>
            {(id, hint) => (
              <Select
                id={id}
                aria-describedby={hint}
                base={INPUT}
                value={draft.connectionId ?? ""}
                onChange={(v) => edit((d) => ({ ...d, connectionId: v || undefined }))}
                options={[{ value: "", label: "None (deterministic)" }, ...connections.map((c) => ({ value: c.id, label: `${c.label} — ${c.payer}${c.backgroundOk ? "" : " (no background runs)"}` }))]}
              />
            )}
          </Labeled>
          <Labeled label="Description" className="sm:col-span-2">
            {(id) => <input id={id} className={INPUT} maxLength={300} value={draft.description ?? ""} onChange={(e) => edit((d) => ({ ...d, description: e.target.value || undefined }))} />}
          </Labeled>
        </div>
      </Card>

      <Card title="Triggers" action={<Button size="sm" onClick={() => edit((d) => ({ ...d, triggers: [...d.triggers, { type: "manual" }] }))}><Plus className="size-3.5" /> Add</Button>}>
        {draft.triggers.length ? (
          <ul className="space-y-2">
            {draft.triggers.map((t, i) => (
              <li key={i} className="rounded-xl border border-line p-3">
                <TriggerFields t={t} onChange={(nt) => edit((d) => ({ ...d, triggers: d.triggers.map((x, j) => (j === i ? nt : x)) }))} onRemove={() => edit((d) => ({ ...d, triggers: d.triggers.filter((_, j) => j !== i) }))} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13.5px] text-fg-3">No trigger: it only runs when someone starts it.</p>
        )}
      </Card>

      <Card title="Acts on">
        <label className="mb-2 flex items-center gap-2 text-[14px]">
          <input type="checkbox" checked={!!draft.targets} onChange={(e) => edit((d) => ({ ...d, targets: e.target.checked ? { envs: [] } : undefined }))} className="accent-[var(--accent)]" />
          Explicitly chosen ECS services
        </label>
        {draft.targets ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Environments (required)">
              {(id) => <ListInput id={id} value={draft.targets!.envs} onChange={(v) => edit((d) => ({ ...d, targets: { ...d.targets!, envs: v } }))} placeholder="staging, dev" />}
            </Labeled>
            <Labeled label="Services (optional)" hint="Empty: every service in those environments, except protected, shared and the console's own.">
              {(id, hint) => <ListInput id={id} describedBy={hint} value={draft.targets!.services ?? []} onChange={(v) => edit((d) => ({ ...d, targets: { ...d.targets!, services: v.length ? v : undefined } }))} placeholder="api, worker" />}
            </Labeled>
          </div>
        ) : (
          <p className="text-[13.5px] text-fg-3">No explicit services: it reads within its policy&apos;s scope ({scopeText(draft.policy?.scope)}), and any change it asks for waits for a person.</p>
        )}
      </Card>

      <Card
        title="Steps"
        action={
          <Select<WorkflowStepKind>
            aria-label="Add a step"
            value=""
            placeholder={<span className="text-fg-2">+ Add step…</span>}
            onChange={(k) => edit((d) => ({ ...d, steps: [...d.steps, newStep(k, ids) as unknown as WorkflowNode] }))}
            base="h-7 rounded-lg border border-line bg-panel px-2 text-xs outline-none hover:border-line-strong focus-visible:border-accent pointer-coarse:h-9"
            options={WORKFLOW_STEP_KINDS.map((k) => ({ value: k, label: STEP_KIND_LABEL[k].label }))}
          />
        }
      >
        {draft.steps.length ? (
          <ol className="space-y-2">
            {draft.steps.map((s, i) => (
              <li key={s.id} className="rounded-xl border border-line p-3">
                <StepFields
                  n={s}
                  index={i}
                  last={i === draft.steps.length - 1}
                  onChange={(ns) => edit((d) => ({ ...d, steps: d.steps.map((x, j) => (j === i ? ns : x)) }))}
                  onMove={(dir) =>
                    edit((d) => {
                      const steps = [...d.steps];
                      const j = i + dir;
                      [steps[i], steps[j]] = [steps[j], steps[i]];
                      return { ...d, steps };
                    })
                  }
                  onRemove={() => edit((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))}
                />
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[13.5px] text-fg-3">No steps yet.</p>
        )}
      </Card>

      <Card title="Limits">
        <div className="grid gap-3 sm:grid-cols-4">
          {(
            [
              ["maxConcurrentRuns", "Runs at once"],
              ["cooldownSeconds", "Cooldown per service (s)"],
              ["maxAttempts", "Attempts per service"],
              ["attemptWindowSeconds", "…within (s)"],
            ] as const
          ).map(([k, label]) => (
            <Labeled key={k} label={label}>
              {(id) => (
                <input id={id} type="number" min={0} className={INPUT} value={draft.limits?.[k] ?? 0} onChange={(e) => edit((d) => ({ ...d, limits: { ...d.limits, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) } }))} />
              )}
            </Labeled>
          ))}
        </div>
        {draft.policy?.limits && (
          <p className="mt-2 text-[13px] text-fg-3">
            Per run (from the policy): {draft.policy.limits.runtimeSeconds}s, {draft.policy.limits.toolCalls} tool calls, {draft.policy.limits.modelTurns} model turns, {draft.policy.limits.mutationsPerResourcePerHour} change(s) per service per hour.
          </p>
        )}
      </Card>

      <Card title="Versions">
        <ol className="space-y-1">
          {versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-2 text-[13.5px]">
              <Chip mono>v{v.version}</Chip>
              <Chip tone={STATE_TONE[v.state] ?? "muted"}>{v.state}</Chip>
              {v.hash && <span className="font-mono text-[12.5px] text-fg-3" title={v.hash}>{shortHash(v.hash)}</span>}
              {v.publishedAt ? <span className="text-fg-3">published <TimeAgo at={v.publishedAt} /></span> : v.createdAt ? <span className="text-fg-3">saved <TimeAgo at={v.createdAt} /></span> : null}
            </li>
          ))}
        </ol>
      </Card>
      {me.perms.includes("admin") ? null : <p className="text-[12.5px] text-fg-3">A workflow acts with your role at each run; if you lose access, its runs stop.</p>}
    </div>
  );
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-panel p-4 shadow-card" aria-label={title}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <SectionTitle>{title}</SectionTitle>
        {action}
      </div>
      {children}
    </section>
  );
}

function Labeled({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: (id: string, hintId?: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium text-fg-2">{label}</label>
      {children(id, hint ? `${id}-h` : undefined)}
      {hint && <p id={`${id}-h`} className="mt-1 text-[12.5px] leading-snug text-fg-3">{hint}</p>}
    </div>
  );
}

// A comma-separated list edited as text; committed as a list when the field loses focus.
function ListInput({ id, value, onChange, placeholder, describedBy }: { id: string; value: string[]; onChange(v: string[]): void; placeholder?: string; describedBy?: string }) {
  const [text, setText] = useState(value.join(", "));
  return <input id={id} aria-describedby={describedBy} className={INPUT} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(list(text))} />;
}

function TriggerFields({ t, onChange, onRemove }: { t: WorkflowTrigger; onChange(t: WorkflowTrigger): void; onRemove(): void }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Labeled label="When">
        {(id) => (
          <Select
            id={id}
            base={cx(INPUT, "w-40")}
            value={t.type === "event" ? `event:${t.source}` : t.type}
            options={[
              { value: "manual", label: "By hand" },
              { value: "schedule", label: "On a schedule" },
              { value: "event:state", label: "A service goes down" },
              { value: "event:alarm", label: "An alarm fires" },
            ]}
            onChange={(v) => {
              onChange(v === "schedule" ? { type: "schedule", cron: "0 19 * * 1-5", tz: "UTC" } : v.startsWith("event:") ? { type: "event", source: v.slice(6) as "state" | "alarm", selector: { envs: [] } } : { type: "manual" });
            }}
          />
        )}
      </Labeled>
      {t.type === "schedule" && (
        <>
          <Labeled label="Cron (5 fields)">{(id) => <input id={id} className={cx(INPUT, "w-40 font-mono")} value={t.cron} onChange={(e) => onChange({ ...t, cron: e.target.value })} />}</Labeled>
          <Labeled label="Time zone">{(id) => <input id={id} className={cx(INPUT, "w-44")} value={t.tz} onChange={(e) => onChange({ ...t, tz: e.target.value })} placeholder="Europe/London" />}</Labeled>
        </>
      )}
      {t.type === "event" && (
        <>
          <Labeled label="In environments">{(id) => <ListInput id={id} value={t.selector.envs ?? []} onChange={(v) => onChange({ ...t, selector: { ...t.selector, envs: v } })} placeholder="staging" />}</Labeled>
          {t.source === "state" && (
            <Labeled label="States">{(id) => <ListInput id={id} value={t.selector.states ?? []} onChange={(v) => onChange({ ...t, selector: { ...t.selector, states: v.length ? v : undefined } })} placeholder="DOWN, DEGRADED" />}</Labeled>
          )}
        </>
      )}
      <IconButton label="Remove trigger" onClick={onRemove} className="ml-auto hover:!text-down">
        <Trash2 className="size-4" />
      </IconButton>
    </div>
  );
}

function StepFields({ n, index, last, onChange, onMove, onRemove }: { n: WorkflowNode; index: number; last: boolean; onChange(n: WorkflowNode): void; onMove(dir: -1 | 1): void; onRemove(): void }) {
  const kind = STEP_KIND_LABEL[n.kind as WorkflowStepKind];
  const set = (patch: Partial<WorkflowNode>) => onChange({ ...n, ...patch } as WorkflowNode);
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-6 place-items-center rounded-full border border-line text-[12px] tabular-nums text-fg-3">{index + 1}</span>
        <Chip>{kind?.label ?? n.kind}</Chip>
        <span className="font-mono text-[12px] text-fg-3">{n.id}</span>
        <span className="ml-auto inline-flex items-center gap-0.5">
          <IconButton label="Move up" onClick={() => onMove(-1)} disabled={index === 0}>
            <ArrowUp className="size-3.5" />
          </IconButton>
          <IconButton label="Move down" onClick={() => onMove(1)} disabled={last}>
            <ArrowDown className="size-3.5" />
          </IconButton>
          <IconButton label={`Remove step ${n.id}`} onClick={onRemove} className="hover:!text-down">
            <Trash2 className="size-3.5" />
          </IconButton>
        </span>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Labeled label="Title">{(id) => <input id={id} className={INPUT} value={n.title ?? ""} onChange={(e) => set({ title: e.target.value || undefined })} placeholder={kind?.hint} />}</Labeled>
        <Labeled label="Only when (optional)">{(id) => <input id={id} className={cx(INPUT, "font-mono")} value={n.when ?? ""} onChange={(e) => set({ when: e.target.value || undefined })} placeholder="steps.check.result.down > 0" />}</Labeled>
        {(n.kind === "tool" || n.kind === "verify") && (
          <>
            <Labeled label="Operation">{(id) => <input id={id} className={cx(INPUT, "font-mono")} value={n.op} onChange={(e) => set({ op: e.target.value.trim() })} placeholder="services.get" />}</Labeled>
            <label className="flex items-center gap-2 self-end pb-2 text-[13.5px]">
              <input type="checkbox" checked={n.forEach === "targets"} onChange={(e) => set({ forEach: e.target.checked ? "targets" : undefined })} className="accent-[var(--accent)]" />
              Once per service it acts on
            </label>
            <div className="sm:col-span-2">
              <InputEditor value={n.input} onChange={(input) => set({ input })} />
            </div>
          </>
        )}
        {n.kind === "verify" && (
          <>
            <Labeled label="Until">{(id) => <input id={id} className={cx(INPUT, "font-mono")} value={n.expect} onChange={(e) => set({ expect: e.target.value })} />}</Labeled>
            <Labeled label="Give up after (s)">{(id) => <input id={id} type="number" min={1} className={INPUT} value={n.timeoutSeconds} onChange={(e) => set({ timeoutSeconds: Math.max(1, Number(e.target.value) || 1) })} />}</Labeled>
          </>
        )}
        {n.kind === "model" && (
          <Labeled label="Goal" className="sm:col-span-2">
            {(id) => <textarea id={id} rows={2} className="w-full rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[14px] outline-none focus:border-accent focus:bg-panel" value={n.goal} onChange={(e) => set({ goal: e.target.value })} />}
          </Labeled>
        )}
        {n.kind === "approval" && <Labeled label="Message" className="sm:col-span-2">{(id) => <input id={id} className={INPUT} value={n.message} onChange={(e) => set({ message: e.target.value })} />}</Labeled>}
        {n.kind === "wait" && <Labeled label="Seconds">{(id) => <input id={id} type="number" min={1} className={INPUT} value={n.seconds} onChange={(e) => set({ seconds: Math.max(1, Number(e.target.value) || 1) })} />}</Labeled>}
        {n.kind === "condition" && <Labeled label="Continue only if">{(id) => <input id={id} className={cx(INPUT, "font-mono")} value={n.expr} onChange={(e) => set({ expr: e.target.value })} />}</Labeled>}
        {n.kind === "notify" && (
          <Labeled label="Send to">
            {(id) => (
              <Select
                id={id}
                base={INPUT}
                value={n.to}
                onChange={(v) => set({ to: v as "run" | "integrations" })}
                options={[
                  { value: "run", label: "The run's result" },
                  { value: "integrations", label: "The run's result and integrations" },
                ]}
              />
            )}
          </Labeled>
        )}
      </div>
    </div>
  );
}

// An operation's input as name / value rows (values: text, numbers, true/false, [a, b] lists or {{ templates }}).
function InputEditor({ value, onChange }: { value: Record<string, unknown>; onChange(v: Record<string, unknown>): void }) {
  const [rows, setRows] = useState<InputRow[]>(() => inputRows(value));
  const commit = (next: InputRow[]) => {
    setRows(next);
    onChange(rowsToInput(next));
  };
  return (
    <fieldset className="rounded-lg border border-line p-2">
      <legend className="px-1 text-[12.5px] text-fg-3">Input</legend>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-1.5">
            <input aria-label="Field" className={cx(INPUT, "w-36 font-mono")} value={r.key} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="env" />
            <input aria-label={`Value of ${r.key || "field"}`} className={cx(INPUT, "font-mono")} value={r.value} onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="{{ target.env }}" />
            <IconButton label={`Remove ${r.key || "field"}`} onClick={() => commit(rows.filter((_, j) => j !== i))}>
              <X className="size-3.5" />
            </IconButton>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setRows([...rows, { key: "", value: "" }])}>
          <Plus className="size-3.5" /> Field
        </Button>
      </div>
    </fieldset>
  );
}

function PreviewPanel({ p, onPublish, onClose, busy }: { p: WorkflowPreview; onPublish(): void; onClose(): void; busy: boolean }) {
  const row = (label: string, v: ReactNode) => (
    <>
      <dt className="pt-px text-[12.5px] text-fg-3">{label}</dt>
      <dd className="min-w-0 text-[13.5px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]">{v}</dd>
    </>
  );
  return (
    <section aria-labelledby="wf-preview" className="rounded-2xl border border-accent/40 bg-panel shadow-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Eye className="size-4 text-accent" aria-hidden />
        <h3 id="wf-preview" className="text-[15px] font-semibold">Preview — what publishing activates</h3>
        <IconButton label="Close preview" onClick={onClose} className="ml-auto">
          <X className="size-4" />
        </IconButton>
      </header>
      <dl className="grid grid-cols-[minmax(92px,auto)_1fr] gap-x-3 gap-y-2 px-4 py-3">
        {row(
          "Trigger",
          <ul className="space-y-0.5">
            {p.trigger.length ? p.trigger.map((t, i) => <li key={i}>{t.text}{t.next?.length ? <span className="text-fg-3"> · next {t.next.slice(0, 2).map((x) => stamp(x)).join(", ")}</span> : null}</li>) : <li>only by hand</li>}
          </ul>,
        )}
        {row(
          "Acts on",
          p.resources.length ? (
            <>
              <span className="font-mono text-[12.5px]">{p.resources.join(", ")}</span>
              {!!p.excluded.length && <span className="block text-fg-3">Left out: {p.excluded.map((x) => `${x.key} (${x.why})`).join("; ")}</span>}
            </>
          ) : (
            <span className="text-fg-3">no explicit services{p.excluded.length ? ` — left out: ${p.excluded.map((x) => `${x.key} (${x.why})`).join("; ")}` : ""}</span>
          ),
        )}
        {row(
          "Steps",
          <ol className="space-y-0.5">
            {p.steps.map((s, i) => (
              <li key={s.id}>
                {i + 1}. {s.title}
                {s.op && <span className="font-mono text-[12.5px] text-fg-3"> ({s.op}{s.risk ? `, ${s.risk}` : ""})</span>}
                {s.forEach && <span className="text-fg-3"> · per service</span>}
                {s.approval && <span className="text-fg-3"> — {s.approval}</span>}
              </li>
            ))}
          </ol>,
        )}
        {row("Limits", `${p.limits.maxConcurrentRuns} run(s) at once · cooldown ${p.limits.cooldownSeconds}s · ${p.limits.maxAttempts} attempts per ${p.limits.attemptWindowSeconds}s · per run ${p.limits.runtimeSeconds}s, ${p.limits.toolCalls} tool calls, ${p.limits.modelTurns} model turns${p.limits.costUsd !== undefined ? `, ≤ $${p.limits.costUsd}` : ""}`)}
        {row("Approvals", p.approvals.length ? <ul className="space-y-0.5">{p.approvals.map((a) => <li key={a}>{a}</li>)}</ul> : "none needed")}
        {row("Results go to", p.destination.join("; "))}
        {row("Who pays", p.payer)}
        {row("Mode", MODE_LABEL[p.mode]?.label ?? p.mode)}
        {row("Binds", <span className="font-mono text-[12.5px]" title={p.previewHash}>{shortHash(p.hash)} · preview {shortHash(p.previewHash)}</span>)}
      </dl>
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
        <span className="mr-auto text-[13px] text-fg-3">Publishing activates exactly this. Change anything and you&apos;ll preview again.</span>
        <Button variant="primary" onClick={onPublish} disabled={busy}>
          <Rocket className="size-4" /> Publish
        </Button>
      </footer>
    </section>
  );
}
