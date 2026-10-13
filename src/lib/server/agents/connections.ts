// What the connection routes do (master plan §3.5; people only — API and agent tokens never reach these routes, and
// personFrom() checks again): list a person's own and the organisation's connections with the endpoint registry and
// the form's provider list; create, change, rotate and revoke; test a connection through its adapter (or a local
// runtime's availability check); list its models. Every answer is metadata: a secret goes in once (write-only) and never
// comes back, and a provider's error message is scrubbed of the connection's own secret and of anything redact()
// recognises before anyone sees it.
import "server-only";
import type { NextRequest } from "next/server";
import { PROVIDERS, type ConnectionPolicy, type ConnectionView, type EndpointEntry, type ProviderSpec } from "../../agents/connection-rules.ts";
import type { Capabilities, InferenceProvider, ResolvedConnection } from "../../agents/inference/types.ts";
import { HttpError, errText } from "../errors.ts";
import { ipOf, userOf } from "../http.ts";
import { sourceKind } from "../sources.ts";
import {
  createConnection, getConnection, listConnections, markConnectionStatus, readConnectionPolicy, readEndpoints, resolveConnection, revokeConnection, saveConnectionSettings,
  updateConnection, type Actor, type BrokeredConnection,
} from "./credentials.ts";
import { adapterFor } from "./inference/registry.ts";
import { runtimeForProvider } from "./runtime/registry.ts";

// A person signed in to the console (session, ALB or the loopback dev user). The proxy keeps tokens off these routes;
// this is the second check, in case a route moves.
export function personFrom(req: NextRequest): Actor {
  const via = req.headers.get("x-console-auth-via");
  if (via !== "session" && via !== "alb" && via !== "dev") throw new HttpError(403, "model connections are managed by a person signed in to the console — API and agent tokens can't use this");
  return { user: userOf(req), ip: ipOf(req) };
}

// ---------- list ----------

export interface ProviderOption extends ProviderSpec {
  canCreate: boolean;
  why?: string; // why this viewer can't create one here
  signIn?: string; // created by a sign-in flow that starts here
}

export interface ConnectionsList {
  connections: ConnectionView[];
  endpoints: EndpointEntry[]; // admins: all; others: the ones personal connections may use
  providers: ProviderOption[];
  policy: ConnectionPolicy;
  admin: boolean;
}

const chatgptPlanOn = () => process.env.CONSOLE_CHATGPT_PLAN?.trim().toLowerCase() === "eligible";

function providerOptions(admin: boolean, policy: ConnectionPolicy): ProviderOption[] {
  const mock = sourceKind() === "mock";
  return PROVIDERS.filter((p) => (!p.mockOnly || mock) && (!p.flag || chatgptPlanOn())).map((p) => {
    // The same rules checkNewConnection() applies, so the form doesn't offer what the POST would refuse.
    const why =
      policy.providers && !policy.providers.includes(p.id) ? "the organisation's policy doesn't allow it"
      : p.adminOnly && !admin ? "only an admin can connect it"
      : !policy.personal && (p.personalOnly || !admin) ? `the organisation's policy allows organisation connections only${p.personalOnly ? "" : " — an admin creates them"}`
      : policy.localOnly && p.egress === "cloud" && !p.endpoint ? "the organisation's policy allows only local model endpoints"
      : undefined;
    return {
      ...p,
      canCreate: !why && p.createVia !== "oauth",
      ...(why ? { why } : {}),
      ...(p.createVia === "oauth" && !why ? { signIn: "/api/agents/oauth/chatgpt/start" } : {}),
    };
  });
}

export async function listFor(actor: Actor, o: { all?: boolean } = {}): Promise<ConnectionsList> {
  const admin = actor.user.role === "admin";
  const [connections, endpoints, policy] = await Promise.all([listConnections(actor.user, { all: o.all }), readEndpoints(), readConnectionPolicy()]);
  return { connections, endpoints: admin ? endpoints : endpoints.filter((e) => e.personal), providers: providerOptions(admin, policy), policy, admin };
}

// ---------- change ----------

export const create = (actor: Actor, body: unknown) => createConnection(body, actor, { via: "form" });
export const update = (actor: Actor, id: string, body: unknown) => updateConnection(id, body, actor);
export const view = (actor: Actor, id: string) => getConnection(id, actor.user);

export async function revoke(actor: Actor, id: string, body: unknown): Promise<{ connection: ConnectionView; pausedRuns: string[] }> {
  const reason = body && typeof body === "object" && Object.hasOwn(body, "reason") ? (body as { reason?: unknown }).reason : undefined;
  if (reason !== undefined && typeof reason !== "string") throw new HttpError(400, "reason must be text");
  return revokeConnection(id, actor, { reason });
}

export async function settings(actor: Actor, body: unknown): Promise<{ endpoints: EndpointEntry[]; policy: ConnectionPolicy }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== "endpoints" && k !== "policy") throw new HttpError(400, `unknown field "${k}"`);
  return saveConnectionSettings({ endpoints: Object.hasOwn(b, "endpoints") ? b.endpoints : undefined, policy: Object.hasOwn(b, "policy") ? b.policy : undefined }, actor);
}

// ---------- test and models ----------

export interface ModelEntry {
  id: string;
  label: string;
  capabilities: Capabilities;
  cloud?: boolean;
  crossRegion?: boolean;
}

export interface TestResult {
  ok: boolean;
  model?: string;
  models?: ModelEntry[];
  capabilities?: Capabilities;
  warnings?: string[];
  runtime?: { version?: string };
  error?: string; // redacted
  errorKind?: string;
}

const isRuntime = (c: BrokeredConnection): c is Extract<BrokeredConnection, { provider: "runtime:claude-code" | "runtime:gemini-cli" }> =>
  c.provider === "runtime:claude-code" || c.provider === "runtime:gemini-cli";

const TEST_TIMEOUT_MS = 20_000;

// Validates a connection with its provider (the person must be allowed to use it: someone else's personal connection
// is 403 before anything is opened). A provider failure is { ok: false, error } with the error scrubbed; the
// connection's status follows (a refused credential → needs_auth, a pass → active).
export async function test(actor: Actor, id: string): Promise<TestResult> {
  const conn = await resolveConnection(id, { kind: "test", user: actor.user });
  try {
    if (isRuntime(conn)) {
      const rt = runtimeForProvider(conn.provider);
      if (!rt) return { ok: false, error: "this local runtime isn't available in this console" };
      const a = await rt.available();
      return a.ok ? { ok: true, runtime: { ...(a.version ? { version: a.version } : {}) } } : { ok: false, error: await conn.scrub(a.why ?? "the runtime isn't available") };
    }
    const adapter = adapterFor(conn.provider as InferenceProvider);
    const v = await adapter.validate(conn as ResolvedConnection, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    if (v.ok) await markConnectionStatus(id, "active");
    else if (v.error?.kind === "auth") await markConnectionStatus(id, "needs_auth");
    const warnings = v.warnings?.length ? await Promise.all(v.warnings.map((w) => conn.scrub(w))) : undefined;
    return {
      ok: v.ok,
      ...(v.model ? { model: v.model } : {}),
      ...(v.models ? { models: v.models.map(modelEntry) } : {}),
      ...(v.capabilities ? { capabilities: v.capabilities } : {}),
      ...(warnings ? { warnings } : {}),
      ...(v.error ? { error: await conn.scrub(v.error.message), errorKind: v.error.kind } : {}),
    };
  } catch (e) {
    return { ok: false, error: await conn.scrub(errText(e)), ...(kindOf(e) ? { errorKind: kindOf(e) } : {}) };
  }
}

const modelEntry = (m: { id: string; label: string; capabilities: Capabilities; cloud?: boolean; crossRegion?: boolean }): ModelEntry => ({
  id: m.id, label: m.label, capabilities: m.capabilities, ...(m.cloud ? { cloud: true } : {}), ...(m.crossRegion ? { crossRegion: true } : {}),
});

const kindOf = (e: unknown) => {
  const k = (e as { kind?: unknown } | null)?.kind;
  return typeof k === "string" ? k : undefined;
};

// The models a connection offers (GET /api/agents/models?connection=). A local runtime picks its own model, so its
// list is empty. A provider failure is 502 with the error scrubbed.
export async function models(actor: Actor, id: string): Promise<{ models: ModelEntry[] }> {
  if (typeof id !== "string" || !id) throw new HttpError(400, "connection is required (?connection=<id>)");
  const conn = await resolveConnection(id, { kind: "models", user: actor.user });
  if (isRuntime(conn)) return { models: [] };
  try {
    const list = await adapterFor(conn.provider as InferenceProvider).models(conn as ResolvedConnection, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    return { models: list.map(modelEntry) };
  } catch (e) {
    const err = new HttpError(502, `the provider didn't list its models: ${await conn.scrub(errText(e))}`);
    if (kindOf(e)) err.code = kindOf(e);
    if (kindOf(e) === "auth") await markConnectionStatus(id, "needs_auth");
    throw err;
  }
}
