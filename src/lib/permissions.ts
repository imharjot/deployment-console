// IAM policy documents built from what each provider declares (read, sensitive, write, implicit — see
// src/lib/server/providers/types.ts). One implementation for scripts/iam-policy.mjs (rewrites the Inventory*
// statements of infra/iam-policy*.json), GET /api/permissions/policy (Settings → AWS permissions) and the tests. Pure.
//
// Rules:
// - Hand-written statements (any Sid not starting with "Inventory") stay as they are, first.
// - One statement per provider and class: Inventory<Provider>Read (both policies), …Sensitive and …Write (full only).
// - An action a hand-written statement already grants — anywhere, scoped or under a condition — isn't generated
//   again: a hand-written scope (one bucket, a console:power tag) is a deliberate limit, and a generated "*" beside it
//   would silently cancel it (IAM unions allows). Across providers, the first (by id) keeps it.
// - Providers sorted by id, actions sorted. Cloudflare token scopes ("cloudflare:…") aren't IAM: listed apart.
// - implicit (authorised through another call): Describe/List/Get go with Read, the rest with Write. iam:* and kms:*
//   are never generated: they need a hand-written statement with a condition (iam:PassedToService, kms:ViaService).
import { KIND_INFO, type ResourceKind } from "./inventory/types.ts";

export type PolicyMode = "read" | "full";
export type ActionClass = "read" | "sensitive" | "write";

export interface Statement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}
export interface PolicyDocument {
  Version: "2012-10-17";
  Statement: Statement[];
}

// What a provider declares (structural, so the script and tests need no server imports).
export interface Declaration {
  id: string;
  label: string;
  global?: boolean;
  scope?: "regional" | "global" | "home"; // where it runs (src/lib/server/providers/types.ts)
  homeRegion?: string; // a global provider's region (IAM us-east-1, Global Accelerator us-west-2)
  kinds?: ResourceKind[]; // what it discovers
  covers?: string[]; // Resource Explorer types it lists (checked against src/lib/inventory/aws-resource-types.json)
  read: string[];
  sensitive?: string[];
  write?: string[];
  implicit?: string[];
}

// Per provider, for Settings → AWS permissions (GET /api/permissions).
export interface ProviderPermissions {
  id: string;
  label: string;
  global: boolean;
  read: string[]; // IAM only; Cloudflare scopes are in `scopes`
  sensitive: string[];
  write: string[];
  implicit: string[];
  scopes: string[]; // Cloudflare API token scopes for discovery, without the "cloudflare:" prefix ("Zone:Read")
  writeScopes: string[]; // … and for its actions ("Cache Purge")
  enabled: { ok: true } | { ok: false; why: string };
  planned?: true; // registered but not built yet (enabled.why is NOT_IMPLEMENTED): nothing to set up, needs no permissions
  kinds: ResourceKind[]; // what it discovers
  scope: "regional" | "global" | "home";
  homeRegion?: string;
  covers: string[];
  actions: { id: string; title: string; kind: string; risk: "change" | "danger"; perm: string }[];
}
export interface PermissionsCatalog {
  providers: ProviderPermissions[];
}

// GET /api/permissions/policy
export interface PolicyResponse {
  mode: PolicyMode;
  providers: string[]; // ids included
  unknown: string[]; // requested ids no provider has
  policy: PolicyDocument;
  skipped: Skipped[];
}
export interface Skipped {
  provider: string;
  action: string;
  why: string;
}

export const GENERATED_PREFIX = "Inventory";
export const MANAGED_POLICY_LIMIT = 6144; // characters, whitespace not counted (AWS managed policy quota)
// The full policy's F34 denies name the console's own configuration: its SSM parameter path (without the leading
// slash: "deployment-console" for /deployment-console/…), its Secrets Manager name prefix and its own env file's key
// in ENV_FILES_BUCKET.
export const PLACEHOLDERS = ["ACCOUNT_ID", "REGION", "CONSOLE_CLUSTER", "CONSOLE_SERVICE", "ENV_FILES_BUCKET", "CONSOLE_PARAM_PREFIX", "CONSOLE_SECRET_PREFIX", "CONSOLE_ENV_FILE"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const IAM_ACTION = /^[a-z0-9-]+:[A-Za-z0-9]+$/;
export const isIamAction = (a: string) => IAM_ACTION.test(a) && !a.startsWith("cloudflare:");
export const isCloudflareScope = (a: string) => a.startsWith("cloudflare:");
export const isGenerated = (s: Statement) => typeof s.Sid === "string" && s.Sid.startsWith(GENERATED_PREFIX);
export const baseStatements = (doc: PolicyDocument) => doc.Statement.filter((s) => !isGenerated(s));
const list = (v: string | string[] | undefined) => (v === undefined ? [] : [v].flat());
const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

// "api-gateway" → "ApiGateway": Sids allow only [A-Za-z0-9].
export const sidOf = (id: string) =>
  id.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const CLASS_SID: Record<ActionClass, string> = { read: "Read", sensitive: "Sensitive", write: "Write" };

export function implicitClass(action: string): ActionClass {
  if (action === "kms:Decrypt") return "sensitive";
  return /^[a-z0-9-]+:(Describe|List|Get)/.test(action) ? "read" : "write";
}
// Implicit actions only a hand-written statement (with a condition) may grant.
export const handWrittenOnly = (action: string) => /^(iam|kms):/.test(action);

const grantedAnywhere = (statements: Statement[]) =>
  new Set(statements.filter((s) => s.Effect === "Allow").flatMap((s) => list(s.Action)));

// The actions of one class a provider needs (IAM only), before deduplication.
export function actionsOf(d: Declaration, cls: ActionClass): string[] {
  const own = cls === "read" ? d.read : cls === "sensitive" ? d.sensitive ?? [] : d.write ?? [];
  const implicit = (d.implicit ?? []).filter((a) => implicitClass(a) === cls && !handWrittenOnly(a));
  return uniqSorted([...own, ...implicit].filter(isIamAction));
}

export const classesFor = (mode: PolicyMode): ActionClass[] => (mode === "read" ? ["read"] : ["read", "sensitive", "write"]);

// The generated statements for `decls`, deduplicated against the hand-written `base`.
export function inventoryStatements(decls: Declaration[], mode: PolicyMode, base: Statement[] = []): { statements: Statement[]; skipped: Skipped[] } {
  const anywhere = grantedAnywhere(base);
  const seen = new Set(anywhere);
  const statements: Statement[] = [];
  const skipped: Skipped[] = [];
  const sids = new Set<string>();
  for (const d of [...decls].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const a of d.implicit ?? []) {
      if (handWrittenOnly(a) && !anywhere.has(a) && classesFor(mode).includes(implicitClass(a)))
        skipped.push({ provider: d.id, action: a, why: "iam:* and kms:* need a hand-written statement with a condition (iam:PassedToService, kms:ViaService) in infra/iam-policy.json" });
    }
    for (const cls of classesFor(mode)) {
      const actions = actionsOf(d, cls).filter((a) => {
        if (seen.has(a)) return false;
        seen.add(a);
        return true;
      });
      if (!actions.length) continue;
      const sid = `${GENERATED_PREFIX}${sidOf(d.id)}${CLASS_SID[cls]}`;
      if (sids.has(sid)) throw new Error(`two providers produce the Sid ${sid}: give them distinct ids`);
      sids.add(sid);
      statements.push({ Sid: sid, Effect: "Allow", Action: actions, Resource: "*" });
    }
  }
  return { statements, skipped };
}

// Hand-written statements first, then the generated ones.
export function buildPolicy(decls: Declaration[], mode: PolicyMode, base: Statement[] = []): { policy: PolicyDocument; skipped: Skipped[] } {
  const clean = base.filter((s) => !isGenerated(s));
  const { statements, skipped } = inventoryStatements(decls, mode, clean);
  return { policy: { Version: "2012-10-17", Statement: [...clean, ...statements] }, skipped };
}

// Cloudflare API token scopes, deduplicated: which providers need each, and whether only for actions (write).
export function cloudflareScopes(decls: Declaration[]): { scope: string; providers: string[]; write: boolean }[] {
  const by = new Map<string, { providers: Set<string>; write: boolean }>();
  for (const d of decls) {
    const add = (list: string[] | undefined, write: boolean) => {
      for (const a of (list ?? []).filter(isCloudflareScope)) {
        const scope = a.slice("cloudflare:".length);
        const e = by.get(scope) ?? { providers: new Set<string>(), write: true };
        e.providers.add(d.id);
        e.write &&= write;
        by.set(scope, e);
      }
    };
    add(d.read, false);
    add(d.sensitive, false);
    add(d.write, true);
    add(d.implicit, false);
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([scope, e]) => ({ scope, providers: [...e.providers].sort(), write: e.write }));
}

// What IAM counts against the managed-policy quota (whitespace outside strings isn't counted).
export const policySize = (doc: PolicyDocument) => JSON.stringify(doc).length;

// Splits a document into parts that each fit `limit`, in statement order; a statement too big on its own is split
// by actions (Sid, Sid2, Sid3…). Attach every part: denies stay in the part they fall in.
export function splitPolicy(doc: PolicyDocument, limit = MANAGED_POLICY_LIMIT): PolicyDocument[] {
  const fits = (sts: Statement[]) => policySize({ Version: doc.Version, Statement: sts }) <= limit;
  const pieces = (s: Statement): Statement[] => {
    const actions = list(s.Action);
    if (fits([s]) || actions.length < 2) return [s];
    const out: Statement[] = [];
    let cur: string[] = [];
    const make = (acts: string[], i: number): Statement => ({ ...s, ...(s.Sid ? { Sid: i ? `${s.Sid}${i + 1}` : s.Sid } : {}), Action: acts });
    for (const a of actions) {
      if (cur.length && !fits([make([...cur, a], out.length)])) {
        out.push(make(cur, out.length));
        cur = [];
      }
      cur.push(a);
    }
    if (cur.length) out.push(make(cur, out.length));
    return out;
  };
  const parts: Statement[][] = [];
  let cur: Statement[] = [];
  for (const s of doc.Statement) {
    for (const p of pieces(s)) {
      if (cur.length && !fits([...cur, p])) {
        parts.push(cur);
        cur = [];
      }
      cur.push(p);
    }
  }
  if (cur.length || !parts.length) parts.push(cur);
  return parts.map((Statement) => ({ Version: doc.Version, Statement }));
}

// Placeholders left in Resource / Condition values (the hand-written statements of the full policy use them).
export function placeholdersIn(doc: PolicyDocument): Placeholder[] {
  const text = JSON.stringify(doc.Statement.map((s) => [s.Resource, s.Condition]));
  return PLACEHOLDERS.filter((p) => new RegExp(`(^|[^A-Z_])${p}([^A-Z_]|$)`).test(text));
}

// Valid values only, so nothing typed can change the document's structure or the shell snippet around it.
const VALID: Record<Placeholder, RegExp> = {
  ACCOUNT_ID: /^\d{12}$/,
  REGION: /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/,
  CONSOLE_CLUSTER: /^[A-Za-z0-9_-]{1,255}$/,
  CONSOLE_SERVICE: /^[A-Za-z0-9_-]{1,255}$/,
  ENV_FILES_BUCKET: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  CONSOLE_PARAM_PREFIX: /^(?=.{1,1000}$)[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/, // a path, no leading or trailing slash
  CONSOLE_SECRET_PREFIX: /^[A-Za-z0-9/_+=.@-]{1,500}$/,
  CONSOLE_ENV_FILE: /^[A-Za-z0-9_.()+=-][A-Za-z0-9_.()+=*/-]{0,1023}$/, // an object key ("*" matches several)
};
export const validPlaceholder = (p: Placeholder, v: string) => VALID[p].test(v);
export const validRoleName = (v: string) => /^[\w+=,.@-]{1,64}$/.test(v);

// Replaces whole-word placeholders in every Resource and Condition value (Sids and actions are never touched).
function replacing(doc: PolicyDocument, values: Partial<Record<Placeholder, string>>): PolicyDocument {
  const use = PLACEHOLDERS.filter((p) => values[p] !== undefined);
  const fill = (v: string) => use.reduce((acc, p) => acc.replace(new RegExp(`(^|[^A-Z_])${p}(?=[^A-Z_]|$)`, "g"), (_, pre: string) => pre + values[p]), v);
  const deep = (v: unknown): unknown => (typeof v === "string" ? fill(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  return {
    Version: doc.Version,
    Statement: doc.Statement.map((s) => ({ ...s, ...(s.Resource ? { Resource: deep(s.Resource) as string | string[] } : {}), ...(s.Condition ? { Condition: deep(s.Condition) as Statement["Condition"] } : {}) })),
  };
}

export function fillPlaceholders(doc: PolicyDocument, values: Partial<Record<Placeholder, string>>): PolicyDocument {
  const valid = Object.fromEntries(PLACEHOLDERS.filter((p) => values[p] && validPlaceholder(p, values[p]!)).map((p) => [p, values[p]!]));
  return Object.keys(valid).length ? replacing(doc, valid) : doc;
}

// A console that reads more than one region (CONSOLE_REGIONS / inventory.regions) needs the region-scoped statements
// in each of them: REGION becomes "*" everywhere — the kms:ViaService values (ssm.*.amazonaws.com, …) and the ARNs of
// the console's own statements (ServiceActions, RunInstances…), which stay scoped by account, name and tag. One
// region, or none known: unchanged (fill REGION as usual).
export function forRegions(doc: PolicyDocument, regions: readonly string[]): PolicyDocument {
  return new Set(regions).size > 1 ? replacing(doc, { REGION: "*" }) : doc;
}

// The console's own principal for SimulateOwnPermissions (iam:SimulatePrincipalPolicy). The shipped statement names
// the ECS task role of infra/task-definition.json; a console run locally as an IAM user (or another role) simulates
// that identity instead, and the simulation is refused unless the statement names it. Invalid ARNs change nothing.
export const SIMULATE_SID = "SimulateOwnPermissions";
const PRINCIPAL_ARN = /^arn:aws(-[a-z]+)*:iam::(\d{12}|ACCOUNT_ID):(role|user)\/([\w+=,.@-]+\/)*[\w+=,.@-]{1,128}$/;
export const validPrincipalArn = (arn: string) => PRINCIPAL_ARN.test(arn);
export function withPrincipal(doc: PolicyDocument, arn: string): PolicyDocument {
  if (!validPrincipalArn(arn)) return doc;
  return { Version: doc.Version, Statement: doc.Statement.map((s) => (s.Sid === SIMULATE_SID && s.Effect === "Allow" ? { ...s, Resource: arn } : s)) };
}

export const policyName = (mode: PolicyMode, part = 0, parts = 1) =>
  `${mode === "read" ? "deployment-console-readonly" : "deployment-console"}${parts > 1 ? `-${part + 1}` : ""}`;

// Copy-paste shell: write each part, create it (or publish a new version), attach it to the console's role.
export function cliScript(o: { parts: PolicyDocument[]; mode: PolicyMode; role?: string; accountId?: string }): string {
  const role = o.role && validRoleName(o.role) ? o.role : "ROLE_NAME";
  const account = o.accountId && /^\d{12}$/.test(o.accountId) ? o.accountId : "$(aws sts get-caller-identity --query Account --output text)";
  const lines = [
    "# Run with credentials allowed to manage IAM (not the console's own).",
    `ROLE=${role}   # the role the console runs as: its ECS task role, or the role behind its AWS profile`,
    `ACCOUNT_ID=${account}`,
  ];
  o.parts.forEach((doc, i) => {
    const name = policyName(o.mode, i, o.parts.length);
    lines.push(
      "",
      `cat > ${name}.json <<'POLICY'`,
      JSON.stringify(doc, null, 2),
      "POLICY",
      `aws iam create-policy --policy-name ${name} --policy-document file://${name}.json`,
      `aws iam attach-role-policy --role-name "$ROLE" --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/${name}"`,
      `# Already exists? Publish this as its new version instead (IAM keeps 5; delete an old one first if full):`,
      `#   aws iam create-policy-version --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/${name}" --policy-document file://${name}.json --set-as-default`,
    );
  });
  return lines.join("\n") + "\n";
}

// What a provider discovers, for the page, when it doesn't declare `kinds`: the kinds its actions act on, plus kinds
// whose service (KIND_INFO) is named like the provider's id or label ("ecs" → ECS services; "Load balancers" → load
// balancer) — except kinds KIND_INFO assigns to another provider (RDS clusters belong to rds-cluster, not rds).
export function kindsOf(id: string, label: string, actionKinds: string[] = []): ResourceKind[] {
  const all = Object.keys(KIND_INFO) as ResourceKind[];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = [norm(id), norm(label)];
  return all.filter((k) => {
    if (actionKinds.includes(k)) return true;
    const owner = KIND_INFO[k].provider;
    if (owner) return owner === id;
    return k === id || names.includes(norm(KIND_INFO[k].service)) || `${norm(KIND_INFO[k].label)}s` === norm(label);
  });
}

const scopeOf = (d: Pick<Declaration, "scope" | "global">) => d.scope ?? (d.global ? "global" : "regional");

// What a registered provider that isn't built yet answers from enabled() (src/lib/server/providers/*.ts stubs). The
// page shows those as coming, not as something the reader has to set up.
export const NOT_IMPLEMENTED = "not implemented yet";

// A Provider (or anything shaped like one) → what Settings → AWS permissions shows.
export function describeProvider(p: Declaration & {
  enabled?(): { ok: true } | { ok: false; why: string };
  actions?: { id: string; title: string; kind: string; risk: "change" | "danger"; perm: string }[];
}): ProviderPermissions {
  const scopes = cloudflareScopes([p]);
  let enabled: ProviderPermissions["enabled"] = { ok: true };
  try {
    enabled = p.enabled?.() ?? { ok: true };
  } catch (e) {
    enabled = { ok: false, why: (e as Error).message };
  }
  const actions = (p.actions ?? []).map((a) => ({ id: a.id, title: a.title, kind: a.kind, risk: a.risk, perm: a.perm }));
  return {
    id: p.id,
    label: p.label,
    global: !!p.global,
    read: uniqSorted(p.read.filter(isIamAction)),
    sensitive: uniqSorted((p.sensitive ?? []).filter(isIamAction)),
    write: uniqSorted((p.write ?? []).filter(isIamAction)),
    implicit: uniqSorted((p.implicit ?? []).filter(isIamAction)),
    scopes: scopes.filter((x) => !x.write).map((x) => x.scope),
    writeScopes: scopes.filter((x) => x.write).map((x) => x.scope),
    enabled,
    ...(!enabled.ok && enabled.why === NOT_IMPLEMENTED ? { planned: true as const } : {}),
    kinds: p.kinds?.length ? [...new Set(p.kinds)] : kindsOf(p.id, p.label, actions.map((a) => a.kind)),
    scope: scopeOf(p),
    ...(p.homeRegion ? { homeRegion: p.homeRegion } : {}),
    covers: uniqSorted(p.covers ?? []),
    actions,
  };
}

// Just the declaration (what the script dumps and the policy is built from).
export const declarationOf = (p: Declaration): Declaration => ({
  id: p.id,
  label: p.label,
  ...(p.global ? { global: true } : {}),
  ...(p.scope ? { scope: p.scope } : {}),
  ...(p.homeRegion ? { homeRegion: p.homeRegion } : {}),
  ...(p.kinds?.length ? { kinds: [...p.kinds] } : {}),
  ...(p.covers?.length ? { covers: [...p.covers] } : {}),
  read: [...p.read],
  ...(p.sensitive?.length ? { sensitive: [...p.sensitive] } : {}),
  ...(p.write?.length ? { write: [...p.write] } : {}),
  ...(p.implicit?.length ? { implicit: [...p.implicit] } : {}),
});

// Markdown for the generated section of docs/services.md (kept by scripts/iam-policy.mjs, checked by the IAM test).
export const DOCS_BEGIN = "<!-- generated by npm run iam:policy: begin -->";
export const DOCS_END = "<!-- generated by npm run iam:policy: end -->";
export function docsSection(decls: Declaration[]): string {
  const code = (xs: string[]) => (xs.length ? xs.map((a) => `\`${a}\``).join(", ") : "—");
  const rows = [...decls].sort((a, b) => a.id.localeCompare(b.id)).map((d) => {
    const p = describeProvider(d);
    const reads = uniqSorted([...p.read, ...p.implicit.filter((a) => implicitClass(a) === "read")]);
    const sens = uniqSorted([...p.sensitive, ...p.implicit.filter((a) => implicitClass(a) === "sensitive")]);
    const writes = uniqSorted([...p.write, ...p.implicit.filter((a) => implicitClass(a) === "write")]);
    const token = (xs: string[]) => (xs.length ? `Cloudflare token: ${xs.map((s) => `\`${s}\``).join(", ")}` : "");
    const cell = (iam: string[], scopes: string[]) => (iam.length || !scopes.length ? code(iam) : "") + (iam.length && scopes.length ? "; " : "") + token(scopes);
    return `| ${p.label} (\`${p.id}\`) | ${cell(reads, p.scopes)} | ${code(sens)} | ${cell(writes, p.writeScopes)} |`;
  });
  return [
    DOCS_BEGIN,
    "",
    rows.length
      ? ["| Provider | Discovery (both policies) | Data reads (full policy only) | Actions (full policy only) |", "|---|---|---|---|", ...rows].join("\n")
      : "_No providers are registered yet._",
    "",
    DOCS_END,
  ].join("\n");
}
export function withDocsSection(md: string, decls: Declaration[]): string {
  const a = md.indexOf(DOCS_BEGIN), b = md.indexOf(DOCS_END);
  if (a < 0 || b < a) throw new Error(`docs/services.md needs the markers ${DOCS_BEGIN} … ${DOCS_END}`);
  return md.slice(0, a) + docsSection(decls) + md.slice(b + DOCS_END.length);
}
