"use client";
import { ArrowRight, KeyRound, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui";
import { postJson } from "@/lib/client/api";
import { TAP } from "../_components/page-frame";
import { AuthCard, Field, FormError } from "./auth-card";

// Stable codes from the SSO callback → words. Unknown codes get the generic line (never echo the raw value).
const SSO_ERRORS: Record<string, string> = {
  sso_off: "SSO sign-in isn't configured on this console.",
  sso_unavailable: "The SSO provider couldn't be reached. Try again in a moment.",
  sso_denied: "Sign-in was cancelled at the provider.",
  sso_state: "That sign-in attempt expired or was already used. Start again.",
  sso_not_invited: "Your account hasn't been invited to this console. Ask an admin to invite you.",
  sso_disabled: "Your account is disabled. Ask an admin to re-enable it.",
  sso_unverified: "Your identity provider hasn't verified your email address.",
  sso_no_email: "The identity provider didn't share your email address (the email scope is required).",
  sso_mismatch: "This sign-in doesn't match the SSO identity your console account is linked to. Ask an admin.",
  sso_failed: "SSO sign-in failed. The server log has the details.",
};

interface Props {
  methods: { password: boolean; sso: { label: string } | null };
  next: string;
  error: string | null;
  mode: "session" | "alb" | "dev" | null;
}

export function LoginForm({ methods, next, error, mode }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(error ? (Object.hasOwn(SSO_ERRORS, error) ? SSO_ERRORS[error] : "Sign-in failed. Try again.") : null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await postJson("/api/auth/login", { email, password });
      window.location.replace(next); // full load: every cache starts fresh for this user
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  if (mode === "alb")
    return (
      <AuthCard title="Signed in by your load balancer" subtitle="This console uses the sign-in in front of it (AWS ALB with your identity provider). There's nothing to enter here.">
        <a href={next} className="press inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-[14px] font-medium text-primary-fg hover:bg-primary-hover pointer-coarse:h-11">
          Continue <ArrowRight className="size-4" />
        </a>
      </AuthCard>
    );

  const none = !methods.password && !methods.sso;
  return (
    <AuthCard
      title="Sign in"
      subtitle="Use your console account to continue."
      footer={
        <>
          {methods.password && <div>Forgot your password? Ask an admin for a reset link.</div>}
          {mode === "dev" && (
            <div className="mt-2">
              Local dev mode: without signing in you use the dev user.{" "}
              <a href={next} className={`text-accent hover:underline ${TAP}`}>Continue as dev user</a>
            </div>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <FormError error={err} />
        {none && <p className="text-[14px] leading-relaxed text-fg-2">No sign-in method is enabled. Set <code className="font-mono text-xs">OIDC_ISSUER</code> for SSO, or remove <code className="font-mono text-xs">AUTH_PASSWORD_LOGIN=false</code>.</p>}
        {methods.sso && (
          <a
            href={`/api/auth/oidc/start?next=${encodeURIComponent(next)}`}
            className="press flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-line bg-panel text-[14px] font-medium text-fg transition-colors hover:border-line-strong hover:bg-panel-2 pointer-coarse:h-11"
          >
            <KeyRound className="size-4 text-fg-2" /> {methods.sso.label}
          </a>
        )}
        {methods.sso && methods.password && (
          <div className="eyebrow flex items-center gap-3">
            <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
          </div>
        )}
        {methods.password && (
          <form onSubmit={submit} className="space-y-3.5">
            <Field label="Email" type="email" name="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            <Field label="Password" type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button type="submit" variant="primary" className="!h-10 w-full pointer-coarse:!h-11" disabled={busy || !email || !password}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        )}
      </div>
    </AuthCard>
  );
}
