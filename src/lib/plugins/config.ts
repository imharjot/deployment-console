// Integration config at rest and over the wire. Pure: sealing is passed in so tests don't need the server key.
// Stored:  { field: value } with every "secret" field sealed individually.
// Browser: secrets become { set: true } — the value never leaves the server.
// Edit:    a secret left empty / { set: true } keeps the stored value, a new string replaces it, null clears it.
import type { Config, Field } from "./types.ts";

export type Stored = Record<string, string>;
export type Redacted = Record<string, string | { set: true }>;

const MAX = 2_000;

export function redact(fields: Field[], stored: Stored): Redacted {
  const out: Redacted = {};
  for (const f of fields) {
    const v = stored[f.key];
    if (!v) continue;
    out[f.key] = f.type === "secret" ? { set: true } : v;
  }
  return out;
}

export function open(fields: Field[], stored: Stored, unseal: (s: string) => string): Config {
  const out: Config = {};
  for (const f of fields) {
    const v = stored[f.key] ?? "";
    out[f.key] = v && f.type === "secret" ? unseal(v) : v;
  }
  return out;
}

function checkValue(f: Field, v: string): string | null {
  if (v.length > MAX) return `${f.label} is too long`;
  if (f.type === "url") {
    try {
      const u = new URL(v);
      if (u.protocol !== "https:" && u.protocol !== "http:") return `${f.label} must be an http(s) URL`;
    } catch {
      return `${f.label} must be a URL`;
    }
  }
  if (f.type === "select" && f.options && !f.options.some((o) => o.value === v)) return `${f.label} must be one of ${f.options.map((o) => o.value).join(", ")}`;
  return null;
}

// Unknown keys in `incoming` are ignored: only declared fields are ever stored (no hidden knobs like API base URLs).
export function merge(fields: Field[], stored: Stored, incoming: unknown, seal: (s: string) => string): { ok: true; stored: Stored; changed: string[] } | { ok: false; error: string } {
  const inc = (incoming && typeof incoming === "object" ? incoming : {}) as Record<string, unknown>;
  const next: Stored = {};
  const changed: string[] = [];
  for (const f of fields) {
    const v = inc[f.key];
    const prev = stored[f.key] ?? "";
    let value = prev;
    if (v === null) value = "";
    else if (typeof v === "string") {
      const t = v.trim();
      if (f.type === "secret") value = t ? seal(t) : prev; // empty = untouched secret input
      else value = t;
      if (t) {
        const err = checkValue(f, t);
        if (err) return { ok: false, error: err };
      }
    } else if (v !== undefined && !(typeof v === "object" && (v as { set?: unknown }).set === true)) {
      return { ok: false, error: `${f.label} must be a string` };
    }
    if (f.required && !value) return { ok: false, error: `${f.label} is required` };
    if (value) next[f.key] = value;
    if (value !== prev) changed.push(f.key);
  }
  return { ok: true, stored: next, changed };
}
