"use client";
import { Loader2, Terminal } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui";
import { postJson } from "@/lib/client/api";
import { AuthCard, Field, FormError, passwordHint } from "../login/auth-card";

export function SetupForm({ alb, verifiedEmail }: { alb: boolean; verifiedEmail: string | null }) {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState(verifiedEmail ?? "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hint = alb ? null : passwordHint(password, confirm);
  const ready = token.trim() && email && (alb || (password && password === confirm && !hint));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await postJson("/api/auth/setup", { token: token.trim(), email, name, password: alb ? undefined : password });
      window.location.replace("/"); // full load: signed in now
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Create the first admin"
      subtitle="This console has no users yet. The admin you create here can invite everyone else."
      footer="Setup closes as soon as the first admin exists."
    >
      <form onSubmit={submit} className="space-y-3.5">
        <div className="flex gap-2.5 rounded-lg border border-line bg-panel-2 p-3 text-[13px] leading-relaxed text-fg-2">
          <Terminal className="mt-0.5 size-4 flex-none text-fg-3" />
          <span>
            The one-time setup token is in the server log, on the line starting <code className="font-mono text-[12px] text-fg">first-run setup token</code>.
          </span>
        </div>
        <Field label="Setup token" name="token" autoComplete="off" spellCheck={false} required autoFocus value={token} onChange={(e) => setToken(e.target.value)} className="block [&_input]:font-mono [&_input]:text-[13.5px]" />
        <Field
          label="Email"
          type="email"
          autoComplete="username"
          required
          value={email}
          readOnly={alb && !!verifiedEmail}
          onChange={(e) => setEmail(e.target.value)}
          hint={alb ? "Behind the load balancer, the first admin is the account you're signed in with." : undefined}
        />
        <Field label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
        {!alb && (
          <>
            <Field label="Password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 10 characters." />
            <Field label="Confirm password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </>
        )}
        <FormError error={err ?? (confirm || password.length >= 10 ? hint : null)} />
        <Button type="submit" variant="primary" className="!h-10 w-full pointer-coarse:!h-11" disabled={!ready || busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? "Creating…" : "Create admin and sign in"}
        </Button>
      </form>
    </AuthCard>
  );
}
