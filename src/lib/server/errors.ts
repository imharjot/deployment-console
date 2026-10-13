// Errors that carry an HTTP status, and a short human description of anything thrown by AWS/GitHub/fetch.
// Pure (no server-only import) so the rules are unit-tested; only server code uses it.
import { roleArnFromCaller } from "../capability-rules.ts";

export class HttpError extends Error {
  status: number;
  retryAfterMs?: number; // 429/503: sent as Retry-After (seconds)
  code?: string; // machine-readable reason, sent next to `error` ("not_configured", "outcome_unknown")
  operationId?: string; // the operation this error belongs to (mutate())
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// A feature that needs setup nobody has done yet (no GitHub token, no CI repo): 503 with a pointer to the docs, so the
// UI can show "not configured" instead of an error (F37). JSON: { error, code: "not_configured", setup? }.
export class NotConfiguredError extends HttpError {
  setup?: string; // "/docs/github"
  constructor(message: string, setup?: string) {
    super(503, message);
    this.name = "NotConfiguredError";
    this.code = "not_configured";
    this.setup = setup;
  }
}

// The request may or may not have taken effect: it was sent, then the connection dropped or the deadline passed
// before an answer came back (F31). Never retried blindly; the operation is recorded as outcome_unknown.
export class OutcomeUnknownError extends HttpError {
  requestId?: string;
  constructor(message = "outcome unknown — check the resource before retrying", o: { cause?: unknown; requestId?: string } = {}) {
    super(502, message);
    this.name = "OutcomeUnknownError";
    this.code = "outcome_unknown";
    this.requestId = o.requestId;
    if (o.cause !== undefined) (this as { cause?: unknown }).cause = o.cause;
  }
}

// The JSON body for an HttpError: { error, code?, setup?, operationId? }. The extra fields let the UI and agents tell
// "not configured", busy, draining and "outcome unknown — check the resource" apart and link the operation record.
export function errorBody(e: HttpError): { error: string; code?: string; setup?: string; operationId?: string } {
  const setup = e instanceof NotConfiguredError ? e.setup : undefined;
  return { error: e.message, ...(e.code ? { code: e.code } : {}), ...(setup ? { setup } : {}), ...(e.operationId ? { operationId: e.operationId } : {}) };
}

// The SDK wrapper marks an abort or timeout that happened after the request left the process (AWS may have acted).
export function flagAfterSend<E>(e: E): E {
  if (e && typeof e === "object") (e as { afterSend?: boolean }).afterSend = true;
  return e;
}

type ErrLike = { name?: unknown; message?: unknown; code?: unknown; Code?: unknown; afterSend?: unknown; cause?: unknown };
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function isOutcomeUnknown(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  if (e instanceof OutcomeUnknownError) return true;
  const err = e as ErrLike;
  const name = str(err.name);
  // The flag plugins/http.ts sets (a plain Error keeps its name, so errText doesn't prefix one), as mutation-core reads it.
  if (name === "OutcomeUnknownError" || (e as { outcomeUnknown?: unknown }).outcomeUnknown === true) return true;
  if ((name === "AbortError" || name === "TimeoutError") && err.afterSend === true) return true;
  const msg = str(err.message);
  if (err.code === "ECONNRESET" || /\bECONNRESET\b/.test(msg) || /socket hang up/i.test(msg)) return true;
  // fetch wraps the socket error: TypeError("fetch failed", { cause: { code: "ECONNRESET" } })
  if (err.cause && err.cause !== e && typeof err.cause === "object") {
    const c = err.cause as ErrLike;
    if (c.code === "ECONNRESET" || /socket hang up/i.test(str(c.message))) return true;
  }
  return false;
}

const DENIED_NAMES = new Set(["AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "UnauthorizedException", "AuthorizationError"]);

// AccessDenied in any of AWS's spellings → the action and resource it names (when it names them).
// "User: arn:aws:sts::…:assumed-role/x/y is not authorized to perform: ecs:UpdateService on resource: arn:… because …"
export function accessDeniedOf(e: unknown): { action?: string; resource?: string } | undefined {
  if (!e || typeof e !== "object") return undefined;
  const err = e as ErrLike;
  const name = str(err.name) || str(err.Code) || str(err.code);
  const msg = str(err.message);
  if (!DENIED_NAMES.has(name) && !/not authorized to perform/i.test(msg)) return undefined;
  const out: { action?: string; resource?: string } = {};
  const action = msg.match(/not authorized to perform:?\s*([a-z0-9-]+:[A-Za-z0-9*]+)/i)?.[1];
  if (action) out.action = action;
  const resource = msg.match(/on resource:?\s*("?)([^\s"]+)\1/i)?.[2]?.replace(/[.,;]+$/, "");
  if (resource) out.resource = resource;
  return out;
}

const MAX = 240;
// Cut at a word boundary, never mid-word; the result (with the ellipsis) is at most `max` characters.
export function clip(s: string, max = MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// Never show who the console runs as: any session or user ARN, plus the caller AWS names in a refusal ("User: <arn>")
// and that caller's role, are replaced. Other role ARNs stay: the role a PassRole needs, or a task role ECS can't
// assume, is what the person has to fix.
const PRINCIPAL = /arn:aws[a-z-]*:(?:sts::\d{12}:(?:assumed-role|federated-user)|iam::\d{12}:user)\/[^\s"',)]+/g;
const CALLER = /\bUser:\s*(arn:aws[a-z-]*:(?:sts|iam)::\d{12}:[^\s"',)]+)/;

function redact(text: string, message: string): string {
  const caller = message.match(CALLER)?.[1];
  let out = text;
  if (caller) for (const arn of new Set([caller, roleArnFromCaller(caller)])) out = out.split(arn).join("<principal>");
  return out.replace(PRINCIPAL, "<principal>");
}

export const errText = (e: unknown): string => {
  const err = e as ErrLike | null | undefined;
  const name = str(err?.name);
  if (name === "TimeoutError" || name === "AbortError") return "timed out";
  const denied = accessDeniedOf(e);
  if (denied) {
    const what = denied.action ? `can't ${denied.action}` : "isn't allowed to do this";
    return clip(`The console's AWS identity ${what}${denied.resource ? ` on ${redact(denied.resource, str(err?.message))}` : ""}`);
  }
  const raw = String(str(err?.message) || (err && typeof err === "object" ? "" : e) || name || "error");
  const message = redact(raw, raw);
  return clip(name && name !== "Error" && name !== message ? `${name}: ${message}` : message);
};
