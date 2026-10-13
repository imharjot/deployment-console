// Discovery rules, pure (no AWS calls) so they can be unit-tested and read in one place.
// Inputs are raw describes; outputs are environments, attributions and inferred connections.
import type { EdgeKind } from "./types.ts";

// ---------- environments from ECS clusters ----------

// Well-known stage words → canonical env id. A cluster named "acme-prod-cluster" becomes "production".
const STAGES: { id: string; words: string[]; order: number; protected: boolean }[] = [
  { id: "dev", words: ["dev", "develop", "development"], order: 0, protected: false },
  { id: "sandbox", words: ["sandbox", "preview", "demo"], order: 0, protected: false },
  { id: "qa", words: ["qa", "test", "testing"], order: 1, protected: false },
  { id: "uat", words: ["uat"], order: 2, protected: false },
  { id: "staging", words: ["staging", "stage", "stg", "preprod"], order: 3, protected: false },
  { id: "production", words: ["production", "prod", "prd", "live"], order: 4, protected: true },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "env";
const title = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const truthy = (v?: string) => (v === undefined ? undefined : /^(1|true|yes|on)$/i.test(v.trim()));

function stageOf(name: string) {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/);
  return STAGES.find((s) => s.words.some((w) => tokens.includes(w)));
}

// One word or tag value → canonical stage id ("prd" → "production", "stg" → "staging"), for the cloud map's
// environment assignment (src/lib/inventory/assign.ts). Undefined when it isn't a stage word.
export function stageIdOf(word: string): string | undefined {
  const w = word.trim().toLowerCase();
  return STAGES.find((s) => s.id === w || s.words.includes(w))?.id;
}
export const isProtectedStage = (id: string) => !!STAGES.find((s) => s.id === stageIdOf(id))?.protected;
export const stageOrder = (id: string) => STAGES.find((s) => s.id === stageIdOf(id))?.order;

export interface ClusterLike {
  name: string;
  tags: Record<string, string>;
}
export interface EnvDraft {
  id: string;
  label: string;
  protected: boolean;
  order: number;
  branch?: string;
  cluster: string;
}

// Tags win (console:env, console:label, console:protected, console:order, console:branch), then stage words, then the name.
export function envsFromClusters(clusters: ClusterLike[]): EnvDraft[] {
  const drafts = clusters.map((c) => {
    const st = stageOf(c.name);
    const id = c.tags["console:env"] ? slug(c.tags["console:env"]) : st?.id;
    return { c, st, id };
  });
  const count = new Map<string, number>();
  for (const d of drafts) if (d.id) count.set(d.id, (count.get(d.id) ?? 0) + 1);
  return drafts
    .map(({ c, st, id }) => {
      const unique = id && (count.get(id) === 1 || c.tags["console:env"]) ? id : slug(c.name);
      const order = Number(c.tags["console:order"]);
      return {
        id: unique,
        label: c.tags["console:label"] ?? (unique === st?.id ? title(st.id) : title(c.name)),
        protected: truthy(c.tags["console:protected"]) ?? st?.protected ?? false,
        order: Number.isFinite(order) ? order : (st?.order ?? 2.5),
        branch: c.tags["console:branch"],
        cluster: c.name,
      };
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

// ---------- images ----------

export interface ImageRef {
  ecr: boolean;
  registry: string;
  repository: string; // path without registry, e.g. "team/api"
  tag?: string;
  digest?: string;
  region?: string;
}

export function parseImageRef(image: string): ImageRef {
  const [nameTag, digest] = image.split("@");
  const slash = nameTag.indexOf("/");
  const first = slash > 0 ? nameTag.slice(0, slash) : "";
  const hasRegistry = /[.:]/.test(first) || first === "localhost";
  const registry = hasRegistry ? first : "docker.io";
  const rest = hasRegistry ? nameTag.slice(slash + 1) : nameTag;
  const colon = rest.lastIndexOf(":");
  const repository = colon > 0 ? rest.slice(0, colon) : rest;
  const tag = colon > 0 ? rest.slice(colon + 1) : digest ? undefined : "latest";
  const m = /^\d{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/.exec(registry);
  return { ecr: !!m, registry, repository, tag, digest, region: m?.[1] };
}

// A git sha anywhere in the tag ("staging-1a2b3c4", "v1.2-abc1234def", "1a2b3c4d…"). Moving tags (latest) have none.
export function shaFromTag(tag?: string): string | undefined {
  if (!tag) return undefined;
  const m = /(?:^|[^0-9a-f])([0-9a-f]{7,40})(?:$|[^0-9a-f])/.exec(tag.toLowerCase());
  return m && /[a-f]/.test(m[1]) && /\d/.test(m[1]) ? m[1] : undefined;
}

// Reverse proxies whose presence makes a service the env's ingress when there is no load balancer.
export const PROXY_IMAGE = /(^|\/)(caddy|nginx|traefik|haproxy|envoy)(:|$|-)/;

// ---------- docker compose environments ----------

// A compose env's apps (console.config.json `workloads` whose env is that env) as topology: a service node each, edges
// from their `uses` — "rds:<id>" / "elasticache:<id>" (only the env's own), "external:<id>", another workload's id —
// and the reverse proxy among them (by id) as the ingress. A source-side external (`sources`) points into the workload.
// Other references stay on the cloud map only.
export function workloadGraph(
  workloads: Record<string, { name: string; uses?: string[] }>,
  have: { databases: string[]; caches: string[]; externals: string[]; sources?: string[] },
): { nodes: string[]; edges: { from: string; to: string; kind: EdgeKind; label: string }[]; ingress?: string } {
  const LABEL: Record<EdgeKind, string> = { sql: "SQL", cache: "cache", api: "API", http: "HTTP", stream: "stream" };
  const edges: { from: string; to: string; kind: EdgeKind; label: string }[] = [];
  for (const [id, w] of Object.entries(workloads)) {
    for (const ref of w.uses ?? []) {
      const colon = ref.indexOf(":");
      const [prefix, rest] = colon > 0 ? [ref.slice(0, colon), ref.slice(colon + 1)] : ["", ref];
      const hit: [string, EdgeKind] | undefined = Object.hasOwn(workloads, ref)
        ? [`service:${ref}`, /redis|valkey|memcache/i.test(ref) ? "cache" : /postgres|mysql|mariadb|mongo/i.test(ref) ? "sql" : "http"]
        : prefix === "rds" && have.databases.includes(rest) ? [`database:${rest}`, "sql"]
        : prefix === "elasticache" && have.caches.includes(rest) ? [`cache:${rest}`, "cache"]
        : prefix === "external" && have.externals.includes(rest) ? [`ext:${rest}`, "api"]
        : undefined;
      if (!hit) continue;
      const [from, to] = prefix === "external" && have.sources?.includes(rest) ? [hit[0], `service:${id}`] : [`service:${id}`, hit[0]];
      if (!edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, kind: hit[1], label: LABEL[hit[1]] });
    }
  }
  const proxy = Object.keys(workloads).find((id) => PROXY_IMAGE.test(id));
  return { nodes: Object.keys(workloads).map((id) => `service:${id}`), edges, ...(proxy ? { ingress: `service:${proxy}` } : {}) };
}

// ---------- hosts referenced from container environment ----------

export interface HostRef {
  host: string;
  port?: number;
  via: string; // env var name (never the value)
}

// Pulls host[:port] out of environment values: URLs (with or without credentials), host:port pairs, AWS endpoints.
// Runs where the task definition is read, so only hostnames — never values — leave that function.
export function hostsFromEnv(vars: { name: string; value: string }[]): HostRef[] {
  const out: HostRef[] = [];
  const seen = new Set<string>();
  const push = (host: string, port: string | undefined, via: string) => {
    const h = host.toLowerCase().replace(/\.$/, "");
    if (!/^[a-z0-9.-]+$/.test(h) || h.length > 253) return;
    const k = `${h}:${port ?? ""}:${via}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ host: h, port: port ? Number(port) : undefined, via });
  };
  for (const { name, value } of vars) {
    if (!value || value.length > 2000) continue;
    for (const m of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^@\s/]*@)?([a-z0-9.-]+)(?::(\d{2,5}))?/gi)) push(m[1], m[2], name);
    for (const m of value.matchAll(/(?:^|[\s,;=])([a-z0-9][a-z0-9.-]*):(\d{2,5})(?=$|[\s,;/])/gi)) push(m[1], m[2], name);
    for (const m of value.matchAll(/\b([a-z0-9.-]+\.amazonaws\.com)\b/gi)) push(m[1], undefined, name);
  }
  return out;
}

// ---------- connections ----------

export interface NodeRef {
  id: string; // "service:x", "database:y", "cache:z"
  kind: "service" | "database" | "cache";
  securityGroups: string[];
  ports: number[];
  hosts?: string[]; // endpoints / names this node answers to (DB endpoint, cache endpoint, service + container names)
  hostNetwork?: boolean; // shares the host's network (ECS "host" mode): reachable as localhost:<port>
  engine?: string;
}
export interface SgRule {
  fromPort?: number;
  toPort?: number;
  groups: string[]; // source security groups
  cidrs?: string[]; // source CIDR ranges (not used for edges here: the exposure rule R4 reads them as facts)
  prefixLists?: string[];
}
export interface InferredEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label: string;
  source: string; // why we think this connection exists
}
// A self-referencing security group ("members of sg-x may reach each other"): it says nothing about which of its
// members actually talk, so it draws no service ↔ service edges — callers record it on the members instead.
export interface PeerGroup {
  group: string;
  members: string[]; // node ids in the group
}
export interface Connections {
  edges: InferredEdge[];
  peerGroups: PeerGroup[];
  truncated: { to: string; kept: number; dropped: number }[]; // security-group-only edges over the per-target cap
}

// Most security-group-only ("allowed") edges drawn into one target; the rest are counted, not drawn (F14).
export const MAX_ALLOWED_PER_TARGET = 50;

const PORT_KIND: Record<number, EdgeKind> = { 5432: "sql", 3306: "sql", 1433: "sql", 27017: "sql", 6379: "cache", 11211: "cache", 9092: "stream", 5672: "stream" };
const kindTo = (n: NodeRef, port?: number): EdgeKind =>
  n.kind === "database" ? "sql" : n.kind === "cache" ? "cache" : (PORT_KIND[port ?? -1] ?? n.ports.map((p) => PORT_KIND[p]).find(Boolean) ?? "http");
const LOCAL = new Set(["localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal"]);
const fromSg = (e: InferredEdge) => e.source.startsWith("security group");
// Does a rule admit any port a database or cache listens on? A rule without ports (all traffic) admits every one, and
// a target whose ports aren't known is admitted by any rule. Services are never checked: with bridge networking their
// rules name host ports, not the container ports they declare.
export const ruleReaches = (r: Pick<SgRule, "fromPort" | "toPort">, to: Pick<NodeRef, "kind" | "ports">) =>
  to.kind === "service" || !to.ports.length || r.fromPort === undefined || r.fromPort < 0 ||
  to.ports.some((p) => p >= r.fromPort! && p <= (r.toPort === undefined || r.toPort < 0 ? r.fromPort! : r.toPort));

// Connections between nodes, from security-group rules and from environment values that name another node.
// - Each group is indexed to its members once, so a rule only visits the members of the groups it names
//   (O(rules × members), not O(nodes²)).
// - Peer rules (the source group is one of the target's own groups) on a service draw nothing: N services sharing one
//   self-referencing group would otherwise draw N(N−1) guesses. They are returned in `peerGroups`. The same rule on a
//   database or cache still draws service → database / cache: the direction is implied.
// - A rule into a database or cache must admit a port it listens on (ruleReaches).
// - The evidence names the group that matched: "security group sg-db allows sg-api".
// - A connection string outranks a security-group rule for the same pair, and security-group-only edges into one
//   target are capped at `maxAllowedPerTarget` (default 50; the rest are reported in `truncated`).
export function inferConnections(
  nodes: NodeRef[], rules: Record<string, SgRule[]>, envHosts: Record<string, HostRef[]>, opts: { maxAllowedPerTarget?: number } = {},
): Connections {
  const edges = new Map<string, InferredEdge>();
  const add = (e: InferredEdge) => {
    const k = `${e.from}>${e.to}`;
    const had = edges.get(k);
    if (!had || (fromSg(had) && e.source.startsWith("task definition"))) edges.set(k, e);
  };
  const members = new Map<string, NodeRef[]>();
  for (const n of nodes)
    for (const g of new Set(n.securityGroups)) {
      const l = members.get(g);
      if (l) l.push(n);
      else members.set(g, [n]);
    }
  const peers = new Map<string, string[]>();
  // 1. Security groups: the target allows traffic from one of the source's groups.
  for (const to of nodes) {
    const own = new Set(to.securityGroups);
    for (const sg of own) {
      for (const r of Object.hasOwn(rules, sg) ? rules[sg] : []) {
        if (!ruleReaches(r, to)) continue; // e.g. a group admitting 5432 says nothing about OpenSearch on 443
        const port = r.fromPort && r.fromPort === r.toPort ? `:${r.fromPort}` : r.fromPort ? `:${r.fromPort}-${r.toPort}` : "";
        const kind = kindTo(to, r.fromPort === r.toPort ? r.fromPort : undefined);
        for (const g of new Set(r.groups ?? [])) {
          const from = members.get(g);
          if (!from?.length) continue;
          const peer = own.has(g);
          // A group only its target is in says nothing about anyone else: not a peer group.
          if (peer && from.length > 1 && !peers.has(g)) peers.set(g, from.map((n) => n.id));
          if (peer && to.kind === "service") continue;
          for (const f of from) {
            if (f.id === to.id || (peer && f.kind !== "service")) continue;
            add({ from: f.id, to: to.id, kind, label: `${to.engine ?? to.kind}${port}`, source: `security group ${sg} allows ${g}` });
          }
        }
      }
    }
  }
  // 2. Environment variables that name another node's endpoint (or localhost:<port> on a shared host network).
  for (const from of nodes) {
    for (const h of envHosts[from.id] ?? []) {
      for (const to of nodes) {
        if (to.id === from.id) continue;
        const named = to.hosts?.some((x) => x === h.host || h.host.endsWith(`.${x}`) || x.startsWith(`${h.host}.`));
        const local = LOCAL.has(h.host) && from.hostNetwork && to.hostNetwork && h.port !== undefined && to.ports.includes(h.port);
        if (named || local) add({ from: from.id, to: to.id, kind: kindTo(to, h.port), label: `${to.engine ?? to.kind}${h.port ? `:${h.port}` : ""}`, source: `task definition env ${h.via}` });
      }
    }
  }
  // 3. The cap: security-group-only edges per target, the first sources (by id) kept.
  const max = opts.maxAllowedPerTarget ?? MAX_ALLOWED_PER_TARGET;
  const byTarget = new Map<string, InferredEdge[]>();
  for (const e of edges.values()) {
    if (!fromSg(e)) continue;
    const l = byTarget.get(e.to);
    if (l) l.push(e);
    else byTarget.set(e.to, [e]);
  }
  const truncated: Connections["truncated"] = [];
  for (const [to, list] of byTarget) {
    if (list.length <= max) continue;
    list.sort((a, b) => a.from.localeCompare(b.from));
    for (const e of list.slice(max)) edges.delete(`${e.from}>${e.to}`);
    truncated.push({ to, kept: max, dropped: list.length - max });
  }
  return { edges: [...edges.values()], peerGroups: [...peers].map(([group, ids]) => ({ group, members: ids })), truncated };
}

// The ECS views' connections (src/lib/server/discovery.ts): the same rules as the cloud map, edges only.
export function inferEdges(nodes: NodeRef[], rules: Record<string, SgRule[]>, envHosts: Record<string, HostRef[]>): InferredEdge[] {
  return inferConnections(nodes, rules, envHosts).edges;
}

// ---------- attributing account-wide resources (RDS, ElastiCache) to an environment ----------

export interface Attributable {
  id: string;
  tags: Record<string, string>;
  vpcId?: string;
}

// Order: explicit config → console:env tag → Environment/env/stage tag → connected from the env's services → name token.
export function attribute(r: Attributable, envs: { id: string; stageWords: string[]; vpcIds: string[] }[], connectedFrom: Set<string>, configured: Record<string, string>): string | undefined {
  if (configured[r.id]) return configured[r.id];
  const tag = r.tags["console:env"] ?? r.tags.Environment ?? r.tags.environment ?? r.tags.env ?? r.tags.Env ?? r.tags.stage ?? r.tags.Stage;
  if (tag) {
    const t = tag.toLowerCase();
    const hit = envs.find((e) => e.id === slug(t) || e.stageWords.includes(t));
    if (hit) return hit.id;
  }
  const linked = envs.filter((e) => connectedFrom.has(e.id));
  if (linked.length === 1) return linked[0].id;
  const tokens = r.id.toLowerCase().split(/[^a-z0-9]+/);
  const named = envs.filter((e) => tokens.includes(e.id) || e.stageWords.some((w) => tokens.includes(w)));
  if (named.length === 1) return named[0].id;
  const sameVpc = envs.filter((e) => r.vpcId && e.vpcIds.includes(r.vpcId));
  return sameVpc.length === 1 ? sameVpc[0].id : undefined;
}

export const stageWordsOf = (envId: string, cluster: string) => [envId, ...(STAGES.find((s) => s.id === envId || s.words.includes(envId))?.words ?? []), ...(stageOf(cluster)?.words ?? [])];
