"use client";
// Two-step sign-in screens, shared by /login, /setup, /invite and Settings → Your account.
// The server keeps the pending state in a sealed cookie (src/lib/server/auth/mfa.ts); these only post codes.
import { Check, Copy, Download, KeyRound, Loader2, Smartphone } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui";
import { postJson } from "@/lib/client/api";
import { TAP } from "../_components/page-frame";
import { Field, FormError } from "./auth-card";

export type MfaKind = "verify" | "enroll";

const go = (next: string) => window.location.replace(next); // full load: every cache starts fresh for this user

// A code from the authenticator app, or (behind a link) one of the recovery codes.
export function MfaVerify({ next, onRestart }: { next: string; onRestart: () => void }) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState<number | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await postJson<{ usedRecovery?: boolean; recoveryLeft?: number }>("/api/auth/mfa/verify", { code });
      if (r.usedRecovery) {
        setLeft(r.recoveryLeft ?? 0); // say how many are left before moving on
        setBusy(false);
      } else go(next);
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      setBusy(false);
      setCode("");
      if (/expired/i.test(msg)) setTimeout(onRestart, 1500);
    }
  }

  if (left !== null)
    return (
      <div className="space-y-4">
        <p className="text-[14px] leading-relaxed text-fg-2">
          You signed in with a recovery code. It can&apos;t be used again.{" "}
          <b className="font-medium text-fg">{left === 0 ? "You have no recovery codes left." : `${left} recovery code${left === 1 ? "" : "s"} left.`}</b>
        </p>
        <p className="text-[13.5px] leading-relaxed text-fg-3">If you lost your phone, set up a new authenticator in Settings → Your account → Two-step sign-in, and get new recovery codes there.</p>
        <Button variant="primary" className="!h-10 w-full pointer-coarse:!h-11" onClick={() => go(left === 0 ? "/settings/account" : next)}>
          Continue
        </Button>
      </div>
    );

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <FormError error={err} />
      {recovery ? (
        <Field label="Recovery code" name="code" autoComplete="off" spellCheck={false} autoFocus required value={code} onChange={(e) => setCode(e.target.value)} placeholder="xxxxx-xxxxx" className="block [&_input]:font-mono" />
      ) : (
        <Field
          label="6-digit code from your authenticator app"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={7}
          autoFocus
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
          className="block [&_input]:font-mono [&_input]:tracking-[0.3em]"
        />
      )}
      <Button type="submit" variant="primary" className="!h-10 w-full pointer-coarse:!h-11" disabled={busy || !code.trim()}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {busy ? "Checking…" : "Verify"}
      </Button>
      <div className="flex justify-between text-[13px]">
        <button
          type="button"
          className={`text-accent hover:underline ${TAP}`}
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
            setErr(null);
          }}
        >
          {recovery ? "Use the authenticator app" : "Use a recovery code"}
        </button>
        <button type="button" className={`text-fg-3 hover:text-fg-2 ${TAP}`} onClick={onRestart}>
          Start over
        </button>
      </div>
    </form>
  );
}

interface Pending {
  secret: string;
  qr: string;
  email: string;
}

// Scan the QR code (or type the key), prove it with one code, then keep the recovery codes.
// `onDone` replaces the final navigation (Settings stays on its page).
export function MfaEnroll({ next, onDone, onRestart }: { next: string; onDone?: () => void; onRestart: () => void }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  useEffect(() => {
    let live = true;
    postJson<Pending>("/api/auth/mfa/enroll", {})
      .then((p) => live && setPending(p))
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await postJson<{ recoveryCodes: string[] }>("/api/auth/mfa/confirm", { code });
      setCodes(r.recoveryCodes);
    } catch (e) {
      setErr((e as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  if (codes) return <RecoveryCodes codes={codes} email={pending?.email ?? ""} onDone={onDone ?? (() => go(next))} />;

  if (!pending)
    return err ? (
      <div className="space-y-3">
        <FormError error={err} />
        <Button className="w-full" onClick={onRestart}>
          Start over
        </Button>
      </div>
    ) : (
      <div className="grid h-40 place-items-center text-fg-3">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );

  return (
    <form onSubmit={submit} className="space-y-4">
      <ol className="space-y-1.5 text-[13.5px] leading-snug text-fg-2">
        <li className="flex gap-2">
          <Smartphone className="mt-0.5 size-4 flex-none text-fg-3" />
          <span>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) and scan this code.</span>
        </li>
      </ol>
      <div className="flex justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL made on the server, nothing to optimise */}
        <img src={pending.qr} alt="QR code to add this account to an authenticator app" width={200} height={200} className="rounded-lg bg-white p-1 [image-rendering:pixelated]" />
      </div>
      <details className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] text-fg-3">
        <summary className={`cursor-pointer select-none text-fg-2 ${TAP}`}>Can&apos;t scan it? Enter the key instead</summary>
        <div className="mt-2 break-all font-mono text-[13.5px] tracking-wider text-fg select-all">{pending.secret.match(/.{1,4}/g)?.join(" ")}</div>
        <div className="mt-1">Time-based, 6 digits, every 30 seconds.</div>
      </details>
      <FormError error={err} />
      <Field
        label="Enter the 6-digit code it shows"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        required
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
        className="block [&_input]:font-mono [&_input]:tracking-[0.3em]"
      />
      <Button type="submit" variant="primary" className="!h-10 w-full pointer-coarse:!h-11" disabled={busy || !code.trim()}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {busy ? "Checking…" : "Turn on two-step sign-in"}
      </Button>
    </form>
  );
}

// Shown once. Copy or download, then confirm they're kept somewhere safe.
export function RecoveryCodes({ codes, email, onDone, doneLabel = "Continue" }: { codes: string[]; email: string; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `Deployment Console recovery codes${email ? ` for ${email}` : ""}\nEach code works once, in place of an authenticator code.\n\n${codes.join("\n")}\n`;

  function download() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = "deployment-console-recovery-codes.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setSaved(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 text-[13.5px] leading-relaxed text-fg-2">
        <KeyRound className="mt-0.5 size-4 flex-none text-fg-3" />
        <span>
          Save these recovery codes somewhere safe, like your password manager. Each one signs you in once if you lose your phone. <b className="font-medium text-fg">They won&apos;t be shown again.</b>
        </span>
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-line bg-panel-2 px-4 py-3 font-mono text-[14px] text-fg select-all">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          className="flex-1"
          onClick={() =>
            navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setSaved(true);
            })
          }
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? "Copied" : "Copy"}
        </Button>
        <Button className="flex-1" onClick={download}>
          <Download className="size-4" /> Download
        </Button>
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-[13.5px] text-fg-2">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I&apos;ve saved my recovery codes
      </label>
      <Button variant="primary" className="!h-10 w-full pointer-coarse:!h-11" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}

// Titles for the AuthCard around each step.
export const MFA_TITLES: Record<MfaKind, { title: string; subtitle: string }> = {
  verify: { title: "Two-step sign-in", subtitle: "Enter the code from your authenticator app." },
  enroll: { title: "Set up two-step sign-in", subtitle: "This console asks for a code from your phone at every sign-in. It takes a minute to set up." },
};
