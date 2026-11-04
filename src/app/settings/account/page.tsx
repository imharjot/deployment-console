"use client";
import { KeyRound, Laptop, Loader2, LogOut, ShieldCheck, Smartphone } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import useSWR from "swr";
import { Avatar, ROLE_INFO, RoleChip, displayName, signOut, useMe } from "@/components/user-menu";
import { useToast } from "@/components/toast";
import { Button, Chip, Empty, Skeleton, TimeAgo } from "@/components/ui";
import { postJson } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { Field, FormError, passwordHint } from "../../login/auth-card";
import { MfaEnroll, RecoveryCodes } from "../../login/mfa-step";

interface SessionRow {
  id: string;
  createdAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

const VIA: Record<string, string> = {
  session: "Signed in with a console session",
  alb: "Signed in through the load balancer (SSO in front of the console)",
  dev: "Local dev mode: you are the dev user (no sign-in)",
};

function device(ua: string | null) {
  if (!ua) return "Unknown device";
  if (!/Mozilla\//.test(ua)) return ua.split(/[\s/]/)[0] || "Unknown client";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function Card({ title, hint, children, action }: { title: string; hint?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-panel shadow-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
        <div>
          <h2 className="text-[16px] font-semibold">{title}</h2>
          {hint && <p className="mt-0.5 text-[13.5px] text-fg-3">{hint}</p>}
        </div>
        {action}
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

// `first`: the local dev user (AUTH_MODE=dev) has no password yet and sets one without a current password.
function PasswordForm({ first = false }: { first?: boolean }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hint = passwordHint(next, confirm);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || hint || (!first && !current) || next !== confirm) return;
    setBusy(true);
    setErr(null);
    try {
      await postJson("/api/me/password", first ? { next } : { current, next });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.push(first ? { tone: "ok", title: "Password set", body: "You can sign in with it after switching to AUTH_MODE=session." } : { tone: "ok", title: "Password changed", body: "Your other sessions were signed out." });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid max-w-md gap-3.5">
      <input type="text" autoComplete="username" hidden readOnly />
      {!first && <Field label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />}
      <Field label="New password" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} hint="At least 10 characters. Your other sessions will be signed out." />
      <Field label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <FormError error={err ?? (confirm || next.length >= 10 ? hint : null)} />
      <div>
        <Button type="submit" variant="primary" disabled={busy || !!hint || (!first && !current) || !next || next !== confirm}>
          {busy && <Loader2 className="size-4 animate-spin" />} {first ? "Set password" : "Change password"}
        </Button>
      </div>
    </form>
  );
}

function Sessions() {
  const toast = useToast();
  const { data, error, isLoading, mutate } = useSWR<{ current: string | null; sessions: SessionRow[] }>("/api/me/sessions", { refreshInterval: 60_000 });
  const [busy, setBusy] = useState<string | null>(null);

  async function revoke(id: string) {
    setBusy(id);
    try {
      await postJson("/api/me/sessions", { revoke: id });
      toast.push({ tone: "ok", title: id === "others" ? "Other sessions signed out" : "Session revoked" });
      await mutate();
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't revoke", body: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (isLoading) return <div className="space-y-2">{Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>;
  if (error) return <Empty title="Couldn't load sessions" hint={(error as Error).message} />;
  const rows = data?.sessions ?? [];
  if (!rows.length) return <Empty icon={<Laptop className="size-6" />} title="No console sessions" hint="You're not using a console session right now (dev mode or load-balancer sign-in)." />;
  const others = rows.filter((s) => s.id !== data?.current).length;
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {rows.map((s) => {
          const mine = s.id === data?.current;
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <Laptop className="size-4 flex-none text-fg-3" />
              <div className="min-w-0 flex-1 basis-48">
                <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
                  {device(s.userAgent)} {mine && <Chip tone="accent">this device</Chip>}
                </div>
                <div className="mt-0.5 text-[12.5px] leading-relaxed text-fg-3">
                  {s.ip ?? "unknown IP"} · signed in <TimeAgo at={s.createdAt} /> · expires <span className="whitespace-nowrap" title={stamp(s.expiresAt)}>{stamp(s.expiresAt)}</span>
                </div>
              </div>
              {mine ? (
                <Button size="sm" variant="ghost" onClick={signOut}>
                  <LogOut className="size-3.5" /> Sign out
                </Button>
              ) : (
                <Button size="sm" disabled={busy === s.id} onClick={() => revoke(s.id)}>
                  Revoke
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {others > 0 && (
        <Button size="sm" variant="secondary" className="hover:!border-down/50 hover:!text-down" disabled={busy === "others"} onClick={() => revoke("others")}>
          Sign out {others} other session{others === 1 ? "" : "s"}
        </Button>
      )}
    </div>
  );
}

type MfaInfo = { required: boolean; enabled: boolean; since: number | null; recoveryLeft: number };

// New recovery codes or a new authenticator. Both start with the current password (re-authentication).
function TwoStep({ mfa, email }: { mfa: MfaInfo; email: string }) {
  const toast = useToast();
  const { mutate } = useMe();
  const [action, setAction] = useState<"recovery-codes" | "replace" | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  const reset = () => {
    setAction(null);
    setPassword("");
    setErr(null);
    setCodes(null);
    setEnrolling(false);
  };
  const finish = (title: string) => {
    reset();
    void mutate();
    toast.push({ tone: "ok", title });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!action || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await postJson<{ recoveryCodes?: string[] }>("/api/me/mfa", { action, password });
      setPassword("");
      if (action === "recovery-codes") setCodes(r.recoveryCodes ?? []);
      else setEnrolling(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (codes) return <RecoveryCodes codes={codes} email={email} doneLabel="Done" onDone={() => finish("New recovery codes saved")} />;
  if (enrolling) return <MfaEnroll next="/settings/account" onRestart={reset} onDone={() => finish("New authenticator set up")} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[14px] text-fg-2">
        <Chip tone={mfa.enabled ? "ok" : "warn"}>{mfa.enabled ? "On" : "Not set up"}</Chip>
        {mfa.since && (
          <span>
            Authenticator added <TimeAgo at={mfa.since} />
          </span>
        )}
        {mfa.enabled && (
          <span className={mfa.recoveryLeft <= 2 ? "text-warn" : undefined}>
            · {mfa.recoveryLeft} recovery code{mfa.recoveryLeft === 1 ? "" : "s"} left
          </span>
        )}
      </div>
      {action ? (
        <form onSubmit={submit} className="max-w-sm space-y-3.5">
          <p className="text-[13.5px] leading-relaxed text-fg-3">
            {action === "replace"
              ? "Your current authenticator stops working once the new one is confirmed, and your other sessions are signed out."
              : "Your old recovery codes stop working as soon as the new ones are made."}
          </p>
          <Field label="Current password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          <FormError error={err} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy || !password}>
              {busy && <Loader2 className="size-4 animate-spin" />} Continue
            </Button>
            <Button type="button" variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        mfa.enabled && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setAction("replace")}>
              <Smartphone className="size-4" /> Set up a new authenticator
            </Button>
            <Button onClick={() => setAction("recovery-codes")}>
              <KeyRound className="size-4" /> New recovery codes
            </Button>
          </div>
        )
      )}
    </div>
  );
}

// Settings → Your account (the header comes from the settings layout).
export default function AccountPage() {
  const { data: me, error } = useMe();
  return (
    <div className="max-w-3xl space-y-6">
      {error ? (
        <Empty title="Couldn't load your account" hint={(error as Error).message} />
      ) : !me ? (
        <Skeleton className="h-32" />
      ) : (
        <>
          <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-panel p-4 shadow-card sm:p-5">
            <Avatar user={me.user} size={52} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-display text-[26px] leading-tight">{displayName(me.user)}</span>
                <RoleChip role={me.user.role} />
              </div>
              <div className="text-[14px] text-fg-2 [overflow-wrap:anywhere]">{me.user.email}</div>
              <div className="mt-1.5 flex items-center gap-1.5 text-[13px] text-fg-3">
                <ShieldCheck className="size-3.5" /> {VIA[me.via ?? ""] ?? "Signed in"}
              </div>
            </div>
            <div className="w-full rounded-xl bg-panel-2 px-3.5 py-2.5 text-[13px] leading-snug text-fg-3 sm:w-auto sm:max-w-xs">
              <div className="mb-0.5 font-medium text-fg-2">What {ROLE_INFO[me.user.role].label.toLowerCase()}s can do</div>
              {ROLE_INFO[me.user.role].hint}
            </div>
          </section>

          <Card title="Password" hint={me.hasPassword ? "Needs your current password." : me.via === "dev" ? "Set one before switching this data directory to AUTH_MODE=session." : undefined}>
            {me.hasPassword ? (
              <PasswordForm />
            ) : me.via === "dev" ? (
              <PasswordForm first />
            ) : (
              <div className="flex items-start gap-2.5 text-[14px] text-fg-2">
                <KeyRound className="mt-0.5 size-4 flex-none text-fg-3" />
                {me.via === "alb" || me.loginMethods.sso
                  ? "You sign in with single sign-on, so there's no console password to change."
                  : "Your account has no password yet. Ask an admin for a password link."}
              </div>
            )}
          </Card>

          {me.mfa?.required && me.hasPassword && (
            <Card title="Two-step sign-in" hint="Every password sign-in also asks for a code from your authenticator app.">
              <TwoStep mfa={me.mfa} email={me.user.email} />
            </Card>
          )}

          <Card title="Sessions" hint="Browsers and devices signed in to your account.">
            <Sessions />
          </Card>
        </>
      )}
    </div>
  );
}
