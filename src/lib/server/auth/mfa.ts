// Two-step sign-in with an authenticator app (pure parts in src/lib/totp.ts).
//
// A correct password (login, first-run setup, invite or reset link) no longer creates a session when CONSOLE_MFA is
// required (the default). It sets a short-lived challenge cookie instead — sealed (AES-GCM) with the console's secret
// key, so the browser can neither read nor forge it — and the client finishes with:
//   - verify:  POST /api/auth/mfa/verify   { code }   a 6-digit code or a recovery code → session
//   - enroll:  POST /api/auth/mfa/enroll             → QR code + key, then
//              POST /api/auth/mfa/confirm  { code }   → secret saved, recovery codes shown once, session
// Signed-in users replace their authenticator or get new recovery codes from /api/me/mfa (password required).
// SSO and load-balancer sign-ins don't pass through here: their identity provider owns MFA.
import "server-only";
import { createHash } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import qrcode from "qrcode-generator";
import { checkTotp, hashRecoveryCode, mfaPolicy, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUri, spendRecoveryCode } from "../../totp.ts";
import { getDb, type Db } from "../db.ts";
import { HttpError } from "../errors.ts";
import { json } from "../http.ts";
import { seal, unseal } from "../secrets.ts";
import { audit, auditOrFail } from "./audit.ts";
import { secureRequest } from "./config.ts";
import { limits, retryText } from "./limits.ts";
import { deleteUserSessions, forgetCachedSessions, sessionIdOf } from "./sessions.ts";
import { signIn } from "./signin.ts";
import { userById, type UserRow } from "./users.ts";

export const mfaRequired = () => mfaPolicy(process.env) === "required";

const COOKIE = "console_mfa";
const CHALLENGE_MS = 10 * 60_000;

interface Challenge {
  u: string; // user id
  m: string; // sign-in method for the audit row: password | setup | invite | reset
  p: "verify" | "enroll";
  x: number; // expiry (ms)
  h: string; // fingerprint of the password hash it was issued for: a password reset or change voids it
  s?: string; // enroll: the new secret, chosen with the challenge and kept here until it's confirmed
  keep?: boolean; // enroll from Settings: replace the authenticator, keep the current session
}

const fingerprint = (passwordHash: string | null) => createHash("sha256").update(`mfa:${passwordHash ?? ""}`).digest("base64url").slice(0, 22);

function readChallenge(req: NextRequest, want: Challenge["p"]): Challenge {
  const raw = req.cookies.get(COOKIE)?.value;
  let c: Challenge | null = null;
  try {
    c = raw ? (JSON.parse(unseal(raw)) as Challenge) : null;
  } catch {
    c = null; // tampered, or sealed with a key that has since changed
  }
  if (!c || typeof c.u !== "string" || c.p !== want || !(c.x > Date.now())) throw new HttpError(401, "This sign-in step expired. Sign in again.");
  return c;
}

function setChallenge(res: NextResponse, req: NextRequest, c: Challenge) {
  res.cookies.set({ name: COOKIE, value: seal(JSON.stringify(c)), httpOnly: true, sameSite: "strict", secure: secureRequest(req), path: "/api/", maxAge: Math.max(1, Math.floor((c.x - Date.now()) / 1000)) });
}

const clearChallenge = (res: NextResponse, req: NextRequest) =>
  res.cookies.set({ name: COOKIE, value: "", httpOnly: true, sameSite: "strict", secure: secureRequest(req), path: "/api/", maxAge: 0 });

interface MfaRow {
  totp_secret: string | null;
  totp_enabled_at: number | null;
  totp_last_step: number | null;
  totp_recovery: string | null;
}

async function mfaOf(userId: string, db?: Db): Promise<MfaRow | undefined> {
  return (db ?? (await getDb())).get<MfaRow>("SELECT totp_secret, totp_enabled_at, totp_last_step, totp_recovery FROM users WHERE id = ?", [userId]);
}

const recoveryHashes = (r: MfaRow | undefined): string[] => {
  try {
    const v = JSON.parse(r?.totp_recovery ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

export interface MfaStatus {
  required: boolean;
  enabled: boolean;
  since: number | null;
  recoveryLeft: number;
}

export async function mfaStatus(userId: string): Promise<MfaStatus> {
  const r = await mfaOf(userId);
  return { required: mfaRequired(), enabled: !!r?.totp_secret, since: r?.totp_enabled_at ? Number(r.totp_enabled_at) : null, recoveryLeft: recoveryHashes(r).length };
}

// The user behind a challenge, still allowed to finish it: enabled, and the password it was issued for unchanged.
async function challengeUser(c: Challenge): Promise<UserRow> {
  const row = await userById(c.u);
  if (!row || Number(row.disabled) || fingerprint(row.password_hash) !== c.h) throw new HttpError(401, "This sign-in step expired. Sign in again.");
  return row;
}

// Per account (15 minutes and a day, whatever the address) and per address. With 3 codes valid at any moment, 20 wrong
// guesses a day leave an attacker who already has the password a 1-in-16,000 chance a day — and every miss is audited.
function mfaWait(userId: string, ip: string | undefined): number {
  return Math.max(limits.mfa.retryIn(userId), limits.mfaDay.retryIn(userId), ip ? limits.mfaIp.retryIn(ip) : 0);
}
function mfaFail(userId: string, ip: string | undefined) {
  limits.mfa.fail(userId);
  limits.mfaDay.fail(userId);
  if (ip) limits.mfaIp.fail(ip);
}
function assertNotThrottled(userId: string, ip: string | undefined) {
  const wait = mfaWait(userId, ip);
  if (wait) throw new HttpError(429, retryText(wait), wait);
}

// ---------- step 1: after the password ----------

// The end of every password-based sign-in. Without two-step sign-in this is signIn(); with it, the browser gets a
// challenge for a code (verify) or for setting up an authenticator (enroll), and no session yet.
export async function afterPassword(req: NextRequest, user: { id: string; email: string }, method: string, ip?: string): Promise<NextResponse> {
  if (!mfaRequired()) return signIn(req, json({ ok: true }), user, method, ip);
  const row = await userById(user.id);
  const m = await mfaOf(user.id);
  const p: Challenge["p"] = m?.totp_secret ? "verify" : "enroll";
  const res = json({ ok: true, mfa: p });
  setChallenge(res, req, { u: user.id, m: method, p, x: Date.now() + CHALLENGE_MS, h: fingerprint(row?.password_hash ?? null), ...(p === "enroll" ? { s: newTotpSecret() } : {}) });
  return res;
}

// ---------- enroll ----------

// The challenge's secret as a QR code and key. Read-only: the secret was fixed when the challenge was made, so two
// overlapping calls (a double render, a second tab) can never show one secret while the cookie keeps another.
export async function enrollStart(req: NextRequest): Promise<NextResponse> {
  const c = readChallenge(req, "enroll");
  if (!c.s) throw new HttpError(401, "This sign-in step expired. Sign in again.");
  const row = await challengeUser(c);
  const secret = c.s;
  const uri = otpauthUri(secret, row.email);
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  return json({ secret, uri, qr: qr.createDataURL(5, 4), email: row.email });
}

export async function enrollConfirm(req: NextRequest, code: unknown, ip?: string): Promise<NextResponse> {
  const c = readChallenge(req, "enroll");
  if (!c.s) throw new HttpError(401, "This sign-in step expired. Sign in again.");
  assertNotThrottled(c.u, ip);
  const row = await challengeUser(c);
  const step = checkTotp(c.s, code, Date.now(), null);
  if (step === null) {
    mfaFail(c.u, ip);
    await audit({ action: "auth.mfa_failed", actor: row.email, target: row.email, ip, result: "error", detail: "setup code didn't match" });
    throw new HttpError(400, "That code doesn't match. Check the time on your phone is set automatically, then try the newest code.");
  }
  const codes = newRecoveryCodes();
  const hashes = codes.map((x) => hashRecoveryCode(normalizeRecoveryCode(x)!));
  const db = await getDb();
  await db.tx(async (tx) => {
    // A sign-in setup only fills an empty slot (a second tab can't overwrite the first); Settings replaces it.
    const n = await tx.run(
      `UPDATE users SET totp_secret = ?, totp_enabled_at = ?, totp_last_step = ?, totp_recovery = ? WHERE id = ? AND disabled = 0${c.keep ? "" : " AND totp_secret IS NULL"}`,
      [seal(c.s!), Date.now(), step, JSON.stringify(hashes), c.u],
    );
    if (!n) throw new HttpError(409, "An authenticator is already set up for this account. Sign in again.");
    await auditOrFail({ action: c.keep ? "auth.mfa_replace" : "auth.mfa_enroll", actor: row.email, target: row.email, ip });
    // Replacing the authenticator signs out every other session, as a password change does.
    if (c.keep) await deleteUserSessions(c.u, sessionIdOf(req) ?? undefined, tx);
  });
  limits.mfa.reset(c.u);
  const res = c.keep ? json({ ok: true, recoveryCodes: codes }) : await signIn(req, json({ ok: true, recoveryCodes: codes }), row, c.m, ip, { mfa: "enrolled" });
  clearChallenge(res, req);
  return res;
}

// ---------- verify ----------

export async function verifyCode(req: NextRequest, code: unknown, ip?: string): Promise<NextResponse> {
  const c = readChallenge(req, "verify");
  assertNotThrottled(c.u, ip);
  const row = await challengeUser(c);
  const m = await mfaOf(c.u);
  if (!m?.totp_secret) throw new HttpError(401, "This sign-in step expired. Sign in again.");
  const db = await getDb();
  let used: "totp" | "recovery" | null = null;
  let recoveryLeft = recoveryHashes(m).length;

  if (normalizeRecoveryCode(code)) {
    const rest = spendRecoveryCode(recoveryHashes(m), code);
    // Compare-and-set on the stored list: two requests can't spend the same code.
    if (rest && (await db.run("UPDATE users SET totp_recovery = ? WHERE id = ? AND totp_recovery = ?", [JSON.stringify(rest), c.u, m.totp_recovery]))) {
      used = "recovery";
      recoveryLeft = rest.length;
    }
  } else {
    const last = m.totp_last_step === null ? null : Number(m.totp_last_step);
    const step = checkTotp(unseal(m.totp_secret), code, Date.now(), last);
    // Moves the last-used step forward only: the same code can't be used twice, even by two requests at once.
    if (step !== null && (await db.run("UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)", [step, c.u, step]))) used = "totp";
  }

  if (!used) {
    mfaFail(c.u, ip);
    await audit({ action: "auth.mfa_failed", actor: row.email, target: row.email, ip, result: "error", detail: normalizeRecoveryCode(code) ? "recovery code not valid" : "wrong or reused code" });
    throw new HttpError(400, "That code isn't right. Use the newest code from your authenticator app, or a recovery code.");
  }
  limits.mfa.reset(c.u);
  const res = await signIn(req, json({ ok: true, recoveryLeft, usedRecovery: used === "recovery" }), row, c.m, ip, { mfa: used, ...(used === "recovery" ? { recoveryLeft } : {}) });
  clearChallenge(res, req);
  return res;
}

// ---------- Settings: a signed-in user, re-authenticated with their password ----------

export async function startReplace(req: NextRequest, row: UserRow): Promise<NextResponse> {
  const res = json({ ok: true });
  setChallenge(res, req, { u: row.id, m: "settings", p: "enroll", x: Date.now() + CHALLENGE_MS, h: fingerprint(row.password_hash), keep: true, s: newTotpSecret() });
  return res;
}

export async function newCodes(row: UserRow, ip?: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  const hashes = codes.map((x) => hashRecoveryCode(normalizeRecoveryCode(x)!));
  const db = await getDb();
  await db.tx(async (tx) => {
    const n = await tx.run("UPDATE users SET totp_recovery = ? WHERE id = ? AND totp_secret IS NOT NULL", [JSON.stringify(hashes), row.id]);
    if (!n) throw new HttpError(409, "Set up an authenticator first.");
    await auditOrFail({ action: "auth.mfa_recovery_codes", actor: row.email, target: row.email, ip });
  });
  return codes;
}

// Admin reset (with the password reset link): the next sign-in sets up a new authenticator.
export async function clearMfa(userId: string, db: Db) {
  await db.run("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery = NULL WHERE id = ?", [userId]);
  forgetCachedSessions();
}
