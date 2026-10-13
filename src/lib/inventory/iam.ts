// IAM roles, pure part: GetAccountAuthorizationDetails role entries (real or simulated) → Resources (audit §6 A.2 #4).
// One paged call returns every role with its trust policy, tags, last use, instance profiles and policy names, so the
// provider never calls GetRole per role (CC-9) and detail() renders the cached entry without another call.
// - Roles under /aws-service-role/ and /aws-reserved/ are hidden (listed in the table, never drawn) but resolvable.
// - Aliases: role name, RoleId, and the instance profiles' ARNs and names, so an EC2 IamInstanceProfile.Arn resolves.
// - The trust policy (URL-encoded JSON in the API) is decoded first: Principal "*" with no condition is an error,
//   another account without an sts:ExternalId condition a warning. Condition values of external ids are never shown.
// - Policies are recorded by NAME only: slimRole() drops inline policy documents before anything is cached.
// - facts.neverUsed: no last-used date and created before the idle window (propagate R7 marks it idle "never used").
// No AWS calls and no `server-only`, so node:test runs it (iam.test.ts).
import { arnOf } from "./arn.ts";
import { awsTime, clip, fmtSeconds, fmtTime, plural, props, tagsOf } from "./serverless-common.ts";
import type { Facts, Health, ProviderResult, Resource, ResourceDetail } from "./types.ts";

const DAY = 86_400_000;

// What GetAccountAuthorizationDetails returns per role (RoleDetail), the parts the map uses.
export interface RawRole {
  Path?: string;
  RoleName?: string;
  RoleId?: string;
  Arn?: string;
  CreateDate?: Date | string;
  AssumeRolePolicyDocument?: string | Record<string, unknown>; // URL-encoded JSON from the API; the CLI decodes it
  Description?: string;
  MaxSessionDuration?: number;
  PermissionsBoundary?: { PermissionsBoundaryArn?: string; PermissionsBoundaryType?: string };
  Tags?: { Key?: string; Value?: string }[];
  RoleLastUsed?: { LastUsedDate?: Date | string; Region?: string };
  InstanceProfileList?: { InstanceProfileName?: string; Arn?: string; Path?: string; Roles?: unknown[] }[];
  AttachedManagedPolicies?: { PolicyName?: string; PolicyArn?: string }[];
  RolePolicyList?: { PolicyName?: string; PolicyDocument?: string }[]; // documents are dropped by slimRole()
}

export const HIDDEN_ROLE_PATHS = ["/aws-service-role/", "/aws-reserved/"];
export const isHiddenRole = (path: string | undefined) => HIDDEN_ROLE_PATHS.some((p) => (path ?? "").startsWith(p));

// The role without anything the map must not keep: inline policy documents (names only), and the nested role copies
// inside each instance profile. This is what the provider caches for detail().
export function slimRole(r: RawRole): RawRole {
  const { RolePolicyList, InstanceProfileList, ...rest } = r;
  return {
    ...rest,
    ...(RolePolicyList ? { RolePolicyList: RolePolicyList.map((p) => ({ PolicyName: p.PolicyName })) } : {}),
    ...(InstanceProfileList ? { InstanceProfileList: InstanceProfileList.map((p) => ({ InstanceProfileName: p.InstanceProfileName, Arn: p.Arn, Path: p.Path })) } : {}),
  };
}

// ---------- trust policy ----------

type Statement = { Effect?: string; Principal?: unknown; NotPrincipal?: unknown; Action?: unknown; Condition?: Record<string, Record<string, unknown>> };

// The trust policy as an object: the API returns it URL-encoded ("%7B%22Version%22…"), the CLI already decoded.
export function decodePolicy(doc: string | Record<string, unknown> | undefined): { Statement?: Statement | Statement[] } | undefined {
  if (!doc) return undefined;
  if (typeof doc === "object") return doc as { Statement?: Statement | Statement[] };
  for (const text of [doc, safeDecode(doc)]) {
    if (text === undefined) continue;
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object") return v as { Statement?: Statement | Statement[] };
    } catch {
      // try the decoded form next
    }
  }
  return undefined;
}

function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

export interface TrustEntry {
  type: "AWS" | "Service" | "Federated" | "CanonicalUser" | "Everyone";
  principal: string;
  account?: string; // for AWS principals: the account the principal lives in
  conditions: string[]; // "StringEquals sts:ExternalId = (set)", "StringLike token.actions.githubusercontent.com:sub = repo:acme/*"
  negated?: boolean; // NotPrincipal: everyone except this principal
}

export interface Trust {
  entries: TrustEntry[];
  error?: string; // Principal "*" with no condition
  warnings: string[]; // other accounts without sts:ExternalId
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);
const ACCOUNT_OF = /^arn:aws[\w-]*:(?:iam|sts)::(\d{12}):/;
const accountOf = (principal: string) => (/^\d{12}$/.test(principal) ? principal : ACCOUNT_OF.exec(principal)?.[1]);
const isExternalId = (key: string) => key.toLowerCase() === "sts:externalid";

function conditionsOf(c: Statement["Condition"]): string[] {
  const out: string[] = [];
  for (const [op, keys] of Object.entries(c ?? {})) {
    if (!keys || typeof keys !== "object") continue;
    for (const [key, value] of Object.entries(keys)) out.push(`${op} ${key} = ${isExternalId(key) ? "(set)" : clip(list(value).join(", ") || String(value), 120)}`);
  }
  return out;
}

const hasExternalId = (c: Statement["Condition"]) => Object.values(c ?? {}).some((keys) => keys && typeof keys === "object" && Object.keys(keys).some(isExternalId));

// Who may assume the role, and what is wrong with that. `account`: the role's own account (from its ARN).
export function trustOf(doc: RawRole["AssumeRolePolicyDocument"], account: string | undefined): Trust | undefined {
  const policy = decodePolicy(doc);
  if (!policy) return undefined;
  const statements = Array.isArray(policy.Statement) ? policy.Statement : policy.Statement ? [policy.Statement] : [];
  const trust: Trust = { entries: [], warnings: [] };
  for (const s of statements) {
    if (!s || typeof s !== "object" || String(s.Effect ?? "").toLowerCase() !== "allow") continue;
    const conditions = conditionsOf(s.Condition);
    const conditional = conditions.length > 0;
    const negated = s.Principal === undefined && s.NotPrincipal !== undefined;
    const principals = negated ? s.NotPrincipal : s.Principal;
    const add = (e: Omit<TrustEntry, "conditions">) => trust.entries.push({ ...e, conditions, ...(negated ? { negated: true } : {}) });
    // "Principal": "*" and {"AWS": "*"} let anyone in; Allow with NotPrincipal lets in everyone except the listed ones.
    const everyone = principals === "*" || (principals && typeof principals === "object" && list((principals as Record<string, unknown>).AWS).includes("*"));
    if (everyone || negated) {
      add({ type: "Everyone", principal: negated ? `everyone except ${clip(JSON.stringify(principals), 80)}` : "*" });
      if (!conditional) trust.error ??= negated ? "trust policy allows everyone except the NotPrincipal list, with no condition" : "anyone can assume it: the trust policy allows Principal * with no condition";
    }
    if (negated || !principals || typeof principals !== "object") continue; // NotPrincipal lists exclusions, not principals
    for (const [type, value] of Object.entries(principals as Record<string, unknown>)) {
      for (const p of list(value)) {
        if (p === "*") continue;
        if (type === "AWS") {
          const acct = accountOf(p);
          add({ type: "AWS", principal: p, ...(acct ? { account: acct } : {}) });
          if (acct && account && acct !== account && !hasExternalId(s.Condition)) {
            const w = `account ${acct} can assume it without an external id (sts:ExternalId)`;
            if (!trust.warnings.includes(w)) trust.warnings.push(w);
          }
        } else if (type === "Service" || type === "Federated" || type === "CanonicalUser") add({ type, principal: p });
      }
    }
  }
  return trust;
}

// One short line for the props: "ecs-tasks.amazonaws.com", "account 210987654321", "token.actions.githubusercontent.com (OIDC)".
function trustLine(t: Trust, own: string | undefined): string {
  const parts = t.entries.map((e) => {
    if (e.type === "Everyone") return e.principal === "*" ? "anyone (*)" : e.principal;
    if (e.type === "AWS") return e.account && e.account !== own ? `account ${e.account}` : e.principal.replace(/^arn:aws[\w-]*:iam::\d{12}:/, "");
    if (e.type === "Federated") return /oidc-provider\//.test(e.principal) ? `${e.principal.split("oidc-provider/").pop()} (OIDC)` : /saml-provider\//.test(e.principal) ? `${e.principal.split("saml-provider/").pop()} (SAML)` : e.principal;
    return e.principal;
  });
  return clip([...new Set(parts)].join(", "), 160);
}

// ---------- resources ----------

const nameFromArn = (arn: string | undefined) => arn?.split("/").pop() ?? "";
const roleAccount = (r: RawRole) => ACCOUNT_OF.exec(r.Arn ?? "")?.[1];

export function roleKey(r: RawRole, account?: string): string | undefined {
  if (r.Arn) return r.Arn;
  const acct = account ?? "";
  return r.RoleName && acct ? arnOf.iamRole(acct, r.RoleName, r.Path ?? "/") : undefined;
}

const policyNames = (r: RawRole) => [
  ...(r.AttachedManagedPolicies ?? []).map((p) => p.PolicyName ?? nameFromArn(p.PolicyArn)).filter(Boolean),
  ...(r.RolePolicyList ?? []).map((p) => (p.PolicyName ? `${p.PolicyName} (inline)` : "")).filter(Boolean),
];

export function iamConsoleUrl(name: string) {
  return `https://console.aws.amazon.com/iam/home#/roles/details/${encodeURIComponent(name)}`;
}

// `idleDays`: the idle window (console.config.json inventory.idleDays) — a role created before it and never used is
// facts.neverUsed. `account`: the console's account, for roles without an ARN (never in practice).
export function iamResult(roles: RawRole[], o: { now: number; idleDays: number; account?: string }): ProviderResult {
  const resources: Resource[] = [];
  for (const raw of roles) {
    const key = roleKey(raw, o.account);
    if (!key || !raw.RoleName) continue;
    const own = roleAccount(raw) ?? o.account;
    const hidden = isHiddenRole(raw.Path);
    const trust = trustOf(raw.AssumeRolePolicyDocument, own);
    const lastUsed = awsTime(raw.RoleLastUsed?.LastUsedDate);
    const created = awsTime(raw.CreateDate);
    let health: Health = "ok";
    let healthReason: string | undefined;
    if (!trust) [health, healthReason] = ["unknown", "trust policy not readable"];
    else if (trust.error) [health, healthReason] = ["error", trust.error];
    else if (trust.warnings.length) [health, healthReason] = ["warning", trust.warnings.join("; ")];
    const facts: Facts = {};
    if (!hidden && lastUsed === undefined && created !== undefined && created < o.now - o.idleDays * DAY) facts.neverUsed = true;
    const profiles = (raw.InstanceProfileList ?? []).filter((p) => p.InstanceProfileName || p.Arn);
    const policies = policyNames(raw);
    resources.push({
      key,
      kind: "iam-role",
      provider: "iam",
      name: raw.RoleName,
      region: "global",
      ...tagsOf(raw.Tags ?? []), // GetAccountAuthorizationDetails returns every role's tags ([] when none)
      health,
      ...(healthReason ? { healthReason } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(Object.keys(facts).length ? { facts } : {}),
      props: props([
        { label: "Trusted by", value: trust ? trustLine(trust, own) || "nobody" : undefined },
        { label: "Policies", value: policies.length ? clip(policies.join(", "), 200) : "none" },
        { label: "Permissions boundary", value: raw.PermissionsBoundary?.PermissionsBoundaryArn ? nameFromArn(raw.PermissionsBoundary.PermissionsBoundaryArn) : undefined },
        { label: "Last used", value: lastUsed !== undefined ? `${fmtTime(lastUsed)}${raw.RoleLastUsed?.Region ? ` in ${raw.RoleLastUsed.Region}` : ""}` : "never (IAM tracks the last 400 days)" },
        { label: "Instance profiles", value: profiles.length ? clip(profiles.map((p) => p.InstanceProfileName ?? nameFromArn(p.Arn)).join(", "), 120) : undefined },
        { label: "Max session", value: raw.MaxSessionDuration ? fmtSeconds(raw.MaxSessionDuration) : undefined },
        { label: "Path", value: raw.Path && raw.Path !== "/" ? raw.Path : undefined },
        { label: "Description", value: raw.Description ? clip(raw.Description, 200) : undefined },
        { label: "Created", value: created !== undefined ? fmtTime(created) : undefined },
      ]),
      aliases: [...new Set([raw.RoleName, raw.RoleId, ...profiles.flatMap((p) => [p.Arn, p.InstanceProfileName])].filter((x): x is string => !!x))],
      ...(lastUsed !== undefined ? { lastActivityAt: lastUsed } : {}),
      consoleUrl: iamConsoleUrl(raw.RoleName),
      ...(created !== undefined ? { createdAt: created } : {}),
    });
  }
  return { resources, links: [], mentions: [] };
}

// ---------- detail (from the cached entry: no AWS call) ----------

export function iamDetail(key: string, raw: RawRole | undefined): ResourceDetail {
  if (!raw) return { key, sections: [{ title: "Details", note: "Trust and policy details come from the last IAM read; they show again after the next map refresh." }] };
  const own = roleAccount(raw);
  const trust = trustOf(raw.AssumeRolePolicyDocument, own);
  const lastUsed = awsTime(raw.RoleLastUsed?.LastUsedDate);
  const attached = (raw.AttachedManagedPolicies ?? []).map((p) => p.PolicyName ?? nameFromArn(p.PolicyArn)).filter(Boolean);
  const inline = (raw.RolePolicyList ?? []).map((p) => p.PolicyName ?? "").filter(Boolean);
  const profiles = (raw.InstanceProfileList ?? []).map((p) => p.Arn ?? p.InstanceProfileName ?? "").filter(Boolean);
  const sections: ResourceDetail["sections"] = [];
  sections.push({
    title: "Who can assume it",
    ...(trust?.entries.length
      ? { table: { columns: ["Type", "Principal", "Conditions"], rows: trust.entries.map((e) => [e.type === "Everyone" ? "Anyone" : e.type, e.principal, e.conditions.join("; ") || "—"]) } }
      : {}),
    note: !trust ? "The trust policy couldn't be read." : trust.error ?? (trust.warnings.join("; ") || undefined),
  });
  sections.push({
    title: "Permissions",
    rows: props([
      { label: "Attached policies", value: attached.length ? attached.join(", ") : "none" },
      { label: "Inline policies", value: inline.length ? inline.join(", ") : "none" },
      { label: "Permissions boundary", value: raw.PermissionsBoundary?.PermissionsBoundaryArn, mono: true },
    ]),
    note: "Policy names only — the console never stores or shows policy documents.",
  });
  sections.push({
    title: "Use",
    rows: props([
      { label: "Last used", value: lastUsed !== undefined ? fmtTime(lastUsed) : "never (IAM tracks the last 400 days)" },
      { label: "Last used in", value: raw.RoleLastUsed?.Region },
      { label: "Max session", value: raw.MaxSessionDuration ? fmtSeconds(raw.MaxSessionDuration) : undefined },
      { label: "Instance profiles", value: profiles.length ? `${plural(profiles.length, "profile")}: ${profiles.join(", ")}` : undefined, mono: true },
      { label: "Role id", value: raw.RoleId, mono: true },
      { label: "Created", value: raw.CreateDate ? fmtTime(awsTime(raw.CreateDate)) : undefined },
    ]),
  });
  return { key, sections };
}
