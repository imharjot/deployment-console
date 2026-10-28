"use client";
// Creating a model connection: a form generated from the provider list GET /api/agents/connections returns (the
// connection-rules PROVIDERS spec plus what this person may create). The secret fields are write-only — password
// inputs that are sent once and never filled back; the console seals the secret and only ever shows that one exists.
// Endpoints come from the built-in default or the admin-registered list, never free text. A ChatGPT plan isn't made
// here: it is a sign-in (shown only when the console has CONSOLE_CHATGPT_PLAN=eligible), with OpenAI's eligibility text.
import { ExternalLink, KeyRound, Loader2, LogIn } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import useSWR from "swr";
import { Button, Chip, cx } from "@/components/ui";
import { ELIGIBILITY_NOTE } from "@/lib/agents/chatgpt/info";
import type { ConnectionView, EndpointEntry } from "@/lib/agents/connection-rules";
import { postJson } from "@/lib/client/api";
import { ROLES } from "@/lib/rbac";
import { AUTH_LABEL, connectionBody, draftReady, emptyDraft, endpointChoices, secretFields, type ConnectionDraft, type ProviderOptionLike, type SecretFieldKey } from "./rules";
import { Select } from "@/components/select";

const INPUT =
  "h-10 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14.5px] text-fg outline-none transition-colors placeholder:text-fg-3 focus:border-accent focus:bg-panel disabled:opacity-60 pointer-coarse:h-11";

export function FormField({ label, hint, children, className }: { label: string; hint?: ReactNode; children: (id: string, hintId?: string) => ReactNode; className?: string }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-[13.5px] font-medium text-fg-2">{label}</label>
      {children(id, hintId)}
      {hint && <p id={hintId} className="mt-1.5 text-[12.5px] leading-snug text-fg-3">{hint}</p>}
    </div>
  );
}

export function TextInput({ label, hint, className, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  return <FormField label={label} hint={hint} className={className}>{(id, hintId) => <input id={id} aria-describedby={hintId} {...input} className={INPUT} />}</FormField>;
}

// The ChatGPT plan sign-in (GET /api/agents/oauth/chatgpt is 404 unless the flag is on).
interface PlanInfo {
  enabled: boolean;
  eligibility?: string;
  usageUrl?: string;
  startPath: string;
  loopback: boolean;
  signInOrigin?: string;
}

function PlanSignIn({ path }: { path: string }) {
  const { data } = useSWR<PlanInfo>("/api/agents/oauth/chatgpt", { revalidateOnFocus: false, shouldRetryOnError: false });
  const start = data?.startPath ?? path;
  const href = data && !data.loopback && data.signInOrigin ? `${data.signInOrigin}${start}` : start;
  return (
    <div className="space-y-2 rounded-xl border border-line bg-panel-2/60 p-3">
      <p className="text-[13px] leading-relaxed text-fg-2">{data?.eligibility ?? ELIGIBILITY_NOTE}</p>
      {data && !data.loopback && (
        <p className="text-[13px] leading-relaxed text-degraded">Signing in works only on a console opened at 127.0.0.1 (OpenAI allows a loopback redirect only). The button opens it there.</p>
      )}
      <a href={href} className="press inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[14px] font-medium text-primary-fg hover:bg-primary-hover pointer-coarse:h-10">
        <LogIn className="size-4" aria-hidden /> Sign in with ChatGPT
      </a>
    </div>
  );
}

export function ConnectionForm({ providers, endpoints, admin, onDone, onCancel }: {
  providers: ProviderOptionLike[];
  endpoints: EndpointEntry[];
  admin: boolean;
  onDone(c: ConnectionView): void;
  onCancel(): void;
}) {
  const usable = providers.filter((p) => p.canCreate !== false || p.signIn);
  const [pid, setPid] = useState<ProviderOptionLike["id"] | undefined>(usable[0]?.id);
  const spec = providers.find((p) => p.id === pid);
  const [draft, setDraft] = useState<ConnectionDraft | null>(spec ? emptyDraft(spec) : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof ConnectionDraft>(k: K, v: ConnectionDraft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setSecret = (k: SecretFieldKey, v: string) => setDraft((d) => (d ? { ...d, secret: { ...d.secret, [k]: v } } : d));
  const choices = useMemo(() => (spec && draft ? endpointChoices(spec, draft.scope, endpoints) : []), [spec, draft, endpoints]);

  const pick = (id: string) => {
    const p = providers.find((x) => x.id === id);
    setPid(p?.id);
    setDraft(p ? emptyDraft(p) : null); // a new provider starts clean: no secret carries over
    setErr(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!spec || !draft || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await postJson<{ connection: ConnectionView }>("/api/agents/connections", connectionBody(draft, spec, { admin }));
      onDone(r.connection);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const orgAllowed = admin && !spec?.personalOnly;
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
        <fieldset>
          <legend className="mb-1.5 text-[13.5px] font-medium text-fg-2">Provider</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {providers.map((p) => {
              const off = p.canCreate === false && !p.signIn;
              return (
                <label
                  key={p.id}
                  title={off ? p.why : undefined}
                  className={cx(
                    "press flex cursor-pointer gap-2.5 rounded-xl border p-2.5 transition-colors [--press-scale:0.985]",
                    pid === p.id ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong hover:bg-panel-2",
                    off && "cursor-not-allowed opacity-50",
                  )}
                >
                  <input type="radio" name="provider" value={p.id} checked={pid === p.id} disabled={off} onChange={() => pick(p.id)} className="mt-0.5 accent-[var(--accent)]" />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium">{p.label}</span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{off ? p.why : p.authKinds.map((a) => AUTH_LABEL[a]).join(" or ")}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {spec?.note && <p className="rounded-xl border border-line bg-panel-2/60 px-3 py-2 text-[13px] leading-relaxed text-fg-2">{spec.note}</p>}

        {spec?.signIn ? (
          <PlanSignIn path={spec.signIn} />
        ) : spec && draft ? (
          <>
            <TextInput label="Name" required maxLength={80} value={draft.label} onChange={(e) => set("label", e.target.value)} hint="Shown wherever a run uses it." />
            {spec.authKinds.length > 1 && (
              <FormField label="Authentication">
                {(id) => (
                  <Select id={id} value={draft.authKind} onChange={(v) => setDraft({ ...draft, authKind: v as ConnectionDraft["authKind"], secret: {} })} base={INPUT} options={spec.authKinds.map((a) => ({ value: a, label: AUTH_LABEL[a] }))} />
                )}
              </FormField>
            )}
            {orgAllowed && (
              <fieldset>
                <legend className="mb-1.5 text-[13.5px] font-medium text-fg-2">Who may use it</legend>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {(["personal", "org"] as const).map((s) => (
                    <label key={s} className={cx("press flex cursor-pointer gap-2.5 rounded-xl border p-2.5 [--press-scale:0.985]", draft.scope === s ? "border-accent/60 bg-accent-soft" : "border-line hover:bg-panel-2")}>
                      <input type="radio" name="scope" checked={draft.scope === s} onChange={() => setDraft({ ...draft, scope: s, endpoint: "" })} className="mt-0.5 accent-[var(--accent)]" />
                      <span>
                        <span className="block text-[14px] font-medium">{s === "personal" ? "Only me" : "The organisation"}</span>
                        <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{s === "personal" ? "Never shared, not even with admins." : "People with at least the role below; the organisation pays."}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {orgAllowed && draft.scope === "org" && (
              <FormField label="Least role that may use it">
                {(id) => (
                  <Select id={id} value={draft.minRole} onChange={(v) => set("minRole", v)} base={INPUT} options={ROLES.map((r) => ({ value: r, label: r }))} />
                )}
              </FormField>
            )}
            {spec.endpoint && (
              <FormField
                label="Endpoint"
                hint={choices.length ? "Built-in, or one an admin registered. A connection can't point anywhere else." : "No endpoint is registered for this provider yet — an admin adds them under Endpoints."}
              >
                {(id, hintId) => (
                  <Select
                    id={id}
                    aria-describedby={hintId}
                    value={draft.endpoint}
                    onChange={(v) => set("endpoint", v)}
                    disabled={!choices.length}
                    base={INPUT}
                    placeholder="Choose a registered endpoint…"
                    options={choices.map((c) => ({ value: c.value, label: c.label }))}
                  />
                )}
              </FormField>
            )}
            {spec.region && <TextInput label="Region" required value={draft.region} onChange={(e) => set("region", e.target.value.trim())} placeholder="eu-west-1" pattern="[a-z]{2}(-gov)?-[a-z]+-\d" hint="Where the model runs (cross-region inference profiles can process prompts elsewhere)." />}
            <TextInput label="Model (optional)" value={draft.model} onChange={(e) => set("model", e.target.value)} placeholder={spec.id === "scripted" ? "incident-demo" : "the provider's default"} hint="Test the connection to see the models it offers." />
            {secretFields(draft.authKind).length > 0 && (
              <fieldset className="space-y-3 rounded-xl border border-line p-3">
                <legend className="flex items-center gap-1.5 px-1 text-[13.5px] font-medium text-fg-2">
                  <KeyRound className="size-3.5" aria-hidden /> {spec.secret?.label ?? "Secret"} <Chip tone="muted">write-only</Chip>
                </legend>
                {spec.secret?.hint && <p className="text-[12.5px] leading-snug text-fg-3">{spec.secret.hint}</p>}
                {secretFields(draft.authKind).map((f) => (
                  <TextInput
                    key={f.key}
                    label={f.label + (f.required ? "" : " (optional)")}
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    spellCheck={false}
                    required={f.required}
                    value={draft.secret[f.key] ?? ""}
                    onChange={(e) => setSecret(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    hint={f.hint}
                  />
                ))}
                <p className="text-[12.5px] leading-snug text-fg-3">Sealed on save and never shown again — not to you, not to an agent. Rotate it to replace it.</p>
              </fieldset>
            )}
            <label className="flex cursor-pointer items-start gap-2.5 text-[14px]">
              <input type="checkbox" checked={draft.backgroundOk} onChange={(e) => set("backgroundOk", e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
              <span>
                <span className="font-medium">Allow background runs</span>
                <span className="block text-[12.5px] leading-snug text-fg-3">Scheduled and event-triggered workflows may use it while nobody is watching.</span>
              </span>
            </label>
          </>
        ) : (
          <p className="text-[14px] text-fg-3">No provider is available to you here.</p>
        )}
        {err && <div role="alert" className="rounded-lg border border-down/25 bg-down/10 px-3 py-2 text-[13.5px] leading-snug text-down">{err}</div>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3.5">
        <Link href="/docs/automation#model-connections" className="inline-flex items-center gap-1 text-[13px] text-fg-3 underline decoration-line-strong underline-offset-2 hover:text-fg-2">
          How connections work <ExternalLink className="size-3" aria-hidden />
        </Link>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          {!spec?.signIn && (
            <Button type="submit" variant="primary" disabled={busy || !spec || !draft || !draftReady(draft, spec)}>
              {busy && <Loader2 className="size-4 animate-spin" />} Connect
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
