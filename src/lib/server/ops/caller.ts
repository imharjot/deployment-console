// Route helpers for the agent surface: who is calling (from the headers the proxy set after verifying a session, the
// ALB, the dev user, an API token or an agent token — client-sent copies were stripped), a body reader with room for
// variable values, and error responses that keep a validation failure's list of problems.
import "server-only";
import type { NextRequest } from "next/server";
import { isTokenMode } from "../../automation.ts";
import { HttpError } from "../errors.ts";
import { ipOf, json, userOf } from "../http.ts";
import { OpInputError, resolveCaller, type Caller } from "./index.ts";

export function callerOf(req: NextRequest): Caller {
  const user = userOf(req);
  const via = req.headers.get("x-console-auth-via");
  const ip = ipOf(req);
  if (via === "agent") {
    // An agent token (Bearer da_…): the proxy verified it and named the token and its run; the principal and the run's
    // policy are loaded by resolveCaller() (agentCallerOf) or invoke().
    const tokenId = req.headers.get("x-console-agent-principal") ?? undefined;
    const runId = req.headers.get("x-console-agent-run") ?? undefined;
    if (!tokenId || !runId) throw new HttpError(401, "not authenticated");
    return { user, via: "agent", ip, tokenId, runId, tokenName: req.headers.get("x-console-agent-token-name") ?? undefined };
  }
  if (via === "token") {
    const mode = req.headers.get("x-console-token-mode");
    const tokenId = req.headers.get("x-console-token-id") ?? undefined;
    if (!tokenId) throw new HttpError(401, "not authenticated");
    return { user, via: "token", ip, tokenId, tokenName: req.headers.get("x-console-token-name") ?? undefined, tokenMode: isTokenMode(mode) ? mode : "read" };
  }
  return { user, via: via === "alb" || via === "dev" ? via : "session", ip };
}

// The caller, with an agent's principal and policy loaded (routes that list or filter by them).
export async function agentCallerOf(req: NextRequest): Promise<Caller> {
  return resolveCaller(callerOf(req));
}

// People only: tokens never reach these routes (the proxy refuses them), checked again here in case a route moves.
export function personOf(req: NextRequest): Caller {
  const c = callerOf(req);
  if (c.via === "token" || c.via === "agent") throw new HttpError(403, `${c.via === "agent" ? "Agent" : "API"} tokens can't do this — it needs a person signed in to the console`);
  return c;
}

// Operation input can carry several variable values (up to 32 KiB each), so the body limit is higher than readJson's.
export async function readBody(req: NextRequest, max = 256 * 1024): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "body too large");
  let b: unknown;
  try {
    b = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "body must be a JSON object");
  return b as Record<string, unknown>;
}

// Wraps a route body so a validation failure answers 400 { error, problems } (handle() keeps only the message).
export async function withProblems(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OpInputError) return json({ error: e.message, problems: e.problems }, 400);
    throw e;
  }
}
