"use client";
import { KeyRound, Loader2 } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui";
import { ROLE_INFO, RoleChip } from "@/components/user-menu";
import { postJson } from "@/lib/client/api";
import type { Role } from "@/lib/rbac";
import { TAP } from "../../_components/page-frame";
import { AuthCard, Field, FormError, passwordHint } from "../../login/auth-card";

interface Props {
  token: string;
  info: { purpose: "invite" | "reset"; email: string; name: string | null; role: Role } | null;
  methods: { password: boolean; sso: { label: string } | null };
}

export function InviteForm({ token, info, methods }: Props) {
  const [name, setName] = useState(info?.name ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hint = passwordHint(password, confirm);

  if (!info)
    return (
      <AuthCard title="This link doesn't work" subtitle="It's invalid, expired, or has already been used. Invite and reset links work once and expire after 7 days.">
        <div className="space-y-3 text-[14px] text-fg-2">
          <p>Ask an admin to send you a new link.</p>
          <Link href="/login" className={`text-accent hover:underline ${TAP}`}>Go to sign in</Link>
        </div>
      </AuthCard>
    );

  const invite = info.purpose === "invite";
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || hint || !password || password !== confirm) return;
    setBusy(true);
    setErr(null);
    try {
      await postJson(`/api/auth/invite/${encodeURIComponent(token)}`, { name: invite ? name : undefined, password });
      window.location.replace("/"); // full load for the new identity; drops the token URL from history
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title={invite ? "Join Deployment Console" : "Choose a new password"}
      subtitle={
        invite ? (
          <>
            You&apos;ve been invited as <b className="font-medium text-fg-2">{info.email}</b>.
          </>
        ) : (
          <>
            For <b className="font-medium text-fg-2">{info.email}</b>. Your previous password no longer works.
          </>
        )
      }
      footer="This link works once. Setting a password signs you in and ends any other sessions."
    >
      {invite && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-line bg-panel-2 p-3 text-[13px] leading-snug text-fg-3">
          <RoleChip role={info.role} className="mt-px flex-none" />
          <span>{ROLE_INFO[info.role].hint}</span>
        </div>
      )}
      {methods.sso && (
        <div className="mb-4 space-y-3">
          {/* A full navigation to the SSO route handler (it redirects to the identity provider), not a client route. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/api/auth/oidc/start" className="press flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-line bg-panel text-[14px] font-medium text-fg hover:border-line-strong hover:bg-panel-2 pointer-coarse:h-11">
            <KeyRound className="size-4 text-fg-2" /> {methods.sso.label}
          </a>
          {methods.password && <div className="text-center text-[12.5px] text-fg-3">…or set a password instead</div>}
        </div>
      )}
      {methods.password ? (
        <form onSubmit={submit} className="space-y-3.5">
          {invite && <Field label="Your name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />}
          <Field label="Password" type="password" autoComplete="new-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 10 characters." />
          <Field label="Confirm password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <input type="email" autoComplete="username" value={info.email} readOnly hidden />
          <FormError error={err ?? (confirm || password.length >= 10 ? hint : null)} />
          <Button type="submit" variant="primary" className="!h-10 w-full pointer-coarse:!h-11" disabled={busy || !!hint || !password || password !== confirm}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? "Saving…" : invite ? "Set password and sign in" : "Save password and sign in"}
          </Button>
        </form>
      ) : (
        !methods.sso && <p className="text-[14px] text-fg-2">No sign-in method is enabled on this console.</p>
      )}
    </AuthCard>
  );
}
