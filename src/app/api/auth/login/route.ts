// Email + password sign-in. One generic error for every failure (no user enumeration), a dummy hash for unknown
// emails (same timing), and in-memory throttling per email+IP, per IP and per email.
import { normalizeEmail } from "@/lib/authn";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/password";
import { audit } from "@/lib/server/auth/audit";
import { loginMethods } from "@/lib/server/auth/config";
import { ipFail, ipWait, limits, retryText } from "@/lib/server/auth/limits";
import { signIn } from "@/lib/server/auth/signin";
import { userByEmail } from "@/lib/server/auth/users";
import { getDb } from "@/lib/server/db";
import { HttpError } from "@/lib/server/errors";
import { handle, ipOf, json, readJson } from "@/lib/server/http";

let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword(crypto.randomUUID()));

export const POST = handle(async (req) => {
  if (!loginMethods().password) throw new HttpError(404, "Password sign-in is disabled on this console.");
  const b = await readJson(req);
  const email = normalizeEmail(b.email);
  const tried = email ?? String(b.email ?? "").trim().toLowerCase().slice(0, 254);
  const password = typeof b.password === "string" ? b.password : "";
  const addr = ipOf(req);
  const ip = addr ?? "unknown";
  const key = `${tried}|${ip}`;

  // The email+address bucket needs a known address too: with none, every client would share it (see ipWait).
  const wait = Math.max(addr ? limits.login.retryIn(key) : 0, ipWait(limits.loginIp, addr), limits.loginEmail.retryIn(tried));
  if (wait) {
    await audit({ action: "auth.login_failed", actor: tried || "(blank)", target: tried, ip, result: "error", detail: "rate limited" });
    const res = json({ error: retryText(wait) }, 429);
    res.headers.set("Retry-After", String(Math.ceil(wait / 1000)));
    return res;
  }

  const row = email ? await userByEmail(email) : undefined;
  const match = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));
  const why = !row ? "unknown email" : !row.password_hash ? "no password set" : !match ? "wrong password" : Number(row.disabled) ? "disabled" : null;
  if (why || !row) {
    if (addr) limits.login.fail(key);
    ipFail(limits.loginIp, addr);
    limits.loginEmail.fail(tried);
    await audit({ action: "auth.login_failed", actor: tried || "(blank)", target: row?.email ?? tried, ip, result: "error", detail: why ?? undefined });
    return json({ error: "Invalid email or password." }, 401);
  }

  limits.login.reset(key);
  if (needsRehash(row.password_hash!)) await (await getDb()).run("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(password), row.id]);
  return signIn(req, json({ ok: true }), row, "password", ip);
});
