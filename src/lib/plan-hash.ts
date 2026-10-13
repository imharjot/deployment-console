// Hashes that bind an approval to the exact change it approved (AGENT_ARCHITECTURE §6 "Approval"). An approval grant
// stores planHash(); executing the change recomputes it and refuses on any difference, so "approve restart of api"
// can't be replayed as "restart worker" or with other input. Pure.
//
// Secret inputs (a variable value, a token) are never hashed raw — a bare SHA-256 of a short secret is guessable
// offline — but HMAC'd with a server key (derived from CONSOLE_SECRET_KEY by the caller), so a changed secret still
// changes the hash while the hash reveals nothing about the value.
import { createHash, createHmac } from "node:crypto";

// JSON with object keys sorted at every level; undefined members dropped (array holes become null, like JSON).
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortValue(v, new Set())) ?? "null";
}

function sortValue(v: unknown, seen: Set<object>): unknown {
  if (v === null || typeof v !== "object") {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    return typeof v === "function" || typeof v === "symbol" ? undefined : v;
  }
  const json = (v as { toJSON?: () => unknown }).toJSON;
  if (typeof json === "function") return sortValue(json.call(v), seen); // Dates → ISO strings
  if (seen.has(v)) throw new TypeError("canonicalJson: circular structure");
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => sortValue(x, seen) ?? null);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = sortValue((v as Record<string, unknown>)[k], seen);
      if (x !== undefined) out[k] = x;
    }
    return out;
  } finally {
    seen.delete(v);
  }
}

const sha256 = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

// Paths are dot-separated; "*" matches any key or array index: "token", "changes.*.set.*".
const matches = (path: string[], pattern: string[]) => path.length === pattern.length && pattern.every((p, i) => p === "*" || p === path[i]);

function sealSecrets(v: unknown, secretFields: string[], hmacKey: string): unknown {
  const patterns = secretFields.map((f) => f.split("."));
  const walk = (x: unknown, at: string[]): unknown => {
    if (at.length && patterns.some((p) => matches(at, p))) {
      if (x === undefined) return undefined;
      if (!hmacKey) throw new Error("plan hash: a secret field needs an HMAC key; secrets are never hashed raw");
      return { $secret: `hmac-sha256:${createHmac("sha256", hmacKey).update("plan-hash-secret\0").update(canonicalJson(x)).digest("hex")}` };
    }
    if (Array.isArray(x)) return x.map((y, i) => walk(y, [...at, String(i)]));
    if (x && typeof x === "object" && typeof (x as { toJSON?: unknown }).toJSON !== "function") {
      const out: Record<string, unknown> = {};
      for (const [k, y] of Object.entries(x as Record<string, unknown>)) out[k] = walk(y, [...at, k]);
      return out;
    }
    return x;
  };
  return walk(v, []);
}

// Hash of an operation's input with its secret fields HMAC'd.
export function inputHash(input: Record<string, unknown>, secretFields: string[], hmacKey: string): string {
  return sha256(canonicalJson(sealSecrets(input, secretFields, hmacKey)));
}

// Hash of the exact plan: operation (and its version), the set of targets (order-free), the input (secrets HMAC'd),
// the ordered list of changes and the preconditions it was planned against.
export function planHash(
  p: { op: string; opVersion?: string; targets: string[]; input: Record<string, unknown>; secretFields: string[]; changes?: string[]; preconditions?: Record<string, unknown> },
  hmacKey: string,
): string {
  return sha256(
    canonicalJson({
      v: 1,
      op: p.op,
      opVersion: p.opVersion,
      targets: [...new Set(p.targets)].sort(),
      input: sealSecrets(p.input, p.secretFields, hmacKey),
      changes: p.changes,
      preconditions: p.preconditions,
    }),
  );
}
