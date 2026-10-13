// One outbound HTTP helper for every plugin: request builders return a Req (unit-testable), send() performs it.
// Errors never include the request URL or headers — Slack/webhook URLs and tokens are secrets.
// safeFetch()/checkTarget() are the egress guard for every URL someone configures: integrations (send), health-check
// probes (src/lib/server/probes.ts) and model endpoints (wave C).
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export interface Req {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface Res {
  status: number;
  text: string;
  json: unknown;
}

export const UA = "deployment-console";

export const jsonReq = (method: Req["method"], url: string, headers: Record<string, string>, body?: unknown): Req => ({
  method,
  url,
  headers: { Accept: "application/json", "User-Agent": UA, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Pulls a human error out of the common API error shapes (GitHub, Jira, ClickUp, Asana, Linear, Slack's plain text).
export function apiError(json: unknown, text: string): string {
  const o = json as Record<string, unknown> | null;
  if (o && typeof o === "object") {
    const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const errs = o.errors;
    if (Array.isArray(errs) && errs.length) {
      const first = errs[0] as Record<string, unknown>;
      const m = pick(first?.message) ?? pick(first);
      if (m) return m;
    }
    if (errs && typeof errs === "object" && !Array.isArray(errs)) {
      const vals = Object.entries(errs as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`);
      if (vals.length) return vals.join("; ");
    }
    const msgs = o.errorMessages;
    if (Array.isArray(msgs) && typeof msgs[0] === "string") return msgs[0];
    const m = pick(o.message) ?? pick(o.err) ?? pick(o.error) ?? pick(o.error_description);
    if (m) return m;
  }
  return text.trim().slice(0, 160) || "no response body";
}

// ---------- egress rules (F33 / R09) ----------
//
// Link-local addresses serve cloud credentials (EC2 instance metadata 169.254.169.254, ECS task metadata
// 169.254.170.2, IPv6 fd00:ec2::254 and the rest of AWS's fd00:ec2::/32): no outbound URL may reach them, not even an
// admin's. 0.0.0.0/8 and :: mean "this host". Each IPv4 range is also listed in its IPv6 spellings — IPv4-mapped
// (::ffff:a.b.c.d; BlockList matches those against the IPv4 rules anyway), IPv4-compatible (::a.b.c.d), IPv4-translated
// (::ffff:0:a.b.c.d, SIIT) and NAT64 (64:ff9b::a.b.c.d, RFC 6052) — because new URL() normalises
// "[::ffff:169.254.169.254]" to "[::ffff:a9fe:a9fe]",
// which no prefix test on the text catches. ::1 is IPv6 loopback, never IPv4-compatible 0.0.0.1, so it is exempt here.
//
// Private addresses (RFC 1918, loopback, CGNAT, ULA, multicast, reserved) are a second, optional rule: integrations
// and health checks allow them on purpose — a self-hosted Jira or an internal webhook receiver is normal — while
// safeFetch() refuses them unless the caller passes { allowPrivate: true }.
type V4Range = [base: string, prefix: number];
type V6Rule = string | [base: string, prefix: number];

function rules(v4: V4Range[], v6: V6Rule[]): BlockList {
  const b = new BlockList();
  for (const [base, prefix] of v4) {
    b.addSubnet(base, prefix, "ipv4");
    for (const pre of ["::ffff:", "::", "::ffff:0:", "64:ff9b::"]) b.addSubnet(`${pre}${base}`, 96 + prefix, "ipv6");
  }
  for (const r of v6) {
    if (typeof r === "string") b.addAddress(r, "ipv6");
    else b.addSubnet(r[0], r[1], "ipv6");
  }
  return b;
}

const LINK_LOCAL = rules([["169.254.0.0", 16], ["0.0.0.0", 8]], [["fe80::", 10], ["fd00:ec2::", 32], "::"]);
const PRIVATE = rules(
  [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["100.64.0.0", 10], ["192.0.0.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]],
  ["::1", ["fc00::", 7], ["fec0::", 10], ["ff00::", 8]],
);
const LOOPBACK6 = rules([], ["::1"]);
const family = (ip: string) => (isIP(ip) === 6 ? "ipv6" : "ipv4");

// True for link-local, metadata and "this host" addresses in any spelling — and for anything that isn't an IP address
// (fail closed).
export function blockedAddress(ip: string): boolean {
  if (!isIP(ip)) return true;
  if (LOOPBACK6.check(ip, family(ip))) return false;
  return LINK_LOCAL.check(ip, family(ip));
}

// True for loopback, private, shared (CGNAT), unique-local, multicast and reserved addresses in any spelling.
export function privateAddress(ip: string): boolean {
  if (!isIP(ip)) return true;
  return PRIVATE.check(ip, family(ip));
}

export class EgressRefused extends Error {
  readonly code = "EGRESS_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "EgressRefused";
  }
}

export interface Address {
  address: string;
  family: 4 | 6;
}
export type Resolver = (host: string) => Promise<Address[]>;
export interface EgressOptions {
  allowPrivate?: boolean; // default false: only public addresses (link-local is refused either way)
  resolve?: Resolver; // tests: a resolver standing in for DNS
}
export interface Target {
  url: URL;
  host: string; // the hostname without IPv6 brackets: the Host header and the TLS server name
  addresses: Address[]; // every address the name resolved to, each one checked; the only ones a connection may use
}

const systemResolve: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

// Parses the URL (http/https only), resolves the host once and checks every address. Throws EgressRefused when any
// address is refused: a name that answers with one public and one link-local address is refused as a whole.
export async function checkTarget(url: string | URL, opts: EgressOptions = {}): Promise<Target> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new EgressRefused("invalid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new EgressRefused("only http(s) URLs are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new EgressRefused("invalid URL");
  const v = isIP(host);
  const addresses: Address[] = v ? [{ address: host, family: v === 6 ? 6 : 4 }] : await (opts.resolve ?? systemResolve)(host);
  if (!addresses.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  if (addresses.some((a) => blockedAddress(a.address))) throw new EgressRefused("that address is link-local (cloud metadata) and not allowed");
  if (!opts.allowPrivate && addresses.some((a) => privateAddress(a.address))) throw new EgressRefused("that address is private or loopback and not allowed here");
  return { url: u, host, addresses };
}

// ---------- safeFetch ----------

export interface SafeInit {
  method?: string;
  headers?: Record<string, string> | Headers | [string, string][];
  body?: string | Uint8Array | ArrayBuffer | URLSearchParams | null;
  signal?: AbortSignal;
  redirect?: "follow" | "manual" | "error"; // default follow, at most `maxRedirects` hops, each one checked again
}
export interface SafeOptions extends EgressOptions {
  maxRedirects?: number; // default and maximum 3
}

const MAX_REDIRECTS = 3;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

// The socket's DNS lookup: whatever name it is asked for, it answers with the addresses checkTarget() validated. The
// name is never resolved again, so a rebinding DNS server can't swap in another address between check and connect.
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;
export function pinnedLookup(addresses: Address[]) {
  return (_host: string, options: unknown, cb?: LookupCallback) => {
    const done = (typeof options === "function" ? options : cb) as LookupCallback;
    const o = (typeof options === "object" && options ? options : {}) as { family?: number | string; all?: boolean };
    const want = o.family === 4 || o.family === "IPv4" ? 4 : o.family === 6 || o.family === "IPv6" ? 6 : 0;
    const list = want ? addresses.filter((a) => a.family === want) : addresses;
    if (!list.length) return done(Object.assign(new Error("no checked address for that family"), { code: "ENOTFOUND" }), "", 0);
    if (o.all) return done(null, list.map((a) => ({ address: a.address, family: a.family })));
    done(null, list[0].address, list[0].family);
  };
}

// getaddrinfo can't be cancelled and can take far longer than a probe's or an integration's deadline: the caller's
// signal ends the wait (nothing has been sent yet, so it is a plain failure). The lookup finishes in the background.
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(failure(signal.reason, false));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(failure(signal.reason, false));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function bodyOf(init: SafeInit, headers: Record<string, string>): Buffer | undefined {
  const b = init.body;
  if (b === undefined || b === null) return undefined;
  if (typeof b === "string") return Buffer.from(b, "utf8");
  if (b instanceof URLSearchParams) {
    headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
    return Buffer.from(b.toString(), "utf8");
  }
  if (b instanceof ArrayBuffer) return Buffer.from(b);
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
}

function headerObject(h: SafeInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (k: string, v: string) => {
    const name = k.toLowerCase();
    if (name === "host" || name === "content-length" || name === "transfer-encoding" || name === "connection") return;
    out[name] = out[name] !== undefined ? `${out[name]}, ${v}` : v;
  };
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => add(k, v));
  else if (Array.isArray(h)) for (const [k, v] of h) add(k, v);
  else for (const [k, v] of Object.entries(h)) add(k, v);
  return out;
}

// An error that reached us after the whole request was written may hide an effect on the other side (a ticket created,
// a message posted): it is marked so mutate() records "outcome unknown" instead of "failed".
function failure(e: unknown, sent: boolean): Error {
  const err = e instanceof Error ? e : Object.assign(new Error(String((e as { message?: unknown })?.message ?? e)), { name: String((e as { name?: unknown })?.name ?? "Error") });
  if (sent) (err as Error & { afterSend?: boolean }).afterSend = true;
  return err;
}

function request(t: Target, method: string, headers: Record<string, string>, body: Buffer | undefined, signal: AbortSignal | undefined): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure(signal.reason, false));
    const tls = t.url.protocol === "https:";
    const h = { ...headers };
    if (body) h["content-length"] = String(body.length);
    let sent = false;
    let settled = false;
    const req = (tls ? httpsRequest : httpRequest)({
      protocol: t.url.protocol,
      hostname: t.host,
      port: t.url.port || (tls ? 443 : 80),
      path: `${t.url.pathname}${t.url.search}`,
      method,
      headers: h,
      agent: false, // no pooled socket: every connection is dialled to the addresses checked for this request
      lookup: pinnedLookup(t.addresses) as never,
      ...(tls && !isIP(t.host) ? { servername: t.host } : {}), // TLS still verifies the certificate against the name
    });
    const onAbort = () => req.destroy(failure(signal!.reason, sent));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("finish", () => void (sent = true));
    req.on("response", (res) => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (signal) {
        const stop = () => res.destroy(failure(signal.reason, true));
        signal.addEventListener("abort", stop, { once: true });
        res.on("close", () => signal.removeEventListener("abort", stop));
      }
      resolve(res);
    });
    req.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      if (!settled) reject(failure(e, sent));
    });
    req.end(body);
  });
}

function toResponse(res: IncomingMessage, method: string, url: URL): Response {
  const headers = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    try {
      headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
    } catch {
      // a header value Headers refuses (control characters) is dropped, not fatal
    }
  }
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599) {
    res.destroy();
    throw new Error(`invalid HTTP status ${status}`);
  }
  let body: Readable | null = res;
  if (NULL_BODY.has(status) || method === "HEAD") {
    res.resume();
    body = null;
  } else {
    const enc = headers.get("content-encoding")?.trim().toLowerCase();
    const inflate = enc === "gzip" || enc === "x-gzip" ? createGunzip() : enc === "deflate" ? createInflate() : enc === "br" ? createBrotliDecompress() : undefined;
    if (inflate) body = pipeline(res, inflate, () => {});
  }
  const out = new Response(body ? (Readable.toWeb(body) as ReadableStream<Uint8Array>) : null, { status, statusText: res.statusMessage ?? "", headers });
  Object.defineProperty(out, "url", { value: url.toString() });
  return out;
}

// fetch() for URLs an admin, a tag or a configuration supplies: http(s) only; the host resolved once and every address
// checked (link-local always refused, private refused unless allowPrivate); the connection made only to a checked
// address, with TLS verifying the certificate against the host name; each redirect checked again (at most 3, and
// credentials dropped when the origin changes). Returns a streaming Response (Server-Sent Events work).
export async function safeFetch(url: string | URL, init: SafeInit = {}, opts: SafeOptions = {}): Promise<Response> {
  const max = Math.min(MAX_REDIRECTS, Math.max(0, opts.maxRedirects ?? MAX_REDIRECTS));
  let method = (init.method ?? "GET").toUpperCase();
  const headers = headerObject(init.headers);
  headers["accept-encoding"] ??= "identity";
  let body = bodyOf(init, headers);
  let target = await untilAborted(checkTarget(url, opts), init.signal);
  for (let hops = 0; ; hops++) {
    const res = await request(target, method, headers, body, init.signal);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status < 300 || status > 399 || !location || (init.redirect ?? "follow") === "manual") return toResponse(res, method, target.url);
    res.resume();
    if (init.redirect === "error") throw new Error(`redirect refused (HTTP ${status})`);
    if (hops >= max) throw new Error(`too many redirects (more than ${max})`);
    let next: URL;
    try {
      next = new URL(location, target.url);
    } catch {
      throw new Error("redirect to an invalid URL");
    }
    if (next.origin !== target.url.origin) for (const k of CREDENTIAL_HEADERS) delete headers[k];
    if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
      if (method !== "HEAD") method = "GET";
      body = undefined;
      delete headers["content-type"];
    }
    target = await untilAborted(checkTarget(next, opts), init.signal);
  }
}

// ---------- send (integrations) ----------

function networkError(e: unknown): string {
  const err = e as Error & { code?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timed out";
  if (err instanceof EgressRefused) return err.message;
  if (err?.name === "TypeError" && /invalid url|failed to parse url/i.test(err.message)) return "invalid URL";
  return err?.code ?? err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
}

// The body as text, at most `max` bytes read (the rest is never buffered).
async function readText(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

// Integrations reach private addresses on purpose (self-hosted Jira, an internal webhook receiver); never link-local.
// Redirects are never followed, so a 30x can't bounce anywhere. A timeout or reset after the request was written is
// reported as "outcome unknown" (the vendor may have acted), so mutate() doesn't record it as a clean failure.
export async function send(label: string, req: Req, timeoutMs = 5_000): Promise<Res> {
  let res: Response;
  try {
    res = await safeFetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" }, { allowPrivate: true });
  } catch (e) {
    const err = new Error(`${label}: ${networkError(e)}`.slice(0, 240));
    if ((e as { afterSend?: boolean })?.afterSend) (err as { outcomeUnknown?: boolean }).outcomeUnknown = true;
    throw err;
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${label}: HTTP ${res.status} — redirects aren't followed; use the final URL`);
  }
  let text = "";
  try {
    text = await readText(res, 100_000);
  } catch (e) {
    // The vendor answered 2xx — it acted — but the answer (the ticket's id, say) was cut off: outcome unknown.
    if (res.ok) {
      const err = new Error(`${label}: the answer was cut off (${networkError(e)})`.slice(0, 240));
      (err as { outcomeUnknown?: boolean }).outcomeUnknown = true;
      throw err;
    }
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} — ${apiError(json, text)}`.slice(0, 240));
  return { status: res.status, text, json };
}

export const splitList = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
