"use client";
import { AnimatePresence } from "motion/react";
import { Ban, Check, CircleCheck, Copy, KeyRound, Loader2, Lock, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import useSWR from "swr";
import { useConfirm } from "@/components/confirm";
import { Modal } from "@/components/motion";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, IconButton, Skeleton, TimeAgo, copy, cx } from "@/components/ui";
import { Avatar, ROLE_INFO, RoleChip, useMe, type Me } from "@/components/user-menu";
import { postJson } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { ROLES, type Role } from "@/lib/rbac";
import { DataTable, type Column } from "../../_components/data-table";
import { Field, FormError } from "../../login/auth-card";

interface Item {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  disabled: boolean;
  hasPassword: boolean;
  invitePending: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

interface LinkShown {
  title: string;
  email: string;
  url: string;
}

// PATCH / DELETE with the CSRF header (postJson covers POST only).
async function send(method: "PATCH" | "DELETE", url: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", "x-console-csrf": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

const selectCls = "h-8 rounded-lg border border-line bg-panel px-2 text-[13.5px] text-fg outline-none transition-colors hover:border-line-strong focus:border-accent disabled:opacity-50 pointer-coarse:h-10";

export default function UsersPage() {
  const { data: me, error } = useMe();
  if (error) return <Empty title="Couldn't load your account" hint={(error as Error).message} />;
  if (!me) return <Skeleton className="h-64 rounded-2xl" />;
  if (!me.perms.includes("admin"))
    return (
      <div className="rounded-2xl border border-line bg-panel shadow-card">
        <Empty icon={<Lock className="size-6" />} title="Admins only" hint={`Managing users and roles needs the admin role. You're signed in as ${ROLE_INFO[me.user.role].label.toLowerCase()}.`} />
      </div>
    );
  return <UsersAdmin me={me} />;
}

function UsersAdmin({ me }: { me: Me }) {
  const { data, error, isLoading, mutate } = useSWR<Item[]>("/api/users", { refreshInterval: 30_000 });
  const toast = useToast();
  const ask = useConfirm();
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<LinkShown | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const passwordLogin = me.loginMethods.password;

  async function patch(u: Item, body: Record<string, unknown>, done: string) {
    setBusy(u.id);
    try {
      await send("PATCH", `/api/users/${u.id}`, body);
      toast.push({ tone: "ok", title: done });
      await mutate();
    } catch (e) {
      toast.push({ tone: "error", title: `Couldn't update ${u.email}`, body: (e as Error).message }, 8000);
      await mutate();
    } finally {
      setBusy(null);
    }
  }

  const reset = (u: Item) =>
    ask({
      env: "",
      title: u.hasPassword || u.lastLoginAt ? `Reset ${u.email}'s password?` : `New invite link for ${u.email}?`,
      description: u.hasPassword
        ? "Their current password and every session stop working now. You get a one-time link to send them."
        : "Any earlier link stops working. You get a new one-time link to send them.",
      danger: u.hasPassword,
      expected: "yes",
      confirmLabel: "Create link",
      run: async () => {
        const r = await postJson<{ link: string; purpose: "invite" | "reset" }>(`/api/users/${u.id}/reset`, {});
        setLink({ title: r.purpose === "reset" ? "Password reset link" : "Invite link", email: u.email, url: r.link });
        await mutate();
      },
    });

  const remove = (u: Item) =>
    ask({
      env: "",
      title: `Delete ${u.email}?`,
      description: "They lose access immediately and their sessions end. Audit entries they made are kept.",
      danger: true,
      expected: "yes",
      confirmLabel: "Delete user",
      run: async () => {
        await send("DELETE", `/api/users/${u.id}`);
        toast.push({ tone: "ok", title: `${u.email} deleted` });
        await mutate();
      },
    });

  // Card (narrow): who + status, role picker, sign-in times, then the actions as 40px targets.
  const columns: Column<Item>[] = [
    {
      key: "user",
      header: "User",
      slot: "title",
      cell: (u) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar user={u} size={30} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-medium">
              <span className="truncate">{u.name || u.email.split("@")[0]}</span>
              {u.id === me.user.id && <Chip tone="accent">you</Chip>}
            </div>
            <div className="truncate text-[13px] text-fg-3">{u.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      cell: (u) => (
        <select aria-label={`Role for ${u.email}`} className={selectCls} value={u.role} disabled={busy === u.id} onChange={(e) => patch(u, { role: e.target.value }, `${u.email} is now ${ROLE_INFO[e.target.value as Role].label.toLowerCase()}`)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>{ROLE_INFO[r].label}</option>
          ))}
        </select>
      ),
    },
    {
      key: "status",
      header: "Status",
      slot: "end",
      cell: (u) => (
        <div className="flex flex-wrap justify-end gap-1 @min-2xl:justify-start">
          {u.disabled ? <Chip tone="bad">Disabled</Chip> : u.invitePending ? <Chip tone="accent">Invite pending</Chip> : <Chip tone="ok">Active</Chip>}
          {!u.disabled && !u.hasPassword && !u.invitePending && <Chip tone="muted">{me.loginMethods.sso || me.authMode === "alb" ? "SSO" : "no password"}</Chip>}
        </div>
      ),
    },
    {
      key: "last",
      header: "Last sign-in",
      label: "Last sign-in",
      slot: "meta",
      className: "whitespace-nowrap text-fg-2",
      cell: (u) => <span title={u.lastLoginAt ? stamp(u.lastLoginAt) : undefined}>{u.lastLoginAt ? <TimeAgo at={u.lastLoginAt} /> : <span className="text-fg-3">never</span>}</span>,
    },
    { key: "added", header: "Added", label: "Added", slot: "meta", className: "whitespace-nowrap text-fg-2", cell: (u) => <span title={stamp(u.createdAt)}><TimeAgo at={u.createdAt} /></span> },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      slot: "actions",
      className: "px-3",
      cell: (u) => (
        <div className="flex items-center justify-end gap-0.5">
          {busy === u.id && <Loader2 className="m-2 size-4 animate-spin text-fg-3" />}
          {passwordLogin && (
            <IconButton label={u.hasPassword || u.lastLoginAt ? "Password reset link" : "New invite link"} disabled={u.disabled || busy === u.id} onClick={() => reset(u)}>
              <KeyRound className="size-4" />
            </IconButton>
          )}
          {u.disabled ? (
            <IconButton label="Enable" disabled={busy === u.id} onClick={() => patch(u, { disabled: false }, `${u.email} enabled`)}>
              <CircleCheck className="size-4" />
            </IconButton>
          ) : (
            <IconButton label="Disable (ends their sessions)" disabled={busy === u.id} onClick={() => patch(u, { disabled: true }, `${u.email} disabled`)} className="hover:!text-down">
              <Ban className="size-4" />
            </IconButton>
          )}
          <IconButton label="Delete" disabled={busy === u.id} onClick={() => remove(u)} className="hover:!text-down">
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button variant="primary" onClick={() => setInviting(true)}>
          <UserPlus className="size-4" /> Invite user
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {ROLES.map((r) => (
          <div key={r} className="rounded-xl border border-line bg-panel p-3 shadow-card">
            <RoleChip role={r} />
            <p className="mt-1.5 text-[13px] leading-snug text-fg-3">{ROLE_INFO[r].hint}</p>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
        {isLoading ? (
          <div className="space-y-px p-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : error ? (
          <Empty title="Couldn't load users" hint={(error as Error).message} />
        ) : (
          <DataTable label="Users" rows={data ?? []} rowKey={(u) => u.id} columns={columns} rowClassName={(u) => u.disabled && "opacity-60"} />
        )}
      </div>
      <p className="text-[13px] text-fg-3">The console always keeps at least one active admin: the last one can&apos;t be demoted, disabled or deleted.</p>

      <AnimatePresence>
        {inviting && (
          <InviteDialog
            key="invite"
            me={me}
            onClose={() => setInviting(false)}
            onDone={async (r) => {
              setInviting(false);
              await mutate();
              if (r.link) setLink({ title: "Invite link", email: r.user.email, url: r.link });
              else toast.push({ tone: "ok", title: `${r.user.email} invited`, body: "They can sign in with SSO now." });
            }}
          />
        )}
        {link && <LinkDialog key="link" link={link} onClose={() => setLink(null)} />}
      </AnimatePresence>
    </div>
  );
}

function useEscape(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, enabled]);
}

function InviteDialog({ me, onClose, onDone }: { me: Me; onClose(): void; onDone(r: { user: Item; link: string | null }): void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEscape(onClose, !busy);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      onDone(await postJson<{ user: Item; link: string | null }>("/api/users", { email, name, role }));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    // Centred on wide screens, a bottom sheet on phones. Header and buttons stay put; the fields scroll.
    <Modal onClose={busy ? undefined : onClose} aria-labelledby="invite-title" className="max-w-lg">
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div>
            <h2 id="invite-title" className="font-display text-[26px] leading-tight">Invite a user</h2>
            <p className="mt-1 text-[13.5px] leading-relaxed text-fg-3">
              {me.loginMethods.password ? "No email is sent. You'll get a one-time link to share with them yourself (valid 7 days)." : "They can sign in with SSO as soon as they're added."}
              {me.loginMethods.password && (me.loginMethods.sso || me.authMode === "alb") ? " If they use SSO, adding them is enough — the link is only for password sign-in." : ""}
            </p>
          </div>
          <IconButton type="button" label="Close" onClick={onClose} disabled={busy}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 space-y-3.5 overflow-y-auto px-5 py-4">
          <Field label="Email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
          <fieldset>
            <legend className="mb-1.5 text-[13.5px] font-medium text-fg-2">Role</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {ROLES.map((r) => (
                <label key={r} className={cx("press flex cursor-pointer gap-2.5 rounded-xl border p-2.5 transition-colors [--press-scale:0.985]", role === r ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong hover:bg-panel-2")}>
                  <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="mt-0.5 accent-[var(--accent)]" />
                  <span>
                    <span className="block text-[14px] font-medium">{ROLE_INFO[r].label}</span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{ROLE_INFO[r].hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <FormError error={err} />
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !email}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {me.loginMethods.password ? "Create invite link" : "Add user"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LinkDialog({ link, onClose }: { link: LinkShown; onClose(): void }) {
  const [copied, setCopied] = useState(false);
  useEscape(onClose);
  return (
    <Modal onClose={onClose} aria-labelledby="link-title" className="max-w-lg">
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="link-title" className="font-display text-[26px] leading-tight">{link.title}</h2>
            <p className="mt-1 text-[13.5px] leading-relaxed text-fg-3">
              No email was sent. Send this link to <b className="font-medium text-fg-2">{link.email}</b> yourself — over a private channel. It works once and expires in 7 days. It won&apos;t be shown again.
            </p>
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="mt-4 flex gap-2">
          <input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label="One-time link" className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-3 font-mono text-[13px] text-fg outline-none focus:border-accent" />
          <Button
            variant="primary"
            onClick={async () => {
              await copy(link.url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
