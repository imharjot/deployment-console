import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { can, isRole, roleFor, type Perm, type User } from "../rbac.ts";
import type { EnvName } from "../types.ts";
import { HttpError, errText, errorBody } from "./errors.ts";

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

// The proxy sets x-console-user-* after verifying identity; anything the client sent under those names was stripped.
export function userOf(req: NextRequest): User {
  const email = req.headers.get("x-console-user-email");
  if (!email) throw new HttpError(401, "not authenticated");
  const role = req.headers.get("x-console-user-role");
  return { id: req.headers.get("x-console-user-id") ?? email, email, role: isRole(role) ? role : "viewer" }; // fail safe: no role header → least privilege
}

export function requirePerm(user: User, perm: Perm, protectedEnv = false) {
  if (!can(user, perm, protectedEnv)) throw new HttpError(403, `your role (${user.role}) can't do this — needs ${roleFor(perm, protectedEnv)}`);
}

// Each proxy in front appends the address it saw to X-Forwarded-For, so with N trusted proxies the client is the Nth
// entry from the end; anything before it is client-supplied and never trusted (audit IPs, rate limits).
// CONSOLE_TRUSTED_PROXIES: 1 (default: one ALB or reverse proxy), 2 (CloudFront → ALB, …), 0 (nothing in front:
// X-Forwarded-For is ignored and per-address limits switch off — see limits.ts).
const hops = () => {
  const n = Number(process.env.CONSOLE_TRUSTED_PROXIES ?? 1);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
};
export const ipOf = (req: NextRequest) => {
  const n = hops();
  if (!n) return undefined;
  const list = req.headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return list.length >= n ? list[list.length - n] : undefined;
};

// Shape check only; whether the env exists is answered by discovery (envInfo → 404).
export function envOf(v: unknown): EnvName {
  if (typeof v !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(v)) throw new HttpError(400, "env must be an environment id");
  return v;
}

export function handle<C>(fn: (req: NextRequest, ctx: C) => Promise<Response>) {
  return async (req: NextRequest, ctx: C) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        const res = json(errorBody(e), e.status); // { error, code?, setup?, operationId? }
        if (e.retryAfterMs) res.headers.set("Retry-After", String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))));
        return res;
      }
      const status = (e as { status?: number }).status;
      if (typeof status === "number" && status >= 400 && status < 600) return json({ error: errText(e) }, status === 401 ? 502 : status);
      console.error(JSON.stringify({ level: 50, msg: "route error", path: req.nextUrl.pathname, err: errText(e) }));
      return json({ error: errText(e) }, 502);
    }
  };
}

// 10 KB covers every form; routes that carry values (the Variables editor) pass a larger cap. The cap is in bytes and
// holds before the body is buffered (F64): a Content-Length above it is refused at once, and a body without one (or
// lying about it) is counted while it streams and cut off at the cap.
export async function readJson(req: NextRequest, max = 10_000) {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > max) {
    await req.body?.cancel().catch(() => {});
    throw new HttpError(413, "body too large");
  }
  const text = await readCapped(req.body, max);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "body too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
