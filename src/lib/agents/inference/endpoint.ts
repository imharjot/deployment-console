// Where a model request may go. The endpoint comes only from the resolved connection: the provider's built-in default,
// or an entry an admin registered (the credential broker sets `endpointRegistered`); a model, a run or a tool result
// can never supply one. Egress is checked with the console's guard (src/lib/plugins/http.ts: link-local and metadata
// addresses always refused, every address checked and pinned for the socket). Two extra rules for model endpoints:
// - a "local" connection (Ollama, a local server) must resolve to loopback or private addresses only — and stays
//   pinned to the addresses checked, so a DNS answer can't later point it at the internet;
// - plain http is allowed only to loopback or private addresses (an API key never crosses the internet unencrypted).
import { checkTarget, privateAddress, type Resolver } from "../../plugins/http.ts";
import { ANTHROPIC_DEFAULT_BASE } from "./anthropic-wire.ts";
import { OPENAI_DEFAULT_BASE } from "./openai-wire.ts";
import { InferenceError, type InferenceProvider, type ResolvedConnection } from "./types.ts";

export const BUILT_IN_ENDPOINTS: Readonly<Partial<Record<InferenceProvider, string>>> = { anthropic: ANTHROPIC_DEFAULT_BASE, openai: OPENAI_DEFAULT_BASE };

export interface EndpointPlan {
  base: URL;
  custom: boolean; // an admin-registered endpoint rather than the built-in default
  allowPrivate: boolean; // private addresses allowed (registered endpoints only)
  requirePrivate: boolean; // every address must be loopback/private (local egress, or plain http)
  local: boolean;
}

const refuse = (label: string, why: string) => new InferenceError("invalid_request", `${label}: ${why}`, { provider: label, code: "egress" });

// The built-in default, however it is spelled ("https://api.openai.com", "…/v1", a trailing slash).
function isBuiltIn(raw: string, builtIn: string | undefined): boolean {
  if (!builtIn) return false;
  try {
    const u = new URL(raw);
    return u.origin === new URL(builtIn).origin && /^(\/v1)?\/?$/.test(u.pathname) && !u.search && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function planEndpoint(conn: Pick<ResolvedConnection, "provider" | "endpoint" | "endpointRegistered" | "egress">, label: string): EndpointPlan {
  const builtIn = BUILT_IN_ENDPOINTS[conn.provider];
  let raw = typeof conn.endpoint === "string" ? conn.endpoint.trim() : "";
  if (raw && isBuiltIn(raw, builtIn)) raw = "";
  if (raw && conn.endpointRegistered !== true) throw refuse(label, "a custom endpoint needs an entry an admin registered for agent connections");
  if (!raw && !builtIn) throw refuse(label, "this connection needs an admin-registered endpoint");
  let u: URL;
  try {
    u = new URL(raw || builtIn!);
  } catch {
    throw refuse(label, "the endpoint is not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw refuse(label, "the endpoint must be an http(s) URL");
  if (u.username || u.password) throw refuse(label, "the endpoint must not carry credentials");
  if (u.search || u.hash) throw refuse(label, "the endpoint must not have a query or fragment");
  const local = conn.egress === "local";
  return { base: u, custom: !!raw, allowPrivate: !!raw, requirePrivate: local || u.protocol === "http:", local };
}

// The fetch options for this plan. When every address must be private, the host is resolved once here, checked, and the
// request is pinned to exactly those addresses.
export async function egressFor(plan: EndpointPlan, label: string, resolve?: Resolver): Promise<{ allowPrivate: boolean; resolve?: Resolver }> {
  if (!plan.requirePrivate) return { allowPrivate: plan.allowPrivate, ...(resolve ? { resolve } : {}) };
  let t;
  try {
    t = await checkTarget(plan.base, { allowPrivate: true, ...(resolve ? { resolve } : {}) });
  } catch (e) {
    if ((e as Error)?.name === "EgressRefused") throw refuse(label, (e as Error).message);
    throw new InferenceError("unavailable", `${label} endpoint could not be resolved`, { provider: label, code: (e as { code?: string })?.code });
  }
  if (t.addresses.some((a) => !privateAddress(a.address)))
    throw refuse(label, plan.local ? "a local-only connection's endpoint must resolve to loopback or private addresses" : "plain http is only allowed to loopback or private addresses");
  const pinned = t.addresses;
  return { allowPrivate: true, resolve: async () => pinned };
}

// <base> + path. OpenAI-style bases include the version ("https://api.openai.com/v1"); a bare origin gets "/v1".
// Anthropic-style bases don't ("https://api.anthropic.com" + "/v1/messages"); a registered base ending in /v1 is
// accepted either way.
export function apiUrl(base: URL, path: string, style: "openai" | "anthropic" | "root"): string {
  let p = base.pathname.replace(/\/+$/, "");
  if (style === "openai" && !p) p = "/v1";
  if (style === "anthropic" || style === "root") p = p.replace(/\/v1$/, "");
  return `${base.origin}${p}${style === "anthropic" ? "/v1" : ""}${path}`;
}
