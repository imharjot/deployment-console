// First run. With zero users: CONSOLE_ADMIN_EMAIL (+ CONSOLE_ADMIN_PASSWORD) creates the first admin; otherwise a
// one-time setup token is printed to the server log and /setup asks for it. Once any user exists, /setup is closed.
import "server-only";
import { normalizeEmail } from "../../authn.ts";
import { hashPassword, passwordProblem } from "../../password.ts";
import { audit } from "./audit.ts";
import { authConfig, authMode } from "./config.ts";
import { liveSetupToken, newSetupToken } from "./tokens.ts";
import { countUsers, createUser } from "./users.ts";

// globalThis: the proxy, routes and instrumentation are separate bundles; the "has users" answer only ever flips to
// true (the last admin can't be deleted), so it's cached for good once seen.
const g = globalThis as typeof globalThis & { __consoleAuthBoot?: Promise<void>; __consoleHasUsers?: boolean; __consoleSetupPrint?: Promise<void> };

export async function hasUsers(): Promise<boolean> {
  if (g.__consoleHasUsers) return true;
  const yes = (await countUsers()) > 0;
  if (yes) g.__consoleHasUsers = true;
  return yes;
}

export const markHasUsers = () => void (g.__consoleHasUsers = true);

async function envAdmin(): Promise<boolean> {
  const email = normalizeEmail(process.env.CONSOLE_ADMIN_EMAIL);
  if (!email) return false;
  const pw = process.env.CONSOLE_ADMIN_PASSWORD;
  // An email alone is enough for SSO/ALB sign-in; a password must meet the policy or we refuse loudly.
  if (pw && passwordProblem(pw)) {
    console.error(`[deployment-console] CONSOLE_ADMIN_PASSWORD rejected (${passwordProblem(pw)}) — first admin not created`);
    return false;
  }
  // An admin nobody can sign in as would close /setup for good.
  const m = authMode();
  if (!pw && !(m.ok && m.mode === "alb") && !authConfig().oidc) {
    console.error("[deployment-console] CONSOLE_ADMIN_EMAIL is set without CONSOLE_ADMIN_PASSWORD, and neither OIDC nor AUTH_MODE=alb is configured — nobody could sign in as that admin, so it was not created. Set a password, configure SSO, or use the setup token below.");
    return false;
  }
  await createUser({ email, role: "admin", passwordHash: pw ? await hashPassword(pw) : null });
  await audit({ action: "user.bootstrap", actor: "system", target: email, params: { source: "CONSOLE_ADMIN_EMAIL", password: !!pw } });
  console.log(`[deployment-console] first admin created from CONSOLE_ADMIN_EMAIL: ${email}`);
  markHasUsers();
  return true;
}

// Prints a setup token. At boot always (earlier tokens were printed to logs you may no longer have — any unexpired
// one still works); when /setup is shown, only if none is live, so an expired token renews without spamming the log.
export function ensureSetupToken(atBoot = false): Promise<void> {
  g.__consoleSetupPrint ??= (async () => {
    if ((await hasUsers()) || (!atBoot && (await liveSetupToken()))) return;
    const token = await newSetupToken();
    console.log(`[deployment-console] first-run setup token: ${token}  → open /setup (valid 24 h; one admin can be created with it)`);
  })().finally(() => (g.__consoleSetupPrint = undefined));
  return g.__consoleSetupPrint;
}

// Once per process; safe to call on every request.
export function ensureBootstrap(): Promise<void> {
  g.__consoleAuthBoot ??= (async () => {
    if (await hasUsers()) return;
    if (await envAdmin()) return;
    const m = authMode();
    if (m.ok && m.mode !== "dev") await ensureSetupToken(true); // dev signs in as DEV_USER_EMAIL instead
  })().catch((e) => {
    g.__consoleAuthBoot = undefined; // DB not reachable yet: retry on the next request
    throw e;
  });
  return g.__consoleAuthBoot;
}
