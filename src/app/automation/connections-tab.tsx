"use client";
// Connections: the model access agents use, and who pays for it (AGENT_ARCHITECTURE §4 "credential broker", §10).
// A connection is personal (only its owner uses it; admins may disconnect it, never use it) or the organisation's
// (admins create it; people with its minimum role use it). Secrets are write-only: they go in once, sealed, and are
// never shown again. Test checks it with the provider; Rotate replaces the secret; Disconnect deletes the console's copy
// and pauses the runs that use it — a run never switches to another connection or payer. With the simulated account a
// built-in scripted demo model is always there (read-only). Admins also see the endpoint registry and the policy.
import { AnimatePresence } from "motion/react";
import { CircleCheck, ExternalLink, FlaskConical, KeyRound, Loader2, LogIn, Plug, Plus, RotateCw, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useConfirm } from "@/components/confirm";
import { Modal } from "@/components/motion";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, IconButton, Segmented, Skeleton, TimeAgo } from "@/components/ui";
import type { Me } from "@/components/user-menu";
import { ConnectionForm, TextInput } from "@/components/agents/connection-form";
import { secretBody, secretFields, type ProviderOptionLike, type SecretFieldKey } from "@/components/agents/rules";
import { CHATGPT_START_PATH, CHATGPT_USAGE_URL, planAccountLabel } from "@/lib/agents/chatgpt/info";
import type { ConnectionPolicy, ConnectionView, EndpointEntry } from "@/lib/agents/connection-rules";
import { ApiError, postJson } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { DataTable, type Column } from "../_components/data-table";
import { SectionTitle } from "../_components/page-frame";

interface ConnectionsList {
  connections: ConnectionView[];
  endpoints: EndpointEntry[];
  providers: ProviderOptionLike[];
  policy: ConnectionPolicy;
  admin: boolean;
}

interface TestResult {
  ok: boolean;
  model?: string;
  models?: { id: string; label: string }[];
  warnings?: string[];
  runtime?: { version?: string };
  error?: string;
}

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "muted"> = { active: "ok", needs_auth: "warn", error: "bad", revoked: "muted" };
const STATUS_LABEL: Record<string, string> = { active: "active", needs_auth: "needs sign-in / new key", error: "error", revoked: "disconnected" };

const refreshConnections = (k: unknown) => typeof k === "string" && k.startsWith("/api/agents/connections");

async function del(url: string, body: unknown) {
  const res = await fetch(url, { method: "DELETE", headers: { "Content-Type": "application/json", "x-console-csrf": "1" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(res.status, j.error ?? `HTTP ${res.status}`, { code: j.code });
  return j as { connection: ConnectionView; pausedRuns: string[] };
}

async function patch(url: string, body: unknown) {
  const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json", "x-console-csrf": "1" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(res.status, j.error ?? `HTTP ${res.status}`, { code: j.code });
  return j as { connection: ConnectionView };
}

export function ConnectionsTab({ me }: { me: Me }) {
  const admin = me.perms.includes("admin");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const key = scope === "all" && admin ? "/api/agents/connections?all=1" : "/api/agents/connections";
  const { data, error, isLoading } = useSWR<ConnectionsList>(key, { refreshInterval: 60_000 });
  const { mutate } = useSWRConfig();
  const ask = useConfirm();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<ConnectionView | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const refresh = () => mutate(refreshConnections);

  const test = async (c: ConnectionView) => {
    setTesting(c.id);
    try {
      const r = await postJson<TestResult>(`/api/agents/connections/${encodeURIComponent(c.id)}/test`, {});
      if (r.ok)
        toast.push({
          tone: "ok",
          title: `${c.label} works`,
          body: [r.model && `model ${r.model}`, r.models?.length && `${r.models.length} model${r.models.length === 1 ? "" : "s"} available`, r.runtime?.version && `version ${r.runtime.version}`, ...(r.warnings ?? [])].filter(Boolean).join(" · ") || undefined,
        });
      else toast.push({ tone: "error", title: `${c.label} didn't work`, body: r.error ?? "The provider refused it." }, 10_000);
    } catch (e) {
      toast.push({ tone: "error", title: `Couldn't test ${c.label}`, body: (e as Error).message }, 10_000);
    } finally {
      setTesting(null);
      await refresh();
    }
  };

  const disconnect = (c: ConnectionView) =>
    ask({
      env: "",
      title: `Disconnect "${c.label}"?`,
      description: (
        <>
          Runs using it pause (they never switch to another connection or payer), and the console deletes its copy of the secret.
          {c.authKind === "api-key" && <> The key itself stays valid at the provider until you delete it there.</>}
          {c.authKind === "oauth-plan" && <> The console also signs this app out of the plan at OpenAI.</>}
        </>
      ),
      danger: true,
      expected: "yes",
      needReason: !c.mine,
      confirmLabel: "Disconnect",
      run: async ({ reason }) => {
        const r = await del(`/api/agents/connections/${encodeURIComponent(c.id)}`, reason ? { reason } : {});
        toast.push({
          tone: "ok",
          title: `${c.label} disconnected`,
          body: [
            r.pausedRuns.length ? `${r.pausedRuns.length} run${r.pausedRuns.length === 1 ? "" : "s"} paused` : "No run was using it",
            r.connection.revokeConfirmed ? "the provider confirmed the sign-out" : c.authKind === "api-key" ? "delete the key at the provider to end it there" : undefined,
          ].filter(Boolean).join(" · "),
        });
        await refresh();
      },
    });

  const columns: Column<ConnectionView>[] = [
    {
      key: "name",
      header: "Connection",
      slot: "title",
      cell: (c) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium">{c.label}</span>
            {c.builtIn && <Chip tone="muted">built-in · read-only</Chip>}
          </div>
          <div className="mt-0.5 text-[12.5px] text-fg-3">
            {c.providerLabel}
            {c.model ? <span className="font-mono"> · {c.model}</span> : null}
            {c.region ? <span className="font-mono"> · {c.region}</span> : null}
          </div>
          {c.provider === "chatgpt-plan" && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-fg-2">
              {planAccountLabel(c.account)}
              <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-fg-3 underline decoration-line-strong underline-offset-2 hover:text-fg-2">
                usage controls <ExternalLink className="size-3" aria-hidden />
              </a>
            </div>
          )}
        </div>
      ),
    },
    { key: "status", header: "Status", slot: "end", cell: (c) => <Chip tone={STATUS_TONE[c.status] ?? "muted"}>{STATUS_LABEL[c.status] ?? c.status}</Chip> },
    {
      key: "owner",
      header: "Owner",
      label: "owner",
      slot: "meta",
      className: "text-fg-2 @max-2xl:[overflow-wrap:anywhere]",
      cell: (c) => (c.builtIn ? "built-in" : c.scope === "org" ? `organisation${c.minRole ? ` (${c.minRole}+)` : ""}` : c.mine ? "you" : c.owner),
    },
    {
      key: "egress",
      header: "Prompts go",
      label: "prompts",
      slot: "meta",
      cell: (c) => <Chip tone={c.egress === "local" ? "ok" : "muted"}>{c.egress === "local" ? "stay local" : "to the cloud"}</Chip>,
    },
    { key: "bg", header: "Background", label: "background", slot: "meta", className: "text-fg-2", cell: (c) => (c.backgroundOk ? "allowed" : "no") },
    {
      key: "used",
      header: "Last used",
      label: "used",
      slot: "meta",
      className: "whitespace-nowrap text-fg-2",
      cell: (c) => (c.lastUsedAt ? <span title={stamp(c.lastUsedAt)}><TimeAgo at={c.lastUsedAt} /></span> : <span className="text-fg-3">never</span>),
    },
    {
      key: "payer",
      header: "Who pays",
      slot: "line",
      className: "text-[13.5px] text-fg-2 @min-2xl:max-w-[280px]",
      cell: (c) => (
        <span className="[overflow-wrap:anywhere]" title={c.notes?.join("\n")}>
          {c.payer}
          {!c.usable && c.why && <span className="block text-degraded">{c.why}</span>}
        </span>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      slot: "actions",
      className: "whitespace-nowrap px-3",
      cell: (c) => (
        <span className="inline-flex items-center gap-0.5">
          {c.usable && (
            <IconButton label={`Test ${c.label}`} onClick={() => test(c)} disabled={testing === c.id}>
              {testing === c.id ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
            </IconButton>
          )}
          {c.provider === "chatgpt-plan" && c.mine && (
            <a href={`${CHATGPT_START_PATH}?connection=${encodeURIComponent(c.id)}`} aria-label={`Sign in again for ${c.label}`} title="Sign in again" className="press grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:size-10">
              <LogIn className="size-4" />
            </a>
          )}
          {c.canEdit && c.hasSecret && c.provider !== "chatgpt-plan" && (
            <IconButton label={`Rotate the secret of ${c.label}`} onClick={() => setRotating(c)}>
              <RotateCw className="size-4" />
            </IconButton>
          )}
          {c.canRevoke && (
            <IconButton label={`Disconnect ${c.label}`} onClick={() => disconnect(c)} className="hover:!text-down">
              <Trash2 className="size-4" />
            </IconButton>
          )}
        </span>
      ),
    },
  ];

  const creatable = (data?.providers ?? []).some((p) => p.canCreate || p.signIn);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-[14px] leading-relaxed text-fg-3">
          A connection is how an agent reaches a model, and who pays for it. It never grants AWS access, a role or an approval. A run keeps the connection it started with: if that connection is refused or disconnected, the run pauses.
        </p>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {admin && <Segmented id="conn-scope" size="sm" value={scope} onChange={setScope} options={[{ value: "mine", label: "Mine & org" }, { value: "all", label: "Everyone" }]} />}
          <Button variant="primary" onClick={() => setCreating(true)} disabled={!data || !creatable} className="max-sm:flex-1">
            <Plus className="size-4" /> New connection
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
        {isLoading ? (
          <div className="space-y-px p-2">{Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
        ) : error ? (
          <Empty title="Couldn't load connections" hint={(error as Error).message} />
        ) : data?.connections.length ? (
          <DataTable label="Model connections" rows={data.connections} rowKey={(c) => c.id} columns={columns} rowClassName={(c) => c.status === "revoked" && "opacity-60"} />
        ) : (
          <Empty icon={<Plug className="size-5" />} title="No connections yet" hint="Connect a model provider with your own key, a local model, or (on a console you run for yourself) your Claude Code or Gemini CLI login." />
        )}
      </div>

      {admin && data && <AdminSettings endpoints={data.endpoints} policy={data.policy} onSaved={refresh} />}

      <AnimatePresence>
        {creating && data && (
          <Modal key="create" onClose={() => setCreating(false)} aria-labelledby="conn-title" className="max-w-2xl">
            <div className="flex items-start justify-between gap-3 px-5 pt-5">
              <div>
                <h2 id="conn-title" className="font-display text-[26px] leading-tight">New connection</h2>
                <p className="mt-1 text-[13.5px] leading-relaxed text-fg-3">Who pays is the provider account behind it. Every use is in the audit log.</p>
              </div>
              <IconButton label="Close" onClick={() => setCreating(false)}>
                <X className="size-4" />
              </IconButton>
            </div>
            <ConnectionForm
              providers={data.providers}
              endpoints={data.endpoints}
              admin={admin}
              onCancel={() => setCreating(false)}
              onDone={async (c) => {
                setCreating(false);
                toast.push({ tone: "ok", title: `${c.label} connected`, body: `Pays: ${c.payer}. Test it to see its models.` });
                await refresh();
              }}
            />
          </Modal>
        )}
        {rotating && <RotateDialog key="rotate" c={rotating} onClose={() => setRotating(null)} onDone={refresh} />}
      </AnimatePresence>
    </div>
  );
}

function RotateDialog({ c, onClose, onDone }: { c: ConnectionView; onClose(): void; onDone(): void }) {
  const [secret, setSecret] = useState<Partial<Record<SecretFieldKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const fields = secretFields(c.authKind);
  const ready = fields.every((f) => !f.required || !!secret[f.key]?.trim());
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setErr(null);
    try {
      await patch(`/api/agents/connections/${encodeURIComponent(c.id)}`, { secret: secretBody(c.authKind, secret) });
      toast.push({ tone: "ok", title: `${c.label}: secret replaced`, body: "The next request uses the new one." });
      onDone();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal onClose={busy ? undefined : onClose} aria-labelledby="rotate-title" className="max-w-md">
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          <div>
            <h2 id="rotate-title" className="flex items-center gap-2 font-display text-[24px] leading-tight">
              <KeyRound className="size-5 text-fg-3" aria-hidden /> Rotate secret
            </h2>
            <p className="mt-1 text-[13.5px] leading-relaxed text-fg-3">{c.label} · {c.providerLabel}. The old secret is replaced at once; runs keep this connection.</p>
          </div>
          {fields.map((f) => (
            <TextInput
              key={f.key}
              label={f.label + (f.required ? "" : " (optional)")}
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              required={f.required}
              value={secret[f.key] ?? ""}
              onChange={(e) => setSecret((s) => ({ ...s, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              hint={f.hint}
            />
          ))}
          {err && <div role="alert" className="rounded-lg border border-down/25 bg-down/10 px-3 py-2 text-[13.5px] text-down">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !ready}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <CircleCheck className="size-4" />} Replace secret
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// Admins: the registry of custom model endpoints (a connection can only point at a built-in or a registered one) and
// the organisation's connection policy. Saved together with PUT /api/agents/connections.
function AdminSettings({ endpoints, policy, onSaved }: { endpoints: EndpointEntry[]; policy: ConnectionPolicy; onSaved(): void }) {
  const ask = useConfirm();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const save = async (body: { endpoints?: unknown[]; policy?: ConnectionPolicy }, what: string) => {
    const res = await fetch("/api/agents/connections", { method: "PUT", headers: { "Content-Type": "application/json", "x-console-csrf": "1" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    toast.push({ tone: "ok", title: what });
    onSaved();
  };
  const strip = (e: EndpointEntry) => ({ id: e.id, url: e.url, label: e.label, providers: e.providers, local: e.local, personal: e.personal });
  const remove = (e: EndpointEntry) =>
    ask({
      env: "",
      title: `Remove the endpoint "${e.label}"?`,
      description: "Connections that use it stop working at their next request (their runs pause) until an admin registers it again.",
      danger: true,
      expected: "yes",
      confirmLabel: "Remove endpoint",
      run: () => save({ endpoints: endpoints.filter((x) => x.id !== e.id).map(strip) }, `${e.label} removed`),
    });
  const toggle = (k: "personal" | "localOnly", v: boolean) =>
    ask({
      env: "",
      title: k === "personal" ? (v ? "Allow personal connections?" : "Allow organisation connections only?") : v ? "Allow only local model endpoints?" : "Allow cloud model endpoints?",
      description: "Applies at the next use of every connection: runs on a connection the policy no longer allows pause.",
      expected: "yes",
      confirmLabel: "Save policy",
      run: () => save({ policy: { ...policy, [k]: v } }, "Connection policy saved"),
    });
  return (
    <section className="space-y-3" aria-label="Endpoints and policy">
      <SectionTitle>Endpoints and policy (admins)</SectionTitle>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-panel p-4 shadow-card">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-[14.5px] font-semibold">Registered endpoints</h3>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" /> Add
            </Button>
          </div>
          {endpoints.length ? (
            <ul className="divide-y divide-line">
              {endpoints.map((e) => (
                <li key={e.id} className="flex items-start gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">{e.label}</div>
                    <div className="font-mono text-[12.5px] text-fg-3 [overflow-wrap:anywhere]">{e.url}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {e.providers.map((p) => <Chip key={p} mono>{p}</Chip>)}
                      <Chip tone={e.local ? "ok" : "muted"}>{e.local ? "local" : "cloud"}</Chip>
                      <Chip tone={e.personal ? "accent" : "muted"}>{e.personal ? "personal allowed" : "organisation only"}</Chip>
                    </div>
                  </div>
                  <IconButton label={`Remove ${e.label}`} onClick={() => remove(e)} className="hover:!text-down">
                    <Trash2 className="size-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13.5px] leading-relaxed text-fg-3">None. OpenAI-compatible and Ollama connections need one; the Anthropic and OpenAI APIs use their built-in endpoints.</p>
          )}
        </div>
        <div className="space-y-3 rounded-2xl border border-line bg-panel p-4 shadow-card">
          <h3 className="text-[14.5px] font-semibold">Policy</h3>
          <label className="flex cursor-pointer items-start gap-2.5 text-[14px]">
            <input type="checkbox" checked={policy.personal} onChange={(e) => toggle("personal", e.target.checked)} className="mt-0.5" />
            <span>
              <span className="font-medium">Personal connections</span>
              <span className="block text-[12.5px] leading-snug text-fg-3">People may connect their own keys and sign-ins. Off: organisation connections only.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5 text-[14px]">
            <input type="checkbox" checked={policy.localOnly} onChange={(e) => toggle("localOnly", e.target.checked)} className="mt-0.5" />
            <span>
              <span className="font-medium">Local models only</span>
              <span className="block text-[12.5px] leading-snug text-fg-3">Prompts never leave your network: only local endpoints (and the demo model) may be used.</span>
            </span>
          </label>
          {policy.providers && <p className="text-[13px] text-fg-3">Allowed providers: {policy.providers.join(", ")}</p>}
        </div>
      </div>
      <AnimatePresence>
        {adding && (
          <EndpointDialog
            key="ep"
            onClose={() => setAdding(false)}
            onSave={async (e) => {
              await save({ endpoints: [...endpoints.map(strip), e] }, `${e.label} registered`);
              setAdding(false);
            }}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

const ENDPOINT_PROVIDERS = ["openai-compatible", "ollama", "anthropic", "openai"] as const;

function EndpointDialog({ onClose, onSave }: { onClose(): void; onSave(e: { url: string; label: string; providers: string[]; local: boolean; personal: boolean }): Promise<void> }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [providers, setProviders] = useState<string[]>(["openai-compatible"]);
  const [local, setLocal] = useState(false);
  const [personal, setPersonal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({ url: url.trim(), label: label.trim(), providers, local, personal });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal onClose={busy ? undefined : onClose} aria-labelledby="ep-title" className="max-w-md">
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          <h2 id="ep-title" className="font-display text-[24px] leading-tight">Register an endpoint</h2>
          <TextInput label="Label" required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Company LLM gateway" />
          <TextInput label="Base URL" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://llm.example.com/v1" hint="No credentials, query or fragment. Plain http only for a local endpoint. Metadata and link-local addresses are always refused." />
          <fieldset>
            <legend className="mb-1.5 text-[13.5px] font-medium text-fg-2">For providers</legend>
            <div className="flex flex-wrap gap-3">
              {ENDPOINT_PROVIDERS.map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-[14px]">
                  <input type="checkbox" checked={providers.includes(p)} onChange={(e) => setProviders((l) => (e.target.checked ? [...l, p] : l.filter((x) => x !== p)))} />
                  <span className="font-mono text-[13px]">{p}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-start gap-2.5 text-[14px]">
            <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="font-medium">Local endpoint</span>
              <span className="block text-[12.5px] text-fg-3">Every address it resolves to must be loopback or private (required for Ollama).</span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 text-[14px]">
            <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="font-medium">Allow personal connections</span>
              <span className="block text-[12.5px] text-fg-3">Off: only organisation connections may use it.</span>
            </span>
          </label>
          {err && <div role="alert" className="rounded-lg border border-down/25 bg-down/10 px-3 py-2 text-[13.5px] text-down">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !url.trim() || !label.trim() || !providers.length}>
            {busy && <Loader2 className="size-4 animate-spin" />} Register
          </Button>
        </div>
      </form>
    </Modal>
  );
}
