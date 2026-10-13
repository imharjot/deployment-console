// Secrets at rest (integration tokens, webhook URLs) are sealed with AES-256-GCM.
// Key: CONSOLE_SECRET_KEY (any long random string). Without it, a key file is generated next to the SQLite DB —
// fine for one box, but Postgres deployments must set the variable (the DB outlives any container's disk).
import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./db.ts";

const usesPostgres = () => /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? ""); // same test as db.ts

// Checked on every request by the proxy (cheap), so a misconfigured deployment refuses to serve instead of breaking
// later at the first integration save or agent approval.
export function secretKeyProblem(): string | undefined {
  const env = process.env.CONSOLE_SECRET_KEY;
  if (env && env.length < 32) return "CONSOLE_SECRET_KEY must be at least 32 characters";
  if (!env && usesPostgres()) return "CONSOLE_SECRET_KEY is required when DATABASE_URL (Postgres) is set — generate one with: openssl rand -base64 48";
  return undefined;
}

let key: Buffer | undefined;
function secretKey(): Buffer {
  if (key) return key;
  const problem = secretKeyProblem();
  if (problem) throw new Error(problem);
  const env = process.env.CONSOLE_SECRET_KEY;
  if (env) return (key = createHash("sha256").update(env).digest());
  const file = path.join(/*turbopackIgnore: true*/ dataDir(), "secret.key");
  mkdirSync(dataDir(), { recursive: true }); // CONSOLE_SQLITE_PATH may point elsewhere (or be :memory:)
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
  return (key = createHash("sha256").update(readFileSync(file, "utf8").trim()).digest());
}

// A key for one purpose ("var-fingerprint"), derived from the console's secret key so it never doubles as the sealing
// key. Same misconfiguration checks as sealing; creates the key file on first use.
export function derivedKey(label: string): Buffer {
  return createHmac("sha256", secretKey()).update(label).digest();
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")}`;
}

export function unseal(sealed: string): string {
  if (!sealed.startsWith("v1:")) throw new Error("unknown secret format");
  const raw = Buffer.from(sealed.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", secretKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
