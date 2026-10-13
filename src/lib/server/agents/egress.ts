// Egress for model endpoints (AGENT_ARCHITECTURE §6, REVIEW R09): the only way the console reaches a model provider
// over HTTP. A request goes to the connection's endpoint — the provider's built-in default or an admin-registered
// entry, chosen by the credential broker — plus a fixed API path the adapter names. Nothing a model, a tool result or
// a run supplies can change the destination: an absolute or protocol-relative URL, a path that climbs out of the
// endpoint, and a redirect are refused.
//
// On top of safeFetch() (src/lib/plugins/http.ts: one DNS resolution, every address checked, the connection pinned to
// a checked address, TLS still verified against the name, link-local and metadata addresses refused in every
// spelling):
// - a cloud endpoint may resolve only to public addresses;
// - a local endpoint (an admin allowed loopback/private addresses for it) must resolve ONLY to loopback/private
//   addresses, so a DNS change can't quietly turn "local" into a public destination;
// - redirects are never followed (register the final URL instead).
import "server-only";
import { EgressRefused, checkTarget, privateAddress, safeFetch, type Address, type Resolver, type SafeInit } from "../../plugins/http.ts";

export { EgressRefused } from "../../plugins/http.ts";

export interface EndpointGrant {
  base: string; // the connection's endpoint: https://api.anthropic.com, or a registered entry's URL
  local: boolean; // the admin allowed loopback/private addresses for it (and only those)
}

export interface EgressTestOptions {
  resolve?: Resolver; // tests: stands in for DNS
}

// The URL a request goes to: the endpoint plus a fixed API path ("/v1/messages"). A full URL — whatever it says — is
// refused, as is anything that could leave the endpoint's path (.., //, backslashes, encoded slashes or dots).
export function modelUrl(base: string, path: string): URL {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
    throw new EgressRefused("model endpoints are called with a fixed API path, never a URL — a model-supplied URL is never fetched");
  if (/[\\\u0000-\u001f\u007f]|%2e|%2f|%5c/i.test(path) || /(^|\/)\.\.?(\/|\?|#|$)/.test(path))
    throw new EgressRefused("that API path isn't allowed");
  let b: URL;
  try {
    b = new URL(base);
  } catch {
    throw new EgressRefused("the connection's endpoint isn't a valid URL");
  }
  if (b.protocol !== "https:" && b.protocol !== "http:") throw new EgressRefused("only http(s) endpoints");
  const u = new URL(`${b.origin}${b.pathname.replace(/\/+$/, "")}${path}`);
  if (u.origin !== b.origin) throw new EgressRefused("that API path leaves the endpoint");
  return u;
}

// A URL an adapter built itself must stay inside the connection's endpoint (same origin, under its path). Anything
// else — a URL taken from a model's output, a provider's "next" link to another host — is refused.
export function assertWithinEndpoint(base: string, url: string | URL): URL {
  let u: URL;
  let b: URL;
  try {
    u = new URL(url);
    b = new URL(base);
  } catch {
    throw new EgressRefused("invalid URL");
  }
  const prefix = b.pathname.replace(/\/+$/, "");
  if (u.origin !== b.origin || (prefix && u.pathname !== prefix && !u.pathname.startsWith(`${prefix}/`)) || u.username || u.password)
    throw new EgressRefused("that URL isn't the connection's endpoint — a model-supplied URL is never fetched");
  return u;
}

// Resolves the endpoint once and checks its addresses for the connection's egress class. Returns the checked
// addresses (a request then dials only those).
export async function checkModelEndpoint(grant: EndpointGrant, o: EgressTestOptions & { signal?: AbortSignal } = {}): Promise<Address[]> {
  const t = await checkTarget(grant.base, { allowPrivate: grant.local, resolve: o.resolve });
  if (grant.local && t.addresses.some((a) => !privateAddress(a.address)))
    throw new EgressRefused("a local endpoint must resolve only to loopback or private addresses — this one also resolves to a public address");
  return t.addresses;
}

// fetch() for a model endpoint: the destination is fixed by the grant and the path; the addresses are checked for the
// egress class and the socket is pinned to them; redirects are refused.
export async function modelFetch(grant: EndpointGrant, path: string, init: Omit<SafeInit, "redirect"> = {}, o: EgressTestOptions = {}): Promise<Response> {
  const url = modelUrl(grant.base, path);
  const addresses = await checkModelEndpoint(grant, o);
  // safeFetch checks again (link-local, private unless allowed) and pins the socket; it reuses exactly these addresses.
  return safeFetch(url, { ...init, redirect: "error" }, { allowPrivate: grant.local, maxRedirects: 0, resolve: async () => addresses });
}
