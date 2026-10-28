"use client";
// Connect your agent: point an MCP client you already use — Claude Code, Gemini CLI, any client that speaks MCP over
// HTTP — at this console. It gets an agent token (da_…) bound to an agent definition's policy (a template such as the
// incident investigator, or one of your own) with an expiry, or a classic API token (dc_…). The token is shown once.
// The client's own subscription or API key pays for its model: the console never sees or stores that login, and the
// token only lets the client call this console's operations as your delegate, inside the policy.
import { AnimatePresence } from "motion/react";
import { Bot, Check, Info, KeyRound, Loader2, Terminal } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useToast } from "@/components/toast";
import { Button, Chip, Segmented, cx, useNow } from "@/components/ui";
import type { Me } from "@/components/user-menu";
import { MODE_LABEL, TEMPLATES, TOKEN_PLACEHOLDER, clientConfigs, agentTokenStatus } from "@/components/agents/rules";
import type { AgentTokenItem, DefinitionItem } from "@/components/agents/types";
import { postJson } from "@/lib/client/api";
import type { TokenItem } from "@/lib/server/auth/api-tokens";
import { SectionTitle } from "../_components/page-frame";
import { CopyButton, CreateDialog, Snippet } from "./tokens-tab";

type Client = "claude" | "gemini" | "other";
type Kind = "agent" | "classic";

interface Minted {
  token: string;
  name: string;
  kind: Kind;
  expiresAt: number | null;
  origin: string;
}

const DAYS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;

const originOf = (mcpUrl: string | undefined) => (mcpUrl ? mcpUrl.replace(/\/api\/mcp\/?$/, "") : typeof window === "undefined" ? "" : window.location.origin);

export function ConnectTab({ me }: { me: Me }) {
  const [kind, setKind] = useState<Kind>("agent");
  const [client, setClient] = useState<Client>("claude");
  const [minted, setMinted] = useState<Minted | null>(null);
  const [classic, setClassic] = useState(false);
  const { mutate } = useSWRConfig();
  const origin = minted?.origin ?? (typeof window === "undefined" ? "" : window.location.origin);
  const configs = useMemo(() => clientConfigs(origin, minted?.token ?? TOKEN_PLACEHOLDER), [origin, minted]);

  return (
    <div className="space-y-6">
      <div className="flex gap-3 rounded-2xl border border-line bg-panel-2/60 px-4 py-3 text-[14px] leading-relaxed text-fg-2">
        <Info className="mt-0.5 size-4 flex-none text-fg-3" aria-hidden />
        <p>
          Your agent runs on your machine with <b className="font-medium text-fg">its own subscription or API key</b> — that pays for the model, and the console never sees or stores that login. The token you create here only lets it call this console&apos;s operations
          and MCP tools as <b className="font-medium text-fg">your delegate</b>: never with more access than you have now, inside the agent policy you pick, with changes waiting for approval.
        </p>
      </div>

      <section className="space-y-3" aria-labelledby="connect-step1">
        <SectionTitle>
          <span id="connect-step1">1 · A token for it</span>
        </SectionTitle>
        <Segmented
          id="connect-kind"
          value={kind}
          onChange={(k) => setKind(k)}
          options={[
            { value: "agent", label: "Agent token (recommended)" },
            { value: "classic", label: "Classic API token" },
          ]}
        />
        {kind === "agent" ? (
          <AgentTokenForm
            onMinted={async (m) => {
              setMinted(m);
              await mutate((k) => typeof k === "string" && k.startsWith("/api/agents/tokens"));
            }}
          />
        ) : (
          <div className="rounded-2xl border border-line bg-panel p-4 shadow-card">
            <p className="text-[14px] leading-relaxed text-fg-2">
              A classic token (<code className="font-mono text-[13px]">dc_…</code>) acts with a role and a mode (read, propose, act) instead of an agent policy. Use it for scripts; prefer an agent token for AI clients — its policy limits scope, tools and
              budget, and every call lands on a run you can follow.
            </p>
            <Button variant="primary" className="mt-3" onClick={() => setClassic(true)}>
              <KeyRound className="size-4" /> New API token
            </Button>
          </div>
        )}
        <ExistingTokens />
      </section>

      <section className="space-y-3" aria-labelledby="connect-step2">
        <SectionTitle>
          <span id="connect-step2">2 · Configure your client</span>
        </SectionTitle>
        {minted ? (
          <div className="space-y-2 rounded-2xl border border-accent/40 bg-accent-soft/60 p-4">
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <Check className="size-4 text-up" aria-hidden />
              <b className="font-medium">{minted.name}</b>
              <Chip tone={minted.kind === "agent" ? "accent" : "muted"}>{minted.kind === "agent" ? "agent token" : "API token"}</Chip>
              <span className="text-fg-3">This is the only time it is shown — the console keeps only a hash.</span>
            </div>
            <div className="flex gap-2">
              <input readOnly value={minted.token} onFocus={(e) => e.currentTarget.select()} aria-label="Your new token" className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 font-mono text-[13px] text-fg outline-none focus:border-accent" />
              <CopyButton text={minted.token} variant="primary" />
            </div>
          </div>
        ) : (
          <p className="text-[13.5px] text-fg-3">
            Create a token above and the snippets fill it in. With a token you already have, replace <code className="font-mono">{TOKEN_PLACEHOLDER}</code> yourself.
          </p>
        )}
        <Segmented
          id="connect-client"
          value={client}
          onChange={setClient}
          options={[
            { value: "claude", label: "Claude Code" },
            { value: "gemini", label: "Gemini CLI" },
            { value: "other", label: "Other MCP client" },
          ]}
        />
        <div className={cx("space-y-4 rounded-2xl border border-line bg-panel p-4 shadow-card")}>
          {client === "claude" ? (
            <>
              <Snippet title="Run once in a terminal (adds the server to Claude Code)" text={configs.claudeCode} wrap />
              <Snippet title="…or put this in your project's .mcp.json" text={configs.mcpJson} />
              <p className="text-[13px] leading-relaxed text-fg-3">
                Then ask Claude Code something like “why is checkout degraded in staging?”. It calls this console&apos;s tools; changes it proposes appear in Approvals. Claude Code&apos;s own plan or API key pays for the model.
              </p>
            </>
          ) : client === "gemini" ? (
            <>
              <Snippet title="Add to ~/.gemini/settings.json (or the project's .gemini/settings.json)" text={configs.gemini} />
              <p className="text-[13px] leading-relaxed text-fg-3">Needs Gemini CLI 0.11 or newer (HTTP MCP servers). Your Google account or Gemini API key pays for the model.</p>
            </>
          ) : (
            <>
              <Snippet title="Any MCP client: Streamable HTTP, URL and bearer header (this JSON works for most)" text={configs.mcpJson} />
              <Snippet title="Check it with curl (initialize, then tools/list)" text={configs.curl} />
            </>
          )}
        </div>
      </section>

      <AnimatePresence>
        {classic && (
          <CreateDialog
            key="classic"
            me={me}
            onClose={() => setClassic(false)}
            onDone={async (r: { token: string; item: TokenItem }) => {
              setClassic(false);
              setMinted({ token: r.token, name: r.item.name, kind: "classic", expiresAt: r.item.expiresAt ?? null, origin: window.location.origin });
              await mutate((k) => typeof k === "string" && k.startsWith("/api/tokens"));
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function AgentTokenForm({ onMinted }: { onMinted(m: Minted): void }) {
  const toast = useToast();
  const defs = useSWR<{ definitions: DefinitionItem[] }>("/api/agents/definitions", { revalidateOnFocus: false, shouldRetryOnError: false });
  const stored = (defs.data?.definitions ?? []).filter((d) => !d.archivedAt && !d.builtIn); // templates are offered separately
  const [definitionId, setDefinitionId] = useState<string>("incident-investigator");
  const [name, setName] = useState("claude-code");
  const [days, setDays] = useState<(typeof DAYS)[number]["value"]>("30");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tpl = TEMPLATES.find((t) => t.id === definitionId);
  const def = stored.find((d) => d.id === definitionId);
  const mode = tpl?.mode ?? def?.mode;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await postJson<{ token: string; id: string; expiresAt: number; mcpUrl?: string }>("/api/agents/tokens", { name: name.trim(), definitionId, days: Number(days) });
      onMinted({ token: r.token, name: name.trim(), kind: "agent", expiresAt: r.expiresAt, origin: originOf(r.mcpUrl) });
      toast.push({ tone: "ok", title: "Agent token created", body: "Copy it now — it is shown once." });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-line bg-panel p-4 shadow-card">
      <fieldset>
        <legend className="mb-1.5 text-[13.5px] font-medium text-fg-2">What it may do (the agent&apos;s policy)</legend>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {[...TEMPLATES.filter((t) => t.llm).map((t) => ({ id: t.id, name: t.name, mode: t.mode, blurb: t.blurb, mine: false })), ...stored.map((d) => ({ id: d.id, name: d.name, mode: d.mode, blurb: `Your definition, version ${d.version}.`, mine: true }))].map((o) => (
            <label key={o.id} className={cx("press flex cursor-pointer gap-2.5 rounded-xl border p-2.5 transition-colors [--press-scale:0.985]", definitionId === o.id ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong hover:bg-panel-2")}>
              <input type="radio" name="definition" value={o.id} checked={definitionId === o.id} onChange={() => setDefinitionId(o.id)} className="mt-0.5" />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 text-[14px] font-medium">
                  {o.mine ? <Bot className="size-3.5 text-fg-3" aria-hidden /> : null}
                  {o.name}
                  <Chip tone={MODE_LABEL[o.mode]?.tone}>{MODE_LABEL[o.mode]?.label ?? o.mode}</Chip>
                </span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{o.blurb}</span>
              </span>
            </label>
          ))}
        </div>
        {mode && <p className="mt-1.5 text-[12.5px] text-fg-3">{MODE_LABEL[mode]?.hint}</p>}
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-0 flex-1 basis-56">
          <span className="mb-1.5 block text-[13.5px] font-medium text-fg-2">Name</span>
          <input
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="claude-code on my laptop"
            className="h-10 w-full rounded-lg border border-line bg-panel-2 px-3 text-[14.5px] text-fg outline-none placeholder:text-fg-3 focus:border-accent focus:bg-panel pointer-coarse:h-11"
          />
        </label>
        <div>
          <div className="mb-1.5 text-[13.5px] font-medium text-fg-2">Expires after</div>
          <Segmented id="agent-token-days" value={days} onChange={setDays} options={DAYS.map((d) => ({ value: d.value, label: d.label }))} />
        </div>
        <Button type="submit" variant="primary" disabled={busy || !name.trim()} className="max-sm:w-full">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Terminal className="size-4" />} Create agent token
        </Button>
      </div>
      {err && <div role="alert" className="rounded-lg border border-down/25 bg-down/10 px-3 py-2 text-[13.5px] text-down">{err}</div>}
    </form>
  );
}

// The person's active agent tokens, to pick one for the snippets (its value isn't shown again — paste it yourself).
function ExistingTokens() {
  const { data } = useSWR<{ tokens: AgentTokenItem[] }>("/api/agents/tokens", { refreshInterval: 60_000 });
  const now = useNow();
  const active = (data?.tokens ?? []).filter((t) => t.kind === "external" && agentTokenStatus(t, now) === "active");
  if (!active.length) return null;
  return (
    <p className="text-[13px] leading-relaxed text-fg-3">
      Already have one? Your active agent tokens: {active.slice(0, 5).map((t, i) => (
        <span key={t.id}>
          {i > 0 && ", "}
          <span className="text-fg-2">{t.name ?? t.prefix}</span> <span className="font-mono">({t.prefix}…)</span>
        </span>
      ))}
      {active.length > 5 ? ` and ${active.length - 5} more` : ""}. Manage them under <a href="#tokens" className="underline decoration-line-strong underline-offset-2 hover:text-fg-2">API tokens</a>.
    </p>
  );
}
