// Connect A → B on the cloud map: an ECS service (A) to another service, a database or a cache (B) of its environment.
// Two changes, planned together (the rules and plan text are pure in ../../connect.ts):
// 1. B's security group admits one of A's groups on B's port — a rule whose description names the console and A → B;
// 2. A gets a variable holding B's address — the endpoint of a database or cache, or for a service its ECS Service
//    Connect name: Service Connect is turned on for B (in the environment's namespace, made in Cloud Map if missing)
//    and A joins as a client in the same deployment as its new revision.
// Disconnect removes the console's rule and the variable while it still holds B's address; Service Connect stays.
// No resources of its own (the ecs provider lists the services): the runner (../inventory-actions.ts) checks roles,
// protection and the console itself, locks A and B, writes the audit intent, then calls run(). Every AWS call is a
// Cloud method in aws.ts, granted by hand-written statements (OpenSecurityGroups…, ServiceConnect…).
import "server-only";
import { addressOf, connectPlan, disconnectPlan, openable, ruleNote, ruleState, scNameFor, sourceGroup, varNameFor, type ConnectFacts, type Target } from "../../connect.ts";
import { nameProblem } from "../../envvars.ts";
import type { Resource } from "../../inventory/types.ts";
import type { EnvInfo, RawSecurityGroup, RawService } from "../../types.ts";
import { invalidate } from "../cache.ts";
import { catalog, inRegion, listEnvs, metaOf, servicesOf } from "../discovery.ts";
import { HttpError } from "../errors.ts";
import type { Plan } from "../ops/types.ts";
import { cloudFor } from "../sources.ts";
import { ecsServiceTags } from "./ecs-image.ts";
import { field } from "./edge-util.ts";
import type { ActionContext, Provider, ProviderAction } from "./types.ts";

type In = { to: string; variable?: string };
const SERVICE_KEY = /^ecs:service\/([^/@]+)\/([^/@]+)(?:@([a-z0-9-]+))?$/;
const STORE_KEY = /^(rds|elasticache):([^@/]+)(?:@([a-z0-9-]+))?$/;
const rollingOut = (s: RawService) => s.deployments.some((d) => d.rolloutState === "IN_PROGRESS");
// Host or bridge networking: its tasks use the EC2 host's network and security groups.
const onHost = (s: RawService) => !s.subnets.length;

async function serviceEnv(key: string, ctx: ActionContext): Promise<{ env: EnvInfo; service: string }> {
  const m = SERVICE_KEY.exec(key);
  if (!m) throw new HttpError(400, "not an ECS service");
  const region = m[3] ?? ctx.region;
  const env = (await listEnvs()).find((e) => e.cluster === m[1] && e.region === region);
  if (!env) throw new HttpError(404, `cluster ${m[1]} in ${region} isn't an environment the console discovered`);
  return { env, service: m[2] };
}

interface Side {
  name: string;
  groups: string[]; // its tasks' security groups (an EC2 host's, for host networking)
  tags: Record<string, string>;
}
interface Facts {
  env: EnvInfo;
  a: RawService;
  container: string;
  target: Target;
  b: Side & { service?: RawService; groupObjects: RawSecurityGroup[] };
  plan: ConnectFacts;
  address: string;
  variable: string;
  portName?: string;
  namespace?: string;
}

async function facts(r: Resource, i: In, ctx: ActionContext): Promise<Facts> {
  const { env, service } = await serviceEnv(r.key, ctx);
  invalidate(`svc:${inRegion(env.cluster, env.region)}`);
  const [svcs, cat, cloud] = await Promise.all([servicesOf(env.cluster, env.region), catalog(env.id), cloudFor(env)]);
  const a = svcs.find((s) => s.name === service);
  if (!a) throw new HttpError(404, `service "${service}" not found in ${env.cluster}`);
  if ((await metaOf(env, a)).self) throw new HttpError(409, "This is the console itself — it never changes its own service.");
  if (rollingOut(a)) throw new HttpError(409, `a rollout of ${a.name} is in progress — wait for it to finish`);
  const td = a.taskDef;
  if (!td) throw new HttpError(409, `${a.name} has no task definition to add a variable to`);
  // A host-networked task's traffic leaves with its host's groups; one placed nowhere yet may land on any host.
  const hostsOf = (s: RawService) => {
    const placed = new Set(s.tasks.map((t) => t.host).filter((h): h is string => !!h));
    return cat.hosts.filter((h) => !placed.size || placed.has(h.id));
  };
  const groupsOf = (s: RawService) => (onHost(s) ? [...new Set(hostsOf(s).flatMap((h) => h.securityGroups))] : s.securityGroups);

  let target: Target;
  let b: Side & { service?: RawService };
  let bSc: Awaited<ReturnType<typeof cloud.serviceConnectOf>> = null;
  const m = SERVICE_KEY.exec(i.to);
  const store = STORE_KEY.exec(i.to);
  if (m) {
    if (m[1] !== env.cluster || (m[3] ?? ctx.region) !== env.region) throw new HttpError(400, `${m[2]} isn't in ${env.id}: connect services of one environment`);
    const s = svcs.find((x) => x.name === m[2]);
    if (!s) throw new HttpError(404, `service "${m[2]}" not found in ${env.cluster}`);
    if (s.name === a.name) throw new HttpError(400, "a service can't be connected to itself");
    if ((await metaOf(env, s)).self) throw new HttpError(409, "That's the console itself — it never changes its own service.");
    const port = s.taskDef?.containers.find((c) => c.name === s.taskDef?.main)?.ports[0] ?? s.taskDef?.ports[0];
    if (!port) throw new HttpError(409, `${s.name} listens on no port (its task definition maps none)`);
    const shared = new Set(hostsOf(a).map((h) => h.id));
    const sameHost = onHost(a) && onHost(s) && hostsOf(s).some((h) => shared.has(h.id)) && hostsOf(s).length === 1 && shared.size === 1;
    bSc = sameHost ? null : await cloud.serviceConnectOf(env.cluster, s.name);
    target = { kind: "service", name: s.name, port, sameHost, dnsName: bSc?.services.find((x) => x.port === port)?.dnsName };
    b = { name: s.name, groups: groupsOf(s), tags: s.tags, service: s };
  } else if (store) {
    const id = store[2];
    if ((store[3] ?? ctx.region) !== env.region) throw new HttpError(400, `${id} isn't in ${env.region}`);
    if (store[1] === "rds") {
      const d = cat.databases.find((x) => x.id === id);
      if (!d) throw new HttpError(404, `database ${id} isn't one of ${env.id}'s`);
      if (!d.endpoint || !d.port) throw new HttpError(409, `${id} has no endpoint yet (status ${d.status})`);
      target = { kind: "database", name: d.id, engine: d.engine, endpoint: d.endpoint, port: d.port };
      b = { name: d.id, groups: d.securityGroups, tags: d.tags };
    } else {
      const c = cat.caches.find((x) => x.id === id);
      if (!c) throw new HttpError(404, `cache ${id} isn't one of ${env.id}'s`);
      if (!c.endpoint || !c.port) throw new HttpError(409, `${id} has no endpoint yet (status ${c.status})`);
      target = { kind: "cache", name: c.id, engine: c.engine, endpoint: c.endpoint, port: c.port, tls: c.transitEncryption };
      b = { name: c.id, groups: c.securityGroups, tags: c.tags ?? {} };
    }
  } else throw new HttpError(400, "`to` must be the key of an ECS service, an RDS database or an ElastiCache cache on the map (ecs:service/…, rds:…, elasticache:…)");
  // A rule naming another group works inside one VPC; protection is the stricter side's (the runner checked A's).
  if (b.tags["console:protected"] === "true" && !env.protected) throw new HttpError(403, `${b.name} is protected and ${a.name} isn't: connect it from your infrastructure code, or ask an admin to`);

  const aGroups = groupsOf(a);
  const groupObjects = b.groups.length || aGroups.length ? await cloud.securityGroups([...new Set([...b.groups, ...aGroups])]) : [];
  const vpcOf = (g: string) => groupObjects.find((x) => x.id === g)?.vpcId;
  const bGroupObjects = groupObjects.filter((g) => b.groups.includes(g.id));
  const sameHost = target.kind === "service" && target.sameHost;
  if (!sameHost) {
    if (!aGroups.length) throw new HttpError(409, `${a.name} runs in no security group the console can see`);
    if (!b.groups.length) throw new HttpError(409, `${b.name} has no security group to add a rule to`);
    if (vpcOf(aGroups[0]) && vpcOf(b.groups[0]) && vpcOf(aGroups[0]) !== vpcOf(b.groups[0])) throw new HttpError(409, `${a.name} and ${b.name} are in different VPCs: a rule in ${b.name}'s group can't name ${a.name}'s`);
  }
  const others = (g: string) => [
    ...svcs.filter((s) => s.name !== a.name && groupsOf(s).includes(g)).map((s) => s.name),
    ...(onHost(a) ? [] : cat.hosts.filter((h) => h.securityGroups.includes(g)).map((h) => h.name)),
  ];
  const source = sourceGroup(aGroups, others);
  const bGroup = bGroupObjects[0] ?? (b.groups[0] ? { id: b.groups[0], name: "", inbound: [] } : undefined);

  // Service Connect, for a service reached across the network: both need awsvpc (not host networking).
  let sc: ConnectFacts["serviceConnect"];
  let portName: string | undefined;
  let namespace: string | undefined;
  if (target.kind === "service" && !target.sameHost) {
    if (onHost(a) || onHost(b.service!)) throw new HttpError(409, `Service Connect needs awsvpc networking, and ${onHost(a) ? a.name : b.name} uses its EC2 host's network — connect them in your infrastructure code`);
    const aSc = await cloud.serviceConnectOf(env.cluster, a.name);
    if (aSc?.namespace && bSc?.namespace && aSc.namespace !== bSc.namespace) throw new HttpError(409, `${a.name} and ${b.name} use different Service Connect namespaces (${aSc.namespace}, ${bSc.namespace}): a service belongs to one`);
    const known = bSc?.namespace ?? aSc?.namespace ?? (await cloud.clusterNamespace(env.cluster)) ?? (await cloud.findNamespace(env.cluster));
    namespace = known ?? env.cluster;
    const bTd = b.service!.taskDef!;
    const named = bTd.containers.find((c) => c.name === bTd.main)?.portNames?.[String(target.port)];
    portName = named ?? `port-${target.port}`;
    const exposes = !!bSc?.services.some((x) => x.port === target.port || x.portName === portName);
    sc = { namespace: { name: namespace, exists: !!known }, b: { exposes, portName, rename: !exposes && !named }, aClient: !!aSc };
  }

  const variable = i.variable ?? varNameFor(b.name);
  const bad = nameProblem(variable);
  if (bad) throw new HttpError(400, bad);
  const container = td.main;
  const env0 = (await cloud.containerEnv(td.arn)).find((c) => c.container === container);
  if (env0?.secrets.some((x) => x.name === variable)) throw new HttpError(409, `${a.name} already has a secret named ${variable}: pick another variable name`);
  const current = env0?.environment.find((x) => x.name === variable)?.value;
  const address = addressOf(target);
  if (current !== undefined && current !== address) throw new HttpError(409, `${a.name} already has ${variable} with another value: pick another variable name, or change it in its Variables tab`);

  return {
    env, a, container, target, b: { ...b, groupObjects: bGroupObjects }, address, variable, portName, namespace,
    plan: {
      env: env.id,
      a: { name: a.name, container, groups: aGroups },
      b: { ...target, ...(bGroup ? { group: { id: bGroup.id, openable: openable(bGroup) } } : {}) },
      source, rule: ruleState(bGroupObjects, aGroups, target.port), variable: { name: variable, current }, serviceConnect: sc,
    },
  };
}

const asPlan = (p: { summary: string; changes: string[]; warnings: string[] }): Plan => ({ summary: p.summary, changes: p.changes, warnings: p.warnings });

// After a change: the services, events and discovery (security-group and variable edges) are read again.
function reread(f: Facts) {
  invalidate(`svc:${inRegion(f.env.cluster, f.env.region)}`);
  invalidate(`events:${inRegion(f.env.cluster, f.env.region)}:${f.a.name}`);
  invalidate("discovery:inventory");
}

// A's main container's variables, with `name` set to `value` (or removed when undefined) → a new revision.
async function withVariable(f: Facts, value: string | undefined): Promise<string> {
  const cloud = await cloudFor(f.env);
  const cur = (await cloud.containerEnv(f.a.taskDef!.arn)).find((c) => c.container === f.container);
  const environment = [...(cur?.environment ?? []).filter((x) => x.name !== f.variable), ...(value === undefined ? [] : [{ name: f.variable, value }])];
  return cloud.registerWithEnv(f.a.taskDef!.arn, [{ container: f.container, environment }]);
}

const INPUT = {
  to: field({ type: "string", title: "Service, database or cache", minLength: 3, maxLength: 512, description: "The map key of the service, RDS database or ElastiCache cache to reach (ecs:service/…, rds:…, elasticache:…), in the same environment." }),
  variable: field({ type: "string", title: "Variable name (optional)", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,254}$", description: "The variable that holds its address on this service. Default: its name in capitals with _URL (ACME_PRODUCTION_PG_URL)." }),
};

const connect: ProviderAction<In> = {
  id: "connect", kind: "ecs-service", title: "Connect to",
  summary: "Lets this service reach another service, a database or a cache: their security group admits it, and it gets a variable with the address.",
  description:
    "Connects this ECS service (A) to another service, an RDS database or an ElastiCache cache (B, `to`) of the same environment and VPC, planned as one change: (1) B's security group gets an inbound rule admitting one of A's security groups on B's port (one only A uses when there is one), described \"deployment-console: A to B\" — unless B already admits A, or both run on the same EC2 host with host networking; (2) A gets a variable (default <B>_URL) holding B's address: a database or cache endpoint (no credentials), or for a service its ECS Service Connect name http://<name>:<port> — Service Connect is turned on for B (a new deployment; its port mapping is named first when it has no name; the environment's Cloud Map namespace, named after the cluster, is created when missing) and A joins the namespace as a client. A's change is a new task definition revision and a rolling deployment. Refuses: the console's own service, services mid-rollout, B in another environment or VPC, B protected while A isn't, a variable name A already uses for something else, Service Connect with host networking. The shipped IAM policy opens only security groups the console created or tagged console:connect=allow (the plan warns). Returns what was changed.",
  risk: "danger", perm: "provision", // opens a network path and redeploys services: an agent's request always needs a person
  iam: ["ec2:AuthorizeSecurityGroupIngress", "ecs:RegisterTaskDefinition", "ecs:UpdateService", "iam:PassRole", "servicediscovery:CreateHttpNamespace"],
  undo: "Disconnect removes the console's rule and the variable (Service Connect stays on); if a step fails, what was done before it stays until you disconnect",
  retrySafe: false, // F31: a second run registers another revision and starts another deployment
  verifies: "The map draws the connection at once; A's new tasks have the variable when its deployment completes",
  input: { type: "object", additionalProperties: false, required: ["to"], properties: INPUT },
  // R04: A (the resource) and B, whose security group or service changes too.
  targets: (_r, i) => [i.to],
  async plan(r, i, ctx) {
    return asPlan(connectPlan((await facts(r, i, ctx)).plan));
  },
  async run(r, i, ctx) {
    // Under the runner's lock on A and B: read everything again and decide again.
    const f = await facts(r, i, ctx);
    const plan = connectPlan(f.plan);
    if (!plan.steps.rule && !plan.steps.variable && !plan.steps.serviceConnect) throw new HttpError(409, `${f.a.name} is already connected to ${f.b.name}`);
    const cloud = await cloudFor(f.env);
    const out: Record<string, unknown> = { from: f.a.name, to: f.b.name, variable: f.variable, address: f.address };
    try {
      if (plan.steps.rule) {
        const group = f.plan.b.group!.id;
        out.rule = await cloud.authorizeIngress(group, { port: f.target.port, fromGroup: f.plan.source!.group, description: ruleNote(f.a.name, f.b.name) });
        out.securityGroup = group;
      }
      const sc = f.plan.serviceConnect;
      let ns = f.namespace;
      if (sc && ns) {
        // B first: A's new tasks resolve only the names that exist when they start.
        if (!sc.namespace.exists) ns = out.namespace = await cloud.createNamespace(ns, { "console:created": "true", "console:created-from": f.env.cluster });
        if (!sc.b.exposes) {
          const b = f.b.service!;
          const taskDefinition = sc.b.rename ? await cloud.registerWithPortName(b.taskDef!.arn, b.taskDef!.main, f.target.port, f.portName!) : undefined;
          await cloud.enableServiceConnect(f.env.cluster, b.name, { namespace: ns, expose: { portName: f.portName!, name: scNameFor(b.name), port: f.target.port }, taskDefinition });
          out.serviceConnect = `${b.name} answers at ${f.address}`;
        }
      }
      const taskDefinition = plan.steps.variable ? await withVariable(f, f.address) : undefined;
      if (sc && ns && !sc.aClient) await cloud.enableServiceConnect(f.env.cluster, f.a.name, { namespace: ns, taskDefinition });
      else if (taskDefinition) await cloud.updateService(f.env.cluster, f.a.name, { taskDefinition });
      if (taskDefinition) out.taskDefinition = taskDefinition;
      return out;
    } finally {
      reread(f);
    }
  },
};

const disconnect: ProviderAction<In> = {
  id: "disconnect", kind: "ecs-service", title: "Disconnect from",
  summary: "Undoes Connect: removes the console's rule from the other side's security group and the variable it added here.",
  description:
    "Undoes Connect to between this ECS service (A) and `to` (B): removes the inbound rule the console added to B's security group (only a rule whose description is the console's \"deployment-console: A to B\"; a team's own rule stays), and removes A's variable (default <B>_URL) while it still holds B's address — a new task definition revision and a rolling deployment. Service Connect stays on for both (other services may use it). Refuses when nothing the console made connects them. Returns what was removed.",
  risk: "danger", perm: "provision",
  iam: ["ec2:RevokeSecurityGroupIngress", "ecs:RegisterTaskDefinition", "ecs:UpdateService", "iam:PassRole"],
  undo: "Connect to again",
  retrySafe: false,
  verifies: "The map stops drawing the connection; A's new tasks lack the variable when its deployment completes",
  input: { type: "object", additionalProperties: false, required: ["to"], properties: INPUT },
  targets: (_r, i) => [i.to],
  async plan(r, i, ctx) {
    const f = await facts(r, i, ctx);
    const p = disconnectPlan({ env: f.env.id, a: { name: f.a.name }, b: f.target, rule: f.plan.rule, variable: f.plan.variable });
    if (p.nothing) throw new HttpError(409, `nothing the console made connects ${f.a.name} to ${f.b.name}`);
    return asPlan(p);
  },
  async run(r, i, ctx) {
    const f = await facts(r, i, ctx);
    const p = disconnectPlan({ env: f.env.id, a: { name: f.a.name }, b: f.target, rule: f.plan.rule, variable: f.plan.variable });
    if (p.nothing) throw new HttpError(409, `nothing the console made connects ${f.a.name} to ${f.b.name}`);
    const cloud = await cloudFor(f.env);
    const out: Record<string, unknown> = { from: f.a.name, to: f.b.name };
    try {
      if (p.steps.rule) {
        const allowed = f.plan.rule.allowed!;
        await cloud.revokeIngress(allowed.group, { port: f.target.port, fromGroup: allowed.source });
        out.ruleRemoved = allowed.rule;
      }
      if (p.steps.variable) {
        const taskDefinition = await withVariable(f, undefined);
        await cloud.updateService(f.env.cluster, f.a.name, { taskDefinition });
        out.variableRemoved = f.variable;
        out.taskDefinition = taskDefinition;
      }
      return out;
    } finally {
      reread(f);
    }
  },
};

export const ecsConnectProvider: Provider = {
  id: "ecs-connect",
  label: "ECS connections",
  scope: "home", // no discovery of its own; its actions work on the ecs provider's services in any region
  kinds: [],
  read: [],
  // The Cloud Map calls ECS makes for Service Connect on the caller's behalf are granted beside these by hand
  // (ServiceConnectThroughEcs), in the full policy only.
  write: ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress", "ecs:RegisterTaskDefinition", "ecs:UpdateService", "servicediscovery:CreateHttpNamespace"],
  implicit: ["iam:PassRole"],
  async discover() {
    return { resources: [], links: [], mentions: [] };
  },
  authoritative: ecsServiceTags,
  actions: [connect as ProviderAction, disconnect as ProviderAction],
};
