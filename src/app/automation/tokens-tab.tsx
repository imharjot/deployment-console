"use client";
// API tokens: create (role ≤ yours, a mode, an expiry), shown once; list with last use; revoke. Admins can see and
// revoke everyone's. The token string exists only in the create response — the console keeps its hash.
// Below them, agent tokens (da_…, made under "Connect your agent"): each bound to an agent definition's policy, with
// its own run; revoking one ends that run and withdraws its pending requests. Active tokens first (F45).
import { AnimatePresence } from "motion/react";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useConfirm } from "@/components/confirm";
import { Modal } from "@/components/motion";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, IconButton, Segmented, Skeleton, TimeAgo, copy, cx, useNow } from "@/components/ui";
import { agentTokenStatus } from "@/components/agents/rules";
import type { AgentTokenItem } from "@/components/agents/types";
import { ROLE_INFO, RoleChip, type Me } from "@/components/user-menu";
import { MODE_INFO, TOKEN_MODES, roleAtMost, type TokenMode } from "@/lib/automation";
import { postJson } from "@/lib/client/api";
import { filterTokens, stamp, tokenCounts, type TokenFilter } from "@/lib/client/format";
import { ROLES, type Role } from "@/lib/rbac";
import type { TokenItem } from "@/lib/server/auth/api-tokens";
import { DataTable, type Column } from "../_components/data-table";
import { SectionTitle } from "../_components/page-frame";
import { Until } from "./approvals-tab";
import { Field, FormError } from "../login/auth-card";

const EXPIRY = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "never", label: "Never" },
] as const;
type Expiry = (typeof EXPIRY)[number]["value"];

const MODE_TONE: Record<TokenMode, "muted" | "accent" | "warn"> = { read: "muted", propose: "accent", act: "warn" };

export function useEscape(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, enabled]);
}

export function TokensTab({ me }: { me: Me }) {
  const admin = me.perms.includes("admin");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const key = scope === "all" && admin ? "/api/tokens?all=1" : "/api/tokens";
  const { data, error, isLoading } = useSWR<{ tokens: TokenItem[]; enabled?: boolean }>(key, { refreshInterval: 30_000 });
  const { mutate } = useSWRConfig();
  const ask = useConfirm();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<{ token: string; item: TokenItem } | null>(null);
  // Active tokens first: expired and revoked ones are history (F45).
  const [filter, setFilter] = useState<TokenFilter>("active");
  const counts = tokenCounts(data?.tokens ?? []);
  const rows = filterTokens(data?.tokens ?? [], filter);
  const refresh = () => mutate((k) => typeof k === "string" && k.startsWith("/api/tokens"));

  const revoke = (t: TokenItem) =>
    ask({
      env: "",
      title: `Revoke "${t.name}"?`,
      description: "Anything using it stops working on its next request, and its pending approval requests are rejected. This can't be undone.",
      danger: true,
      expected: "yes",
      confirmLabel: "Revoke token",
      run: async () => {
        const res = await fetch(`/api/tokens/${t.id}`, { method: "DELETE", headers: { "x-console-csrf": "1" } });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
        toast.push({ tone: "ok", title: `${t.name} revoked` });
        await refresh();
      },
    });

  const columns: Column<TokenItem>[] = [
    {
      key: "name",
      header: "Token",
      slot: "title",
      cell: (t) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{t.name}</div>
          <div className="font-mono text-[12px] text-fg-3">{t.prefix}…</div>
        </div>
      ),
    },
    { key: "status", header: "Status", slot: "end", cell: (t) => <Chip tone={t.status === "active" ? "ok" : "muted"}>{t.status}</Chip> },
    {
      key: "access",
      header: "Access",
      label: "Access",
      cell: (t) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <RoleChip role={t.role} />
          <Chip tone={MODE_TONE[t.mode]}>{MODE_INFO[t.mode].label}</Chip>
        </span>
      ),
    },
    ...(scope === "all" ? [{ key: "owner", header: "Owner", label: "owner", slot: "meta" as const, className: "text-fg-2 @max-2xl:[overflow-wrap:anywhere]", cell: (t: TokenItem) => t.owner.email ?? "deleted user" }] : []),
    {
      key: "used",
      header: "Last used",
      label: "used",
      slot: "meta",
      className: "whitespace-nowrap text-fg-2",
      cell: (t) => (t.lastUsedAt ? <span title={`${stamp(t.lastUsedAt)} · ${t.uses} operation call${t.uses === 1 ? "" : "s"}`}><TimeAgo at={t.lastUsedAt} /></span> : <span className="text-fg-3">never</span>),
    },
    {
      key: "expires",
      header: "Expires",
      label: "expires",
      slot: "meta",
      className: "whitespace-nowrap text-fg-2",
      cell: (t) => (t.revokedAt ? <span title={stamp(t.revokedAt)}>revoked</span> : t.expiresAt ? t.status === "expired" ? <span title={stamp(t.expiresAt)}>expired</span> : <Until at={t.expiresAt} /> : "never"),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      slot: "actions",
      className: "px-3",
      cell: (t) =>
        t.status !== "revoked" && (
          <IconButton label={`Revoke ${t.name}`} onClick={() => revoke(t)} className="hover:!text-down">
            <Trash2 className="size-4" />
          </IconButton>
        ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-[14px] leading-relaxed text-fg-3">
          A token lets an agent or script use the <a href="#operations" className="text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg">operations API</a> and the MCP endpoint as you — never with more access than you have, and never pages, users, settings or variable values.
        </p>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Segmented
            id="token-status"
            size="sm"
            value={filter}
            onChange={setFilter}
            options={(["active", "expired", "revoked", "all"] as const).map((f) => ({
              value: f,
              label: (
                <span className="inline-flex items-center gap-1">
                  {f === "all" ? "All" : f[0].toUpperCase() + f.slice(1)}
                  <span className="tabular-nums text-fg-3">{counts[f]}</span>
                </span>
              ),
            }))}
          />
          {admin && <Segmented id="token-scope" size="sm" value={scope} onChange={setScope} options={[{ value: "mine", label: "Mine" }, { value: "all", label: "Everyone" }]} />}
          <Button variant="primary" onClick={() => setCreating(true)} disabled={data?.enabled === false} className="max-sm:flex-1">
            <Plus className="size-4" /> New token
          </Button>
        </div>
      </div>

      {data?.enabled === false && (
        <p className="rounded-xl border border-line bg-panel-2 px-4 py-3 text-[14px] text-fg-2">
          API tokens are turned off on this console (<code className="font-mono text-[13px]">CONSOLE_API_TOKENS=false</code>): agents can&apos;t connect and no new token can be created. Existing tokens can still be revoked.
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
        {isLoading ? (
          <div className="space-y-px p-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : error ? (
          <Empty title="Couldn't load tokens" hint={(error as Error).message} />
        ) : rows.length ? (
          <DataTable label="API tokens" rows={rows} rowKey={(t) => t.id} columns={columns} rowClassName={(t) => t.status !== "active" && "opacity-60"} />
        ) : data?.tokens.length ? (
          <Empty title={`No ${filter} tokens`} hint={`${counts.all} token${counts.all === 1 ? "" : "s"} in all — pick another filter to see them.`} />
        ) : (
          <Empty icon={<KeyRound className="size-5" />} title="No tokens yet" hint="Create one for an agent (Claude Desktop, Claude Code, your own script) and paste it into its configuration." />
        )}
      </div>

      <AnimatePresence>
        {creating && (
          <CreateDialog
            key="create"
            me={me}
            onClose={() => setCreating(false)}
            onDone={async (r) => {
              setCreating(false);
              setShown(r);
              await refresh();
            }}
          />
        )}
        {shown && <RevealDialog key="reveal" token={shown.token} item={shown.item} onClose={() => setShown(null)} />}
      </AnimatePresence>

      <AgentTokens admin={admin} />
    </div>
  );
}

function AgentTokens({ admin }: { admin: boolean }) {
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [filter, setFilter] = useState<TokenFilter>("active");
  const key = scope === "all" && admin ? "/api/agents/tokens?all=1" : "/api/agents/tokens";
  const { data, error, isLoading } = useSWR<{ tokens: AgentTokenItem[] }>(key, { refreshInterval: 30_000 });
  const { mutate } = useSWRConfig();
  const ask = useConfirm();
  const toast = useToast();
  const now = useNow();
  const list = (data?.tokens ?? []).filter((t) => t.kind === "external").map((t) => ({ ...t, status: agentTokenStatus(t, now) }));
  const counts = tokenCounts(list);
  const rows = filterTokens(list, filter);
  const revoke = (t: AgentTokenItem) =>
    ask({
      env: "",
      title: `Revoke "${t.name ?? t.prefix}"?`,
      description: "The agent using it stops at its next call, its run ends and its pending approval requests are withdrawn. This can't be undone.",
      danger: true,
      expected: "yes",
      confirmLabel: "Revoke token",
      run: async () => {
        const res = await fetch(`/api/agents/tokens/${t.id}`, { method: "DELETE", headers: { "x-console-csrf": "1" } });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
        toast.push({ tone: "ok", title: `${t.name ?? t.prefix} revoked` });
        await mutate((k) => typeof k === "string" && k.startsWith("/api/agents/tokens"));
      },
    });
  const columns: Column<AgentTokenItem & { status: TokenFilter }>[] = [
    {
      key: "name",
      header: "Agent token",
      slot: "title",
      cell: (t) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{t.name ?? "unnamed"}</div>
          <div className="font-mono text-[12px] text-fg-3">{t.prefix}…</div>
        </div>
      ),
    },
    { key: "status", header: "Status", slot: "end", cell: (t) => <Chip tone={t.status === "active" ? "ok" : "muted"}>{t.status}</Chip> },
    {
      key: "policy",
      header: "Policy",
      label: "policy",
      slot: "meta",
      className: "text-fg-2",
      cell: (t) => (t.definitionId ? <span className="font-mono text-[13px]">{t.definitionId}{t.definitionVersion ? ` v${t.definitionVersion}` : ""}</span> : null),
    },
    ...(scope === "all" ? [{ key: "owner", header: "Acts for", label: "for", slot: "meta" as const, className: "text-fg-2 @max-2xl:[overflow-wrap:anywhere]", cell: (t: AgentTokenItem) => t.owner?.email ?? "deleted user" }] : []),
    { key: "run", header: "Run", label: "run", slot: "meta", cell: (t) => (t.runId ? <a href={`#runs/${t.runId}`} className="font-mono text-[13px] text-fg-2 hover:underline">{t.runId.slice(0, 8)}</a> : null) },
    {
      key: "used",
      header: "Last used",
      label: "used",
      slot: "meta",
      className: "whitespace-nowrap text-fg-2",
      cell: (t) => (t.lastUsedAt ? <span title={`${stamp(t.lastUsedAt)} · ${t.uses} call${t.uses === 1 ? "" : "s"}`}><TimeAgo at={t.lastUsedAt} /></span> : <span className="text-fg-3">never</span>),
    },
    {
      key: "expires",
      header: "Expires",
      label: "expires",
      slot: "meta",
      className: "whitespace-nowrap text-fg-2",
      cell: (t) => (t.revokedAt ? <span title={stamp(t.revokedAt)}>revoked</span> : t.expiresAt ? t.status === "expired" ? <span title={stamp(t.expiresAt)}>expired</span> : <Until at={t.expiresAt} /> : "never"),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      slot: "actions",
      className: "px-3",
      cell: (t) =>
        t.status === "active" && (
          <IconButton label={`Revoke ${t.name ?? t.prefix}`} onClick={() => revoke(t)} className="hover:!text-down">
            <Trash2 className="size-4" />
          </IconButton>
        ),
    },
  ];
  return (
    <section className="space-y-3 pt-2" aria-label="Agent tokens">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <SectionTitle>Agent tokens</SectionTitle>
          <p className="mt-1 text-[14px] leading-relaxed text-fg-3">
            Tokens for MCP clients such as Claude Code or Gemini CLI, each bound to an agent policy. Make one under <a href="#connect" className="text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg">Connect your agent</a>.
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Segmented
            id="agent-token-status"
            size="sm"
            value={filter}
            onChange={setFilter}
            options={(["active", "expired", "revoked", "all"] as const).map((f) => ({
              value: f,
              label: (
                <span className="inline-flex items-center gap-1">
                  {f === "all" ? "All" : f[0].toUpperCase() + f.slice(1)}
                  <span className="tabular-nums text-fg-3">{counts[f]}</span>
                </span>
              ),
            }))}
          />
          {admin && <Segmented id="agent-token-scope" size="sm" value={scope} onChange={setScope} options={[{ value: "mine", label: "Mine" }, { value: "all", label: "Everyone" }]} />}
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
        {isLoading ? (
          <div className="space-y-px p-2">{Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : error ? (
          <Empty title="Couldn't load agent tokens" hint={(error as Error).message} />
        ) : rows.length ? (
          <DataTable label="Agent tokens" rows={rows} rowKey={(t) => t.id} columns={columns} rowClassName={(t) => t.status !== "active" && "opacity-60"} />
        ) : list.length ? (
          <Empty title={`No ${filter} agent tokens`} hint={`${counts.all} in all — pick another filter to see them.`} />
        ) : (
          <Empty icon={<KeyRound className="size-5" />} title="No agent tokens yet" />
        )}
      </div>
    </section>
  );
}

export function CreateDialog({ me, onClose, onDone }: { me: Me; onClose(): void; onDone(r: { token: string; item: TokenItem }): void }) {
  const roles = ROLES.filter((r) => roleAtMost(r, me.user.role));
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(me.user.role === "admin" ? "operator" : me.user.role);
  const [mode, setMode] = useState<TokenMode>("propose");
  const [expiry, setExpiry] = useState<Expiry>("30");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEscape(onClose, !busy);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      onDone(await postJson<{ token: string; item: TokenItem }>("/api/tokens", { name, role, mode, expiresInDays: expiry === "never" ? null : Number(expiry) }));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const radio = (on: boolean) => cx("press flex cursor-pointer gap-2.5 rounded-xl border p-2.5 transition-colors [--press-scale:0.985]", on ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong hover:bg-panel-2");
  return (
    <Modal onClose={busy ? undefined : onClose} aria-labelledby="token-title" className="max-w-lg">
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div>
            <h2 id="token-title" className="font-display text-[26px] leading-tight">New API token</h2>
            <p className="mt-1 text-[13.5px] leading-relaxed text-fg-3">For one agent or script. You&apos;ll see the token once; keep it in that tool&apos;s secret settings.</p>
          </div>
          <IconButton type="button" label="Close" onClick={onClose} disabled={busy}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
          <Field label="Name" required autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. claude-desktop or release-bot" hint="Shown in the audit log next to everything it does." />
          <fieldset>
            <legend className="mb-1.5 text-[13.5px] font-medium text-fg-2">What it may do</legend>
            <div className="grid gap-1.5">
              {TOKEN_MODES.map((m) => (
                <label key={m} className={radio(mode === m)}>
                  <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="mt-0.5" />
                  <span>
                    <span className="block text-[14px] font-medium">{MODE_INFO[m].label}</span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{MODE_INFO[m].hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-1.5 text-[13.5px] font-medium text-fg-2">Role (at most yours)</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {roles.map((r) => (
                <label key={r} className={radio(role === r)}>
                  <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="mt-0.5" />
                  <span>
                    <span className="block text-[14px] font-medium">{ROLE_INFO[r].label}</span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{ROLE_INFO[r].hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <div className="mb-1.5 text-[13.5px] font-medium text-fg-2" id="expiry-label">Expires after</div>
            <Segmented id="token-expiry" value={expiry} onChange={setExpiry} options={EXPIRY.map((x) => ({ value: x.value, label: x.label }))} />
          </div>
          <FormError error={err} />
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy && <Loader2 className="size-4 animate-spin" />} Create token
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function CopyButton({ text, label = "Copy", variant = "secondary" }: { text: string; label?: string; variant?: "primary" | "secondary" }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      onClick={async () => {
        await copy(text);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {done ? "Copied" : label}
    </Button>
  );
}

function RevealDialog({ token, item, onClose }: { token: string; item: TokenItem; onClose(): void }) {
  useEscape(onClose);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const mcp = JSON.stringify({ mcpServers: { "deployment-console": { type: "http", url: `${origin}/api/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  const curl = `curl -sS -H "Authorization: Bearer ${token}" ${origin}/api/ops/envs.list -X POST -H "Content-Type: application/json" -d '{"input":{}}'`;
  return (
    <Modal onClose={onClose} aria-labelledby="reveal-title" className="max-w-xl">
      <div className="min-h-0 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="reveal-title" className="font-display text-[26px] leading-tight">Copy your token</h2>
            <p className="mt-1 text-[13.5px] leading-relaxed text-fg-3">
              <b className="font-medium text-fg-2">{item.name}</b> · {ROLE_INFO[item.role].label} · {MODE_INFO[item.mode].label}. This is the only time it is shown — the console keeps only a hash. Treat it like a password.
            </p>
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="mt-4 flex gap-2">
          <input readOnly value={token} onFocus={(e) => e.currentTarget.select()} aria-label="API token" className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-3 font-mono text-[13px] text-fg outline-none focus:border-accent" />
          <CopyButton text={token} variant="primary" />
        </div>
        <div className="mt-5 space-y-4">
          <Snippet title="Try it" text={curl} />
          <Snippet title="MCP config (Claude Code .mcp.json, or any MCP client that takes an HTTP URL with headers)" text={mcp} />
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="ghost" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}

export function Snippet({ title, text, wrap }: { title: string; text: string; wrap?: boolean }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-fg-2">{title}</span>
        <CopyButton text={text} />
      </div>
      <pre className={cx("max-h-48 overflow-auto rounded-xl border border-line bg-panel-2 p-3 font-mono text-[12.5px] leading-relaxed text-fg-2", wrap && "whitespace-pre-wrap [overflow-wrap:anywhere]")}>{text}</pre>
    </div>
  );
}
