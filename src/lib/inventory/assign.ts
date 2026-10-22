// Environment assignment for the cloud map, pure so node:test covers it (assign.test.ts). Every resource gets at most
// one environment id plus a one-line reason (`envWhy`); no environment means shared or unassigned. The first rule that
// answers wins:
//   1. the provider's hint (the ECS cluster a service runs in, a declared workload's env) — authoritative
//   2. tag console:env
//   3. tags Environment / environment / Env / env / Stage / stage — stage words normalised (prd, live → production;
//      stg, preprod → staging; the words of src/lib/discover.ts), "shared" / "global" / "all" → explicitly shared
//   4. stage words in the resource's id or key ("acme-staging-orders" → staging), only when exactly one environment
//      matches — never its display name (a Name tag, a declared label: F69)
//   then: a child (subnet, NAT, Aurora member…) takes its parent's environment
//   5. the VPC, when every resource placed by rules 1–4 in that VPC agrees on one environment
//   6. connectivity: all its neighbours that already have an environment agree (repeated up to three hops), and still
//      agree once every hop is placed — else it stays shared
// Hubs — the support layers (network, security, observability, delivery) and generic catch-all rows — may receive an
// environment but never count as inputs to rules 5 and 6 (CC-15): a VPC's security groups or one shared KMS key must
// not decide, or un-decide, where the workloads around them belong. Generic rows are placed by tags and ids only, and
// a bucket linked only through env-file mentions is not placed by connectivity (F69).
// Kubernetes workloads then take their EKS cluster's environment. Protection (protectedBy) is decided separately and
// fails safe: any hint that names a protected environment counts, whichever rule placed the resource.
// Environments = the ECS environments (always listed, with their own protected flag) plus ids found in tags and names.
import { isProtectedStage, stageIdOf, stageOrder } from "../discover.ts";
import { parseArn } from "./arn.ts";
import { categoryOf, isSupport, type Edge, type InventoryView, type Resource } from "./types.ts";

export interface KnownEnv {
  id: string;
  label: string;
  protected: boolean;
  source: "ecs" | "config";
}
export type EnvEntry = InventoryView["envs"][number];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
const title = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const ENV_TAGS = ["Environment", "environment", "Env", "env", "Stage", "stage"];
const SHARED = new Set(["shared", "common", "global", "all", "any", "none", "na", "n-a", "multi", "multiple"]);
const truthy = (v?: string) => !!v && /^(1|true|yes|on)$/i.test(v.trim());

// A tag value or hint → environment id: an existing environment when it names one (by id or stage word), else the
// canonical stage id, else the value itself as a slug. "" / "shared" → null (explicitly no environment).
export function normalizeEnv(value: string, known: Pick<KnownEnv, "id">[]): string | null {
  const v = value.trim().toLowerCase();
  const s = slug(v);
  if (!s || SHARED.has(s)) return null;
  if (known.some((k) => k.id === s)) return s;
  const canon = stageIdOf(v);
  if (canon) return (known.find((k) => k.id === canon) ?? known.find((k) => stageIdOf(k.id) === canon))?.id ?? canon;
  return s;
}

// Stage words (or an existing environment's id) in a name; ambiguous names ("prod-to-staging-sync") answer nothing.
export function envFromName(name: string, known: Pick<KnownEnv, "id">[]): { env: string; token: string } | undefined {
  const found = new Map<string, string>();
  for (const t of name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const env = t.length >= 3 && known.some((k) => k.id === t) ? t : stageIdOf(t) ? normalizeEnv(t, known) : null;
    if (env && !found.has(env)) found.set(env, t);
  }
  if (found.size !== 1) return undefined;
  const [[env, token]] = [...found];
  return { env, token };
}

type Why = { env: string | null; why: string; source: "tags" | "names" };

// Environment ids are unique across regions: an environment whose name repeats outside the home region is renamed
// "<id>-<region>" (src/lib/regions.ts regionalIds). A resource in that region whose tag or id names the plain id
// ("production" on a bucket in eu-west-1) belongs to the region's environment ("production-eu-west-1").
export function regionalEnv(env: string, region: string | undefined, known: Pick<KnownEnv, "id">[]): string {
  if (!region) return env;
  const there = `${env}-${region}`;
  return known.some((k) => k.id === there) ? there : env;
}

// A provider's hint is authoritative (the ECS cluster a service runs in, the config a workload is declared in), so it
// decides the displayed environment before any tag: whoever can tag a resource must not be able to move it.
function direct(r: Resource, known: KnownEnv[]): Why | undefined {
  const norm = (v: string) => {
    const env = normalizeEnv(v, known);
    return env && regionalEnv(env, r.region, known);
  };
  if (r.envHint?.trim()) {
    const env = norm(r.envHint);
    if (env) return { env, why: `reported by ${r.provider}`, source: "names" };
  }
  const own = r.tags?.["console:env"];
  if (own?.trim()) return { env: norm(own), why: `tag console:env=${own}`, source: "tags" };
  for (const k of ENV_TAGS) {
    const v = r.tags?.[k];
    if (v?.trim()) return { env: norm(v), why: `tag ${k}=${v}`, source: "tags" };
  }
  const n = envFromName(idName(r), known);
  if (n) return { env: regionalEnv(n.env, r.region, known), why: `name contains "${n.token}"`, source: "names" };
  return undefined;
}

// What a resource is called in its id — the key's last part (an ARN's resource id, "rds:<id>", "workload:<id>"), never
// its display name: a Name tag or a declared label ("Live Core") says nothing reliable about the stage (F69).
export function idName(r: Pick<Resource, "key">): string {
  const k = r.key.replace(/@[a-z0-9-]+$/, "");
  const p = parseArn(k);
  if (p) return p.id || p.resource;
  const i = k.indexOf(":");
  return i >= 0 ? k.slice(i + 1) : k;
}

// Hubs receive an environment but never place others (CC-15).
export const isHub = (r: Pick<Resource, "kind" | "category">) => r.kind === "aws-resource" || isSupport(categoryOf(r));
// A link made only by an env-file mention ("the service reads its variables from this bucket": evidence "env file")
// says where the file is, not which environment the bucket belongs to. A variable inside the file that names a bucket
// ("env file ASSETS_BUCKET") is a real use and still counts.
const envFileOnly = (e: Edge) => e.evidence.length > 0 && e.evidence.every((x) => x === "env file");

export function assignEnvs(input: Resource[], edges: Edge[], known: KnownEnv[]): { resources: Resource[]; envs: EnvEntry[] } {
  const resources = input.map((r) => ({ ...r, env: undefined as string | undefined, envWhy: undefined as string | undefined }));
  const byKey = new Map(resources.map((r) => [r.key, r]));
  const decided = new Set<string>(); // explicitly placed (or explicitly shared) by rules 1–4, or by their parent
  const own = new Set<string>(); // placed by rules 1–4 themselves
  const hubs = new Set(resources.filter(isHub).map((r) => r.key));
  const sourceOf = new Map<string, "tags" | "names">();

  for (const r of resources) {
    if (r.kind === "external") continue;
    const d = direct(r, known);
    if (!d) continue;
    decided.add(r.key);
    own.add(r.key);
    r.envWhy = d.why;
    if (d.env) {
      r.env = d.env;
      if (!sourceOf.has(d.env) || d.source === "tags") sourceOf.set(d.env, d.source);
    }
  }

  // Children belong where their parent does (a subnet in its VPC, a NAT in its subnet, an Aurora member in its
  // cluster), unless they say otherwise themselves. Repeated so a chain (NAT → subnet → VPC) settles.
  const inherit = (mark: boolean) => {
    for (let depth = 0; depth < 4; depth++) {
      let changed = false;
      for (const r of resources) {
        const parent = r.parent ? byKey.get(r.parent) : undefined;
        if (!parent?.env || own.has(r.key) || r.env === parent.env || r.kind === "external") continue;
        r.env = parent.env;
        r.envWhy = `part of ${parent.name}`;
        if (mark) decided.add(r.key);
        changed = true;
      }
      if (!changed) break;
    }
  };
  inherit(true);

  // 5. VPCs that belong to exactly one environment — judged by the workloads in them, never by hubs (CC-15).
  const vpcEnvs = new Map<string, Set<string>>();
  for (const r of resources) if (r.env && r.vpcId && !hubs.has(r.key)) vpcEnvs.set(r.vpcId, new Set([...(vpcEnvs.get(r.vpcId) ?? []), r.env]));
  for (const r of resources) {
    if (decided.has(r.key) || r.kind === "external" || r.kind === "aws-resource" || !r.vpcId) continue;
    const envs = vpcEnvs.get(r.vpcId);
    if (envs?.size === 1) {
      r.env = [...envs][0];
      r.envWhy = `VPC ${r.vpcId}`;
      decided.add(r.key);
    }
  }

  // 6. Connectivity, one hop per pass, from a snapshot so a pass never feeds itself. Hubs never pass an environment on,
  // and a bucket isn't placed by the services that only read env files from it.
  const near = new Map<string, Set<string>>();
  const link = (a: string, b: string) => near.set(a, new Set([...(near.get(a) ?? []), b]));
  for (const e of edges) {
    const a = byKey.get(e.from), b = byKey.get(e.to);
    if (!a || !b || ((a.kind === "s3" || b.kind === "s3") && envFileOnly(e))) continue;
    link(e.from, e.to);
    link(e.to, e.from);
  }
  // A pass places a resource on the neighbours placed so far, so a neighbour placed a pass later can still disagree:
  // once settled, a resource whose neighbours disagree is contested — shared — and the spread runs again without it,
  // so nothing keeps an environment that only a contested resource gave it.
  const linked = new Set<string>(); // placed by connectivity
  const contested = new Set<string>();
  const neighbourEnvs = (k: string, env: (k: string) => string | undefined) =>
    [...(near.get(k) ?? [])].filter((n) => env(n) && !hubs.has(n));
  const spread = () => {
    for (const k of linked) Object.assign(byKey.get(k)!, { env: undefined, envWhy: undefined });
    linked.clear();
    for (let pass = 0; pass < 3; pass++) {
      const snapshot = new Map(resources.map((r) => [r.key, r.env]));
      let changed = false;
      for (const r of resources) {
        if (decided.has(r.key) || r.env || contested.has(r.key) || r.kind === "external" || r.kind === "aws-resource") continue;
        const withEnv = neighbourEnvs(r.key, (k) => snapshot.get(k));
        const envs = new Set(withEnv.map((k) => snapshot.get(k)!));
        if (envs.size !== 1) continue;
        const via = byKey.get(withEnv[0])!;
        r.env = [...envs][0];
        r.envWhy = `connected to ${via.name}${withEnv.length > 1 ? ` and ${withEnv.length - 1} more` : ""}`;
        linked.add(r.key);
        changed = true;
      }
      if (!changed) break;
    }
  };
  const envNow = (k: string) => byKey.get(k)!.env;
  for (spread(); ; spread()) {
    const fresh = [...linked].filter((k) => new Set(neighbourEnvs(k, envNow).map(envNow)).size > 1);
    if (!fresh.length) break;
    for (const k of fresh) contested.add(k);
  }
  inherit(false); // parents placed by their VPC or their connections pass it on too

  // Kubernetes workloads belong to their cluster: they run in its environment.
  const clusterOf = new Map<string, string>();
  for (const e of edges) if (byKey.get(e.from)?.kind === "eks-cluster" && byKey.get(e.to)?.kind === "eks-workload") clusterOf.set(e.to, e.from);
  for (const r of resources) {
    const c = clusterOf.get(r.key);
    const parent = c ? byKey.get(c) : undefined;
    if (parent?.env) { // the cluster is authoritative, like a provider hint: labels on a workload can't move it
      r.env = parent.env;
      r.envWhy = `runs in EKS cluster ${parent.name}`;
    }
  }

  const envs: EnvEntry[] = known.map((k) => ({ id: k.id, label: k.label, protected: k.protected, source: k.source }));
  const extra = [...new Set(resources.map((r) => r.env).filter((e): e is string => !!e && !known.some((k) => k.id === e)))];
  extra.sort((a, b) => (stageOrder(a) ?? 2.5) - (stageOrder(b) ?? 2.5) || a.localeCompare(b));
  for (const id of extra) {
    const protectedTag = resources.some((r) => r.env === id && truthy(r.tags?.["console:protected"]));
    envs.push({ id, label: title(id), protected: isProtectedStage(id) || protectedTag, source: sourceOf.get(id) ?? "names" });
  }

  // Protection fails safe: every hint about a resource's environment counts — its provider's hint, its tags, its id,
  // its VPC, its parent, its cluster — and if any of them names a protected environment, changes follow the protected
  // rules. A tag can add protection but never take it away. The id's stage word is the one hint that yields to an
  // authoritative provider hint that disagrees (F69: "live-core-staging" is staging, whatever "live" says).
  const isProt = (id: string | null | undefined) => !!id && (envs.find((e) => e.id === id)?.protected ?? isProtectedStage(id));
  for (const r of resources) {
    if (r.kind === "external") continue;
    const hinted = r.envHint ? normalizeEnv(r.envHint, known) : undefined;
    const fromId = envFromName(idName(r), known)?.env;
    const parent = r.parent ? byKey.get(r.parent) : undefined;
    const hints: [string | null | undefined, string][] = [
      [r.env, r.envWhy ?? "its environment"],
      [hinted, `reported by ${r.provider}`],
      [r.tags?.["console:env"] ? normalizeEnv(r.tags["console:env"], known) : undefined, "tag console:env"],
      ...ENV_TAGS.map((k): [string | null | undefined, string] => [r.tags?.[k] ? normalizeEnv(r.tags[k], known) : undefined, `tag ${k}`]),
      [hinted && fromId !== hinted ? undefined : fromId, "its name"],
      [r.vpcId && vpcEnvs.get(r.vpcId)?.size === 1 ? [...vpcEnvs.get(r.vpcId)!][0] : undefined, `VPC ${r.vpcId}`],
      [parent?.env, `part of ${parent?.name}`],
      [clusterOf.get(r.key) ? byKey.get(clusterOf.get(r.key)!)?.env : undefined, "its EKS cluster"],
    ];
    const hit = hints.find(([id]) => isProt(id));
    if (hit) r.protectedBy = `${hit[1]} → ${hit[0]}`;
    else if (truthy(r.tags?.["console:protected"])) r.protectedBy = "tag console:protected";
  }
  return { resources, envs };
}
