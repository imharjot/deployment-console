// Environment variables of an ECS container: rules that don't touch AWS, so they can be unit-tested.
// Three places a variable can live: the task definition (plain), a secret reference (SSM Parameter Store or
// Secrets Manager — the task definition holds only the reference) and an env file on S3 (`environmentFiles`).
// The browser imports this file too (the editor's name checks): nothing here may need Node.
import { canonicalKey } from "./mutation-keys.ts";

export type VarSource = "plain" | "ssm" | "secretsmanager" | "file";

// ---------- secret references ----------

export type SecretRef =
  | { kind: "ssm"; name: string } // parameter name ("/app/db-url") — ARNs are reduced to it
  | { kind: "secretsmanager"; secretId: string; jsonKey?: string; versionStage?: string; versionId?: string };

// valueFrom forms: SSM "name" or "arn:aws:ssm:r:a:parameter/name"; Secrets Manager
// "arn:aws:secretsmanager:r:a:secret:name-AbCdEf[:json-key[:version-stage[:version-id]]]".
export function parseSecretRef(valueFrom: string): SecretRef {
  const sm = /^(arn:aws[\w-]*:secretsmanager:[^:]+:\d+:secret:[^:]+)(?::([^:]*))?(?::([^:]*))?(?::([^:]*))?$/.exec(valueFrom);
  if (sm) return { kind: "secretsmanager", secretId: sm[1], jsonKey: sm[2] || undefined, versionStage: sm[3] || undefined, versionId: sm[4] || undefined };
  // A parameter ARN's path is "/" + the name without its leading "/": "parameter/FOO" is the non-hierarchical FOO,
  // "parameter/acme/api/URL" the hierarchical /acme/api/URL.
  const ssm = /^arn:aws[\w-]*:ssm:[^:]+:\d+:parameter\/(.*)$/.exec(valueFrom);
  if (!ssm) return { kind: "ssm", name: valueFrom };
  return { kind: "ssm", name: ssm[1].includes("/") ? `/${ssm[1]}` : ssm[1] };
}

export const refLabel = (r: SecretRef) =>
  r.kind === "ssm" ? r.name : `${r.secretId.split(":secret:")[1]?.replace(/-[A-Za-z0-9]{6}$/, "") ?? r.secretId}${r.jsonKey ? `#${r.jsonKey}` : ""}`;

// A secret whose value is a JSON object and a key inside it: read or update just that key.
export function jsonKeyValue(secretString: string, key: string): string {
  const o = JSON.parse(secretString) as Record<string, unknown>;
  const v = o[key];
  if (v === undefined) throw new Error(`key "${key}" not found in the secret`);
  return typeof v === "string" ? v : JSON.stringify(v);
}
export function withJsonKey(secretString: string, key: string, value: string): string {
  const o = JSON.parse(secretString) as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("the secret is not a JSON object");
  return JSON.stringify({ ...o, [key]: value });
}

// ---------- names and values ----------

export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_VALUE = 32_768; // well inside the task definition's 64 KiB limit for a handful of values

export function nameProblem(name: string): string | undefined {
  if (!NAME.test(name)) return `"${name}" isn't a valid variable name (letters, digits and _, not starting with a digit)`;
  if (/^ECS_|^AWS_EXECUTION_ENV$|^AWS_CONTAINER_/.test(name)) return `"${name}" is reserved by ECS`;
  return undefined;
}

// ---------- env files (KEY=VALUE, one per line) ----------

export type EnvLine = { kind: "var"; name: string; value: string; text: string } | { kind: "other"; text: string };

// Exactly what ECS (Docker's env-file rules) will inject: NAME=value per line, leading whitespace ignored, the value
// taken literally — quotes are part of it, nothing is interpolated. Anything else (comments, blanks, `export X=1`,
// which Docker rejects) is kept as an opaque line.
export function parseEnvFile(text: string): EnvLine[] {
  return text.split(/\r?\n/).map((line): EnvLine => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    return m ? { kind: "var", name: m[1], value: m[2], text: line } : { kind: "other", text: line };
  });
}

export const envFileVars = (lines: EnvLine[]) => lines.filter((l): l is Extract<EnvLine, { kind: "var" }> => l.kind === "var");

// Apply set/remove to an env file, keeping comments, blank lines, order and every untouched line byte for byte (only
// trailing blank lines are collapsed to one newline); new variables go at the end.
export function editEnvFile(text: string, set: Record<string, string>, remove: string[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"; // keep Windows line endings if the file has them
  const lines = parseEnvFile(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (l.kind === "other") out.push(l.text);
    else if (remove.includes(l.name)) continue;
    else {
      seen.add(l.name);
      out.push(Object.hasOwn(set, l.name) ? `${l.name}=${set[l.name]}` : l.text);
    }
  }
  const added = Object.keys(set).filter((k) => !seen.has(k));
  while (added.length && out.length && out[out.length - 1] === "") out.pop(); // keep a single trailing newline
  for (const k of added) out.push(`${k}=${set[k]}`);
  return `${out.join(eol).replace(/(\r?\n)+$/, "")}${eol}`;
}

// "Edit as .env" in the UI: text → ordered name/value pairs (last one wins), with problems reported per line.
export function parseDotenv(text: string): { vars: { name: string; value: string }[]; problems: string[] } {
  const problems: string[] = [];
  const vars = new Map<string, string>();
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith("#")) return;
    const l = parseEnvFile(line)[0];
    if (l.kind !== "var") problems.push(`line ${i + 1}: expected NAME=value`);
    else {
      const p = nameProblem(l.name);
      if (p) problems.push(`line ${i + 1}: ${p}`);
      else vars.set(l.name, l.value);
    }
  });
  return { vars: [...vars].map(([name, value]) => ({ name, value })), problems };
}

// ---------- plans ----------

export interface VarChanges {
  plain: { container: string; set: Record<string, string>; remove: string[] }[];
  secrets: { container: string; name: string; value: string }[]; // new value for an existing secret reference
  files: { container: string; file: string; set: Record<string, string>; remove: string[] }[];
}

export interface Summary {
  source: VarSource | "task-definition";
  where: string;
  added: string[];
  changed: string[];
  removed: string[];
}

// Names only — the plan the user confirms and the audit log records never contain values.
export function summarize(changes: VarChanges, current: { container: string; name: string; source: VarSource; file?: string }[]): Summary[] {
  const has = (container: string, name: string, source: VarSource) => current.some((v) => v.container === container && v.name === name && v.source === source);
  const out: Summary[] = [];
  for (const p of changes.plain) {
    const names = Object.keys(p.set);
    const s = { source: "plain" as const, where: p.container, added: names.filter((n) => !has(p.container, n, "plain")), changed: names.filter((n) => has(p.container, n, "plain")), removed: p.remove };
    if (s.added.length || s.changed.length || s.removed.length) out.push(s);
  }
  // A file's variables are the file's, whichever container lists it (a shared file's edits arrive combined).
  const inFile = (file: string, name: string) => current.some((v) => v.source === "file" && v.file === file && v.name === name);
  for (const f of changes.files) {
    const names = Object.keys(f.set);
    const s = { source: "file" as const, where: f.file, added: names.filter((n) => !inFile(f.file, n)), changed: names.filter((n) => inFile(f.file, n)), removed: f.remove };
    if (s.added.length || s.changed.length || s.removed.length) out.push(s);
  }
  // Label each secret by where it lives (SSM or Secrets Manager), from the current reference.
  const kindOf = (container: string, name: string): VarSource =>
    current.find((v) => v.container === container && v.name === name && (v.source === "ssm" || v.source === "secretsmanager"))?.source ?? "ssm";
  for (const kind of ["ssm", "secretsmanager"] as const) {
    const names = changes.secrets.filter((s) => kindOf(s.container, s.name) === kind).map((s) => s.name);
    if (names.length) out.push({ source: kind, where: kind === "ssm" ? "SSM parameters" : "Secrets Manager", added: [], changed: names, removed: [] });
  }
  return out;
}

// ECS rejects a name that appears twice in one container (across environment and secrets); files may repeat a name
// (the task definition wins), so only plain + secrets are checked.
export function duplicateNames(plain: { name: string }[], secrets: { name: string }[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const { name } of [...plain, ...secrets]) {
    if (seen.has(name)) dup.add(name);
    seen.add(name);
  }
  return [...dup];
}

// ---------- backing objects (REVIEW R02, R05) ----------

// Where a reference really lives, as the mutation coordinator's canonical key (src/lib/mutation-keys.ts): one SSM
// parameter, one secret (whatever JSON key, version or suffix a reference names) or one S3 object. Saves lock these
// keys, and two services whose references share a key share the value.
export type BackingKind = "ssm" | "secretsmanager" | "s3";
export interface Backing {
  key: string;
  kind: BackingKind;
  label: string; // parameter name, secret name or s3:// URL — never a value
}

// A secret reference named by ARN lives in the ARN's region (a task may read one from another region); a bare SSM
// parameter name lives in the task's region.
export function backingOfSecret(valueFrom: string, region: string): Backing {
  const ref = parseSecretRef(valueFrom);
  if (ref.kind === "ssm") return { key: canonicalKey({ ssm: { region, name: /^arn:/.test(valueFrom) ? valueFrom : ref.name } }), kind: "ssm", label: ref.name };
  return { key: canonicalKey({ secret: { region, id: ref.secretId } }), kind: "secretsmanager", label: refLabel({ kind: "secretsmanager", secretId: ref.secretId }) };
}

export function backingOfFile(s3Arn: string): Backing {
  return { key: canonicalKey({ arn: s3Arn }), kind: "s3", label: s3Arn.replace(/^arn:aws[\w-]*:s3:::/, "s3://") };
}

// ---------- shared references: the strongest consumer decides (F34 / REVIEW R02) ----------

// A service that reads a backing object, wherever it runs.
export interface Consumer {
  env: string;
  region: string;
  cluster: string;
  service: string;
  protected: boolean;
  self: boolean; // the console's own service (or possibly it: self-detection fails closed)
}

// What discovery could read: each live service's containers (undefined = its task definition couldn't be read), plus
// places nobody could look into (a region whose clusters didn't answer, an env whose services didn't).
export interface IndexInput {
  services: (Omit<Consumer, "self"> & { self: boolean; containers?: { secrets: { valueFrom: string }[]; files: string[] }[]; why?: string })[];
  unreadable: { what: string; protected: boolean | "unknown" }[];
}

export interface RefIndex {
  byKey: Map<string, Consumer[]>;
  // Why a protected (or self) consumer might be missing: then every shared-reference check fails closed (protected).
  // An unreadable service in an unprotected env that isn't the console can't raise anyone's protection, so it doesn't count.
  unknown: string[];
}

export function buildRefIndex(input: IndexInput): RefIndex {
  const byKey = new Map<string, Consumer[]>();
  const unknown = input.unreadable.filter((u) => u.protected !== false).map((u) => u.what);
  for (const s of input.services) {
    const c: Consumer = { env: s.env, region: s.region, cluster: s.cluster, service: s.service, protected: s.protected, self: s.self };
    if (!s.containers) {
      if (s.protected || s.self) unknown.push(`${s.env}/${s.service}${s.why ? `: ${s.why}` : ""}`);
      continue;
    }
    const keys = new Set<string>();
    for (const ctr of s.containers) {
      for (const x of ctr.secrets) keys.add(backingOfSecret(x.valueFrom, s.region).key);
      for (const f of ctr.files) keys.add(backingOfFile(f).key);
    }
    for (const k of keys) {
      const list = byKey.get(k) ?? [];
      if (!list.some((x) => x.env === c.env && x.service === c.service)) list.push(c);
      byKey.set(k, list);
    }
  }
  return { byKey, unknown };
}

export interface Sharing {
  others: Consumer[]; // every other service reading the same object
  protected: boolean; // a protected consumer reads it — or the index can't rule one out
  self: boolean; // the console's own service reads it
  unknown: boolean;
}

export function sharingOf(key: string, index: RefIndex, me: { env: string; service: string }): Sharing {
  const others = (index.byKey.get(key) ?? []).filter((c) => !(c.env === me.env && c.service === me.service));
  const unknown = index.unknown.length > 0;
  return { others, protected: unknown || others.some((c) => c.protected), self: others.some((c) => c.self), unknown };
}

// ---------- one write per backing object (REVIEW R05) ----------

export interface SecretEdit {
  container: string;
  name: string;
  value: string;
  valueFrom: string;
}

// SSM: one parameter, one value. Secrets Manager: the whole secret, or keys of its JSON document — written as one
// document. `names` is what the plan and the audit show.
export type SecretWrite =
  | { key: string; kind: "ssm"; valueFrom: string; value: string; names: string[]; label: string }
  | { key: string; kind: "secretsmanager"; secretId: string; whole?: string; jsonKeys: Record<string, string>; names: string[]; label: string };

export interface FileEdit {
  container: string;
  file: string;
  set: Record<string, string>;
  remove: string[];
}

export interface FileWrite {
  key: string;
  file: string;
  containers: string[];
  set: Record<string, string>;
  remove: string[];
  label: string;
}

// Edits that land on the same backing object are combined; ones that disagree (two values for one parameter or JSON
// key, a name set by one container and removed by another) are conflicts — the save is refused, nothing written.
export function groupEdits(secrets: SecretEdit[], files: FileEdit[], region: string): { secrets: SecretWrite[]; files: FileWrite[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const sw = new Map<string, SecretWrite>();
  for (const e of secrets) {
    const b = backingOfSecret(e.valueFrom, region);
    const ref = parseSecretRef(e.valueFrom);
    const prev = sw.get(b.key);
    const who = `${e.name} (${e.container})`;
    if (ref.kind === "ssm") {
      if (!prev) sw.set(b.key, { key: b.key, kind: "ssm", valueFrom: e.valueFrom, value: e.value, names: [who], label: b.label });
      else if (prev.kind === "ssm" && prev.value === e.value) prev.names.push(who);
      else conflicts.push(`${prev.names.join(", ")} and ${who} set SSM parameter ${b.label} to different values`);
      continue;
    }
    const w = prev?.kind === "secretsmanager" ? prev : { key: b.key, kind: "secretsmanager" as const, secretId: ref.secretId, jsonKeys: {} as Record<string, string>, names: [] as string[], label: b.label };
    if (!ref.jsonKey) {
      if (Object.keys(w.jsonKeys).length || (w.whole !== undefined && w.whole !== e.value)) {
        conflicts.push(`${who} replaces secret ${b.label} while ${w.names.join(", ")} change${w.names.length === 1 ? "s" : ""} it too`);
        continue;
      }
      w.whole = e.value;
    } else {
      if (w.whole !== undefined) {
        conflicts.push(`${who} changes key "${ref.jsonKey}" of secret ${b.label} while ${w.names.join(", ")} replace${w.names.length === 1 ? "s" : ""} the whole secret`);
        continue;
      }
      if (Object.hasOwn(w.jsonKeys, ref.jsonKey) && w.jsonKeys[ref.jsonKey] !== e.value) {
        conflicts.push(`${w.names.join(", ")} and ${who} set key "${ref.jsonKey}" of secret ${b.label} to different values`);
        continue;
      }
      w.jsonKeys[ref.jsonKey] = e.value;
    }
    w.names.push(who);
    sw.set(b.key, w);
  }

  const fw = new Map<string, FileWrite>();
  for (const e of files) {
    const b = backingOfFile(e.file);
    const w = fw.get(b.key) ?? { key: b.key, file: e.file, containers: [], set: {}, remove: [], label: b.label };
    const clash: string[] = [];
    for (const [n, v] of Object.entries(e.set)) {
      if (w.remove.includes(n)) clash.push(`${b.label}: ${n} is removed by ${w.containers.join(", ")} and set by ${e.container}`);
      else if (Object.hasOwn(w.set, n) && w.set[n] !== v) clash.push(`${b.label}: ${w.containers.join(", ")} and ${e.container} set ${n} to different values`);
    }
    for (const n of e.remove) if (Object.hasOwn(w.set, n)) clash.push(`${b.label}: ${n} is set by ${w.containers.join(", ")} and removed by ${e.container}`);
    if (clash.length) {
      conflicts.push(...clash);
      continue;
    }
    Object.assign(w.set, e.set);
    for (const n of e.remove) if (!w.remove.includes(n)) w.remove.push(n);
    w.containers.push(e.container);
    fw.set(b.key, w);
  }
  return { secrets: [...sw.values()], files: [...fw.values()], conflicts };
}

// The new document of a JSON secret after its key edits. Keys only: the rest of the document stays as it is.
export function applyJsonKeys(secretString: string, keys: Record<string, string>): string {
  let doc = secretString;
  for (const [k, v] of Object.entries(keys)) doc = withJsonKey(doc, k, v);
  return doc;
}
