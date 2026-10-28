// Connect A → B: everything about a connection that doesn't touch AWS, shared by the cloud map's connect/disconnect
// actions (server/providers/ecs-connect.ts) and node:test. A connection is two changes, both shown before either is
// made: B's security group admits one of A's groups on B's port (a rule whose description names the console and
// A → B), and A gets a variable holding B's address — a database or cache endpoint, or for a service its ECS Service
// Connect name (Service Connect is turned on for B, and A joins the namespace as a client). Disconnect removes only
// what the console made: a rule with its description, and the variable while it still holds B's address.
import type { RawSecurityGroup } from "./types.ts";

export type Target =
  | { kind: "service"; name: string; port: number; sameHost: boolean; dnsName?: string } // dnsName: its Service Connect name, when it has one
  | { kind: "database"; name: string; engine: string; endpoint: string; port: number }
  | { kind: "cache"; name: string; engine: string; endpoint: string; port: number; tls?: boolean };

// The description of a rule the console adds. Security-group rule descriptions allow only a-z A-Z 0-9, spaces and
// ._-:/()#,@[]+=&;{}!$* (no arrow, not even ">"), up to 255 characters.
export const RULE_PREFIX = "deployment-console:";
export const ruleNote = (a: string, b: string) => `${RULE_PREFIX} ${a} to ${b}`.replace(/[^a-zA-Z0-9 ._\-:/()#,@[\]+=&;{}!$*]/g, "-").slice(0, 255);
export const isConsoleRule = (description?: string) => !!description?.startsWith(RULE_PREFIX);

// "acme-production-pg" → ACME_PRODUCTION_PG_URL (a variable name must start with a letter or "_").
export function varNameFor(name: string): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "TARGET";
  return `${/^[0-9]/.test(base) ? "_" : ""}${base}_URL`.slice(0, 255);
}

// A Service Connect discovery and DNS name: lowercase letters, digits, "-" and "_", up to 64, starting with a letter.
export function scNameFor(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 63).replace(/[-_]+$/, "");
  return s || "svc";
}

const SCHEMES: Record<string, string> = { postgres: "postgres", "aurora-postgresql": "postgres", mysql: "mysql", "aurora-mysql": "mysql", mariadb: "mysql" };

// B's address as A should use it. No credentials: a database's user and password belong in a secret reference.
export function addressOf(t: Target): string {
  if (t.kind === "service") return t.sameHost ? `http://127.0.0.1:${t.port}` : `http://${t.dnsName ?? scNameFor(t.name)}:${t.port}`;
  if (t.kind === "cache") return /^(redis|valkey)/.test(t.engine) ? `${t.tls ? "rediss" : "redis"}://${t.endpoint}:${t.port}` : `${t.endpoint}:${t.port}`;
  const scheme = Object.hasOwn(SCHEMES, t.engine) ? SCHEMES[t.engine] : undefined;
  return scheme ? `${scheme}://${t.endpoint}:${t.port}` : `${t.endpoint}:${t.port}`;
}

type Rule = RawSecurityGroup["inbound"][number];
// Whether a rule admits traffic from `group` on `port` (an all-traffic rule has no port, or -1).
export const admits = (r: Rule, group: string, port: number) =>
  r.groups.includes(group) && (r.fromPort === undefined || r.fromPort < 0 || (port >= r.fromPort && port <= (r.toPort === undefined || r.toPort < 0 ? r.fromPort : r.toPort)));
// A rule's description for one of its source groups (AWS keeps one per group; a single-source rule has its own).
const noteOf = (r: Rule, group: string) => r.notes?.[group] ?? (r.groups.length === 1 ? r.description : undefined);

export interface GroupChoice {
  group: string;
  sharedWith: string[]; // other services and hosts in that group: they can reach B too
}

// The group of A that B admits: one only A uses when there is one, so the rule opens B to A and nobody else.
export function sourceGroup(groups: string[], usersOf: (g: string) => string[]): GroupChoice | undefined {
  if (!groups.length) return undefined;
  const own = groups.find((g) => !usersOf(g).length);
  return own ? { group: own, sharedWith: [] } : { group: groups[0], sharedWith: usersOf(groups[0]) };
}

export interface RuleState {
  allowed?: { group: string; source: string; rule: string; mine: boolean }; // B already admits one of A's groups on the port
}

// What B's groups say about A today: a rule admitting one of A's groups on the port — the console's own when there
// is one (so disconnect finds it beside a team's broader rule), else the first.
export function ruleState(bGroups: RawSecurityGroup[], aGroups: string[], port: number): RuleState {
  let first: RuleState["allowed"];
  for (const g of bGroups)
    for (const r of g.inbound)
      for (const a of aGroups) {
        if (!admits(r, a, port)) continue;
        const note = noteOf(r, a);
        const ports = r.fromPort === undefined || r.fromPort < 0 ? " (all traffic)" : ` on ${r.fromPort === r.toPort || r.toPort === undefined ? r.fromPort : `${r.fromPort}–${r.toPort}`}`;
        const found = { group: g.id, source: a, rule: `${g.id} allows ${a}${ports}${note ? ` — "${note}"` : ""}`, mine: isConsoleRule(note) };
        if (found.mine) return { allowed: found };
        first ??= found;
      }
  return first ? { allowed: first } : {};
}

// The shipped IAM policy opens only groups the console made or that a team tagged for it.
export const OPENABLE_TAG = "console:connect";
export const openable = (g: Pick<RawSecurityGroup, "tags">) => g.tags?.["console:created"] === "true" || g.tags?.[OPENABLE_TAG] === "allow";

export interface ConnectFacts {
  env: string;
  a: { name: string; container: string; groups: string[] };
  b: Target & { group?: { id: string; openable: boolean } }; // the group of B that gets the rule
  source?: GroupChoice;
  rule: RuleState;
  variable: { name: string; current?: string }; // current: A's value of it today
  serviceConnect?: {
    namespace: { name: string; exists: boolean };
    b: { exposes: boolean; portName?: string; rename?: boolean }; // rename: B's port mapping gets a name first
    aClient: boolean; // A is already a client in that namespace
  };
}

export interface ConnectPlan {
  summary: string;
  changes: string[];
  warnings: string[];
  steps: { rule: boolean; variable: boolean; serviceConnect: boolean };
}

const portText = (t: Target) => `${t.port}/tcp`;

export function connectPlan(f: ConnectFacts): ConnectPlan {
  const { a, b } = f;
  const address = addressOf(b);
  const changes: string[] = [];
  const warnings: string[] = [];
  // 1. The network: B admits A.
  const sameHost = b.kind === "service" && b.sameHost;
  const needRule = !sameHost && !f.rule.allowed;
  if (sameHost) changes.push(`Same EC2 host: ${a.name} reaches ${b.name} on 127.0.0.1 — no security group change`);
  else if (f.rule.allowed) changes.push(`${b.name} already admits ${a.name} on ${portText(b)} (${f.rule.allowed.rule}) — no security group change`);
  else if (b.group && f.source) {
    changes.push(`Add an inbound rule to ${b.name}'s security group ${b.group.id}: ${portText(b)} from ${a.name}'s ${f.source.group} ("${ruleNote(a.name, b.name)}")`);
    if (f.source.sharedWith.length) warnings.push(`${f.source.group} is also used by ${f.source.sharedWith.join(", ")}: ${f.source.sharedWith.length === 1 ? "it" : "they"} can reach ${b.name} on port ${b.port} too.`);
    if (!b.group.openable) warnings.push(`The shipped IAM policy opens only security groups the console made or tagged ${OPENABLE_TAG}=allow: tag ${b.group.id} first, or AWS refuses this rule.`);
  }
  // 2. Service Connect, for a service in another task's network.
  const sc = f.serviceConnect;
  if (sc) {
    if (!sc.namespace.exists) changes.push(`Create Cloud Map namespace ${sc.namespace.name} (API calls only, the kind Service Connect uses) for ${f.env}`);
    if (sc.b.rename) changes.push(`Register a revision of ${b.name}'s task definition that names its port ${b.port} "${sc.b.portName}" (Service Connect refers to the port by name); nothing else changes`);
    if (!sc.b.exposes) changes.push(`Turn on Service Connect for ${b.name} in ${sc.namespace.name}: it answers at ${address} — a new deployment of ${b.name}`);
    if (!sc.aClient) changes.push(`${a.name} joins ${sc.namespace.name} as a Service Connect client (with the deployment below)`);
    warnings.push(`Service Connect adds a proxy container to each new task of ${b.name}${sc.aClient ? "" : ` and ${a.name}`} (ECS suggests 256 more CPU units and 64 MiB of memory); only tasks started after this resolve ${address}.`);
  }
  // 3. The variable, through a new revision of A.
  const needVar = f.variable.current !== address;
  if (needVar) changes.push(`Set ${f.variable.name}=${address} on ${a.name}'s container ${a.container}: a new task definition revision, then a rolling deployment`);
  else changes.push(`${a.name} already has ${f.variable.name}=${address} — no variable change`);
  if (b.kind === "database") warnings.push(`${f.variable.name} carries no user or password: add them as secret references in ${a.name}'s Variables tab.`);
  return {
    summary: `Connect ${a.name} → ${b.name} in ${f.env}`,
    changes, warnings,
    steps: { rule: needRule, variable: needVar, serviceConnect: !!sc && (!sc.b.exposes || !sc.aClient || !sc.namespace.exists) },
  };
}

export interface DisconnectFacts {
  env: string;
  a: { name: string };
  b: Target;
  rule: RuleState;
  variable: { name: string; current?: string };
}

// What disconnect undoes: the console's rule, and the variable while it holds B's address. Service Connect stays on
// (other services may use B by that name). Nothing of the console's left → nothing to do.
export function disconnectPlan(f: DisconnectFacts): ConnectPlan & { nothing: boolean } {
  const address = addressOf(f.b);
  const changes: string[] = [];
  const warnings: string[] = [];
  const rule = !!f.rule.allowed?.mine;
  const variable = f.variable.current === address;
  if (rule) changes.push(`Remove the inbound rule ${f.rule.allowed!.rule} from ${f.b.name}'s security group`);
  else if (f.rule.allowed) warnings.push(`${f.rule.allowed.rule}: the console didn't make that rule, so it stays.`);
  if (variable) changes.push(`Remove ${f.variable.name} from ${f.a.name}: a new task definition revision, then a rolling deployment`);
  else if (f.variable.current !== undefined) warnings.push(`${f.variable.name} on ${f.a.name} holds another value now, so it stays.`);
  if (f.b.kind === "service" && !f.b.sameHost) warnings.push(`Service Connect stays on for ${f.b.name} and ${f.a.name}: other services may use it.`);
  return { summary: `Disconnect ${f.a.name} → ${f.b.name} in ${f.env}`, changes, warnings, steps: { rule, variable, serviceConnect: false }, nothing: !rule && !variable };
}
