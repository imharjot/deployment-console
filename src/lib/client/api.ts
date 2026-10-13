"use client";

// The server's error body is { error, code?, setup?, operationId? } (errorBody() in src/lib/server/errors.ts): `code`
// names the kind ("not_configured", "outcome_unknown", …), `setup` links the docs that fix it.
export class ApiError extends Error {
  status: number;
  code?: string;
  setup?: string;
  operationId?: string;
  constructor(status: number, message: string, extra: { code?: string; setup?: string; operationId?: string } = {}) {
    super(message);
    this.status = status;
    if (extra.code) this.code = extra.code;
    if (extra.setup) this.setup = extra.setup;
    if (extra.operationId) this.operationId = extra.operationId;
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

// A 401 from any API call means the session ended (expired, revoked, user disabled): go sign in again and come back.
// Not on the sign-in pages themselves, where a 401 is just "wrong password".
let leaving = false;
function toLogin() {
  if (leaving || typeof window === "undefined" || /^\/(login|setup|invite)(\/|$)/.test(window.location.pathname)) return;
  leaving = true;
  window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

async function parse(res: Response) {
  if (res.status === 401) toLogin();
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: a proxy, load balancer or sign-in page answered instead of the console. A 200 must never reach a
    // component as data of the wrong shape, and HTML never belongs in an error message.
    if (res.ok) throw new ApiError(502, "Unexpected response from the server (not JSON). A proxy or sign-in page may be in the way; reload the page.");
    const html = /html/i.test(res.headers.get("content-type") ?? "") || /^\s*</.test(text);
    throw new ApiError(res.status, html || !text.trim() ? `HTTP ${res.status}` : `HTTP ${res.status}: ${text.trim().slice(0, 200)}`);
  }
  if (!res.ok) {
    const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; code?: unknown; setup?: unknown; operationId?: unknown };
    throw new ApiError(res.status, str(b.error) ?? `HTTP ${res.status}`, { code: str(b.code), setup: str(b.setup), operationId: str(b.operationId) });
  }
  return body;
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
  return parse(res) as Promise<T>;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-console-csrf": "1" },
    body: JSON.stringify(body),
  });
  return parse(res) as Promise<T>;
}

export async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-console-csrf": "1" },
    body: JSON.stringify(body),
  });
  return parse(res) as Promise<T>;
}

export async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-console-csrf": "1" },
    body: JSON.stringify(body),
  });
  return parse(res) as Promise<T>;
}

export const fetcher = (url: string) => getJson(url);
