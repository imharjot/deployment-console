// Cross-resource rules, pure: run after infer() and before assignEnvs(), they let one resource's state show on the
// resources it affects — an alarm in ALARM on what it watches, a KMS key pending deletion on what it encrypts, an
// expiring certificate, a database reachable from the internet (audit §6 D.6, rules R1–R9). They never lower a
// resource's health: they raise it, append to healthReason, and add evidence (and, for exposure, an
// `external:internet` edge). They read `facts`, which only a resource's own provider sets (types.ts lists the names).
//
// R1 alarms (scaling alarms excluded) · R2 KMS keys · R3 certificates · R4 exposure · R5 secrets scheduled for deletion
// · R6 vpcId from subnets · R7 unused (idle) · R8 Cloud Map without instances · R9 backups · R10 untouched default VPCs
// (hidden: the one rule that changes what is drawn rather than health).
import { arnCandidates } from "./infer.ts";
import { parseArn } from "./arn.ts";
import { categoryOf, isSupport, keys, type Edge, type EdgeKind, type Health, type Resource } from "./types.ts";

export interface PropagateInput {
  resources: Resource[];
  edges: Edge[];
  home?: string; // the home region (region-less keys live there)
  now?: number; // for the time rules (certificate expiry, backup age); Date.now() by default
  accountId?: string; // the console's account, for resolving the ARNs facts name (else the one most ARNs name)
}

export interface Propagated {
  resources: Resource[];
  edges: Edge[];
  notes: string[]; // one line per rule that couldn't be applied ("R4: 3 subnets unknown — counted as routed to the internet")
}

const DAY = 86_400_000;
const RANK: Record<Health, number> = { ok: 0, unknown: 0, stopped: 1, warning: 2, error: 3 };
const INTERNET = keys.external("internet");
const READS_SECRET = new Set<EdgeKind>(["reads", "uses"]);

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : []);
// A time fact: epoch ms (or seconds), or an ISO string.
function ms(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
}
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---------- ports ("5432/tcp", "1024-65535/tcp", "all") ----------

interface Range { from: number; to: number; proto: string } // proto "tcp" | "udp" | "all"
type Ports = Range[] | "all";

// One entry of openIngress / cidrIngress / naclOpen. ICMP and other port-less protocols say nothing about a port.
function parsePorts(entry: string): Ports | undefined {
  const s = entry.trim().toLowerCase();
  if (s === "all" || s === "-1" || s === "-1/all") return "all";
  const m = /^(\d{1,5})(?:-(\d{1,5}))?(?:\/([a-z0-9-]+))?$/.exec(s);
  if (!m) return undefined;
  const proto = m[3] === undefined || m[3] === "-1" || m[3] === "all" ? "all" : m[3];
  if (proto !== "all" && proto !== "tcp" && proto !== "udp" && proto !== "6" && proto !== "17") return undefined;
  const from = Number(m[1]), to = m[2] === undefined ? from : Number(m[2]);
  return [{ from: Math.min(from, to), to: Math.max(from, to), proto: proto === "6" ? "tcp" : proto === "17" ? "udp" : proto }];
}
const protoMatch = (a: string, b: string) => a === "all" || b === "all" || a === b;
function intersect(a: Ports, b: Ports): Ports {
  if (a === "all") return b;
  if (b === "all") return a;
  const out: Range[] = [];
  for (const x of a) for (const y of b) {
    if (!protoMatch(x.proto, y.proto)) continue;
    const from = Math.max(x.from, y.from), to = Math.min(x.to, y.to);
    if (from <= to) out.push({ from, to, proto: x.proto === "all" ? y.proto : x.proto });
  }
  return out;
}
const empty = (p: Ports) => p !== "all" && p.length === 0;
const portLabel = (p: Ports) => (p === "all" ? "all ports" : p.map((r) => `${r.from === r.to ? r.from : `${r.from}-${r.to}`}/${r.proto === "all" ? "any" : r.proto}`).join(", "));
// Web ports open to the world are the point of an internet-facing load balancer, not a finding.
const webOnly = (p: Ports) => p !== "all" && p.every((r) => r.from === r.to && (r.from === 80 || r.from === 443));
// A NACL's naclOpen list; unknown (no fact) counts as open.
function naclPorts(v: unknown): Ports {
  if (v === undefined) return "all";
  const parsed = list(v).map(parsePorts).filter((p): p is Ports => !!p);
  return parsed.some((p) => p === "all") ? "all" : parsed.flatMap((p) => p as Range[]);
}

// ---------- CIDRs ----------

function cidr(s: string): { base: number; bits: number } | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s.trim());
  if (!m) return undefined;
  const o = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (o.some((x) => x > 255) || bits > 32) return undefined;
  const ip = ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, bits };
}
// `inner` lies inside `outer` (a rule naming a VPC's CIDR or one of its subnets).
function within(inner: string, outer: string): boolean {
  const a = cidr(inner), b = cidr(outer);
  if (!a || !b || a.bits < b.bits) return false;
  const mask = b.bits === 0 ? 0 : (0xffffffff << (32 - b.bits)) >>> 0;
  return ((a.base & mask) >>> 0) === b.base;
}
// A VPC's CIDR blocks: facts.cidrs / facts.cidr, else a "CIDR…" prop.
function vpcCidrs(r: Resource): string[] {
  const facts = [...list(r.facts?.cidrs), ...list(r.facts?.cidr)];
  if (facts.length) return facts;
  return r.props.filter((p) => /cidr/i.test(p.label)).flatMap((p) => p.value.split(/[\s,;]+/)).filter((x) => !!cidr(x));
}

// ---------- the rules ----------

const idOf = (r: Resource) => parseArn(r.key)?.id.split("/").pop() ?? r.key.split(/[:/]/).pop() ?? r.key;

export function propagate(input: PropagateInput): Propagated {
  const now = input.now ?? Date.now();
  const notes: string[] = [];
  const resources = input.resources.map((r) => ({ ...r }));
  const byKey = new Map(resources.map((r) => [r.key, r]));
  const edges = input.edges.map((e) => ({ ...e, evidence: [...e.evidence] }));
  const byId = new Map(edges.map((e) => [e.id, e]));
  const outOf = new Map<string, Edge[]>(), into = new Map<string, Edge[]>();
  for (const e of edges) {
    outOf.set(e.from, [...(outOf.get(e.from) ?? []), e]);
    into.set(e.to, [...(into.get(e.to) ?? []), e]);
  }
  const out = (key: string, kind?: EdgeKind) => (outOf.get(key) ?? []).filter((e) => !kind || e.kind === kind);

  // Raise to at least `health` (never lower) and append the reason once.
  const raise = (r: Resource | undefined, health: "warning" | "error", reason: string) => {
    if (!r) return;
    if (RANK[health] > RANK[r.health]) r.health = health;
    const had = r.healthReason ? r.healthReason.split(" · ") : [];
    if (!had.includes(reason)) r.healthReason = [...had, reason].join(" · ");
  };
  const evidence = (e: Edge | undefined, line: string) => {
    if (e && !e.evidence.includes(line)) e.evidence = [...e.evidence, line].slice(0, 8);
  };
  const addEdge = (e: Omit<Edge, "id">) => {
    const id = `${e.from}->${e.to}:${e.kind}`;
    const had = byId.get(id);
    if (had) {
      for (const line of e.evidence) evidence(had, line);
      return had;
    }
    const edge: Edge = { id, ...e };
    if (!edge.label) delete edge.label;
    edges.push(edge);
    byId.set(id, edge);
    return edge;
  };
  const ofKind = (kind: Resource["kind"]) => resources.filter((r) => r.kind === kind);
  const byNetId = (kind: Resource["kind"]) => {
    const m = new Map<string, Resource>();
    for (const r of ofKind(kind)) for (const id of [idOf(r), ...(r.aliases ?? [])]) if (id && !id.startsWith("arn:")) m.set(id, r);
    return m;
  };

  // R6 — vpcId from subnets (first, so the exposure rule knows which VPC a resource is in).
  const subnets = byNetId("subnet");
  for (const r of resources) {
    if (r.vpcId || !r.subnetIds?.length) continue;
    for (const s of r.subnetIds.map((id) => subnets.get(id))) {
      const vpc = s?.vpcId ?? (s?.parent ? parseArn(s.parent)?.id.split("/").pop() : undefined);
      if (vpc) {
        r.vpcId = vpc;
        break;
      }
    }
  }

  // R1 — a non-scaling alarm in ALARM warns what it watches (target tracking's AlarmLow sits in ALARM whenever load is low).
  // A composite alarm's monitors links point at its child alarms: those aren't raised (with OR rules the OK children
  // didn't fire, and the one that did is in ALARM itself).
  for (const a of ofKind("cloudwatch-alarm")) {
    if (str(a.facts?.alarmState).toUpperCase() !== "ALARM" || a.facts?.scaling === true) continue;
    for (const e of out(a.key, "monitors")) {
      if (e.label === "scales" || byKey.get(e.to)?.kind === "cloudwatch-alarm") continue;
      raise(byKey.get(e.to), "warning", `alarm ${a.name} is in ALARM`);
      evidence(e, "in ALARM");
    }
  }

  // R2 — a KMS key pending deletion (error inside 7 days) or disabled warns what it encrypts.
  for (const k of ofKind("kms-key")) {
    const state = str(k.facts?.state).toLowerCase();
    let sev: "warning" | "error" | undefined, why = "";
    if (state.includes("pendingdeletion") || state.includes("pending deletion") || state.includes("pendingreplicadeletion")) {
      const at = ms(k.facts?.deletionDate);
      const left = at === undefined ? undefined : Math.ceil((at - now) / DAY);
      sev = left !== undefined && left < 7 ? "error" : "warning";
      why = `KMS key ${k.name} is pending deletion${at === undefined ? "" : ` (deleted ${day(at)}${left !== undefined && left >= 0 ? `, in ${plural(left, "day")}` : ""})`}`;
    } else if (state === "disabled") {
      sev = "warning";
      why = `KMS key ${k.name} is disabled`;
    }
    if (!sev) continue;
    for (const e of out(k.key, "encrypts")) {
      raise(byKey.get(e.to), sev, why);
      evidence(e, why);
    }
  }

  // R3 — a certificate that expired or expires within 7 days (error), or within 30 days without auto-renewal (warning).
  for (const c of ofKind("acm-certificate")) {
    const end = ms(c.facts?.notAfter);
    const expired = str(c.facts?.state).toUpperCase() === "EXPIRED" || (end !== undefined && end <= now);
    const left = end === undefined ? undefined : Math.floor((end - now) / DAY);
    const auto = c.facts?.autoRenew === true || /^eligible$/i.test(str(c.facts?.autoRenew));
    let sev: "warning" | "error" | undefined, why = "";
    if (expired) [sev, why] = ["error", `certificate ${c.name} expired${end === undefined ? "" : ` on ${day(end)}`}`];
    else if (left !== undefined && left <= 7) [sev, why] = ["error", `certificate ${c.name} expires in ${plural(left, "day")}`];
    else if (left !== undefined && left <= 30 && !auto) [sev, why] = ["warning", `certificate ${c.name} expires in ${plural(left, "day")} and won't renew automatically`];
    if (!sev) continue;
    for (const e of out(c.key, "tls")) {
      raise(byKey.get(e.to), sev, why);
      evidence(e, why);
    }
  }

  // R4 — exposure. Reachable from the internet = publicly addressable (facts.public) AND one of its subnets routes to an
  // internet gateway (unknown counts as yes) AND that subnet's NACL lets the port in. A group open to 0.0.0.0/0 on a
  // port other than 80/443 is then an error with an internet → resource edge; open but unreachable is a warning.
  // A rule naming another VPC's CIDR becomes one "allowed" edge from that VPC (via the peering, when there is one).
  const groups = byNetId("security-group");
  const vpcs = ofKind("vpc").map((v) => ({ v, id: idOf(v), cidrs: vpcCidrs(v) })).filter((x) => x.cidrs.length);
  const peerings = ofKind("vpc-peering").map((p) => ({ p, vpcs: new Set([...(outOf.get(p.key) ?? []), ...(into.get(p.key) ?? [])].map((e) => (e.from === p.key ? e.to : e.from))) }));
  const unknownSubnets = new Set<string>();
  const noSubnets = new Set<string>(); // public resources whose subnets nobody reported
  let internetNeeded = false;
  for (const r of resources) {
    if (!r.securityGroups?.length || r.kind === "external" || r.kind === "aws-resource" || isSupport(categoryOf(r))) continue;
    // Which ports the resource's subnets let in from the internet ("all" when a subnet is unknown or has no NACL fact).
    const reachable = (): Ports => {
      if (r.facts?.public !== true) return [];
      if (!r.subnetIds?.length) {
        noSubnets.add(r.key);
        return "all";
      }
      let open: Ports = [];
      for (const id of r.subnetIds) {
        const s = subnets.get(id);
        if (!s || typeof s.facts?.routesToIgw !== "boolean") unknownSubnets.add(id);
        if (s?.facts?.routesToIgw === false) continue;
        const nacl = naclPorts(s?.facts?.naclOpen);
        if (nacl === "all") return "all";
        open = [...(open as Range[]), ...nacl];
      }
      return open;
    };
    // Why an open group isn't an exposure today — only what the facts say (no fact is no claim).
    const unreachable = () =>
      r.facts?.public === true ? "no internet route or network ACL lets it in today"
        : r.facts?.public === false ? "not publicly addressable today"
        : "whether it is publicly addressable is unknown";
    let reach: Ports | undefined;
    const ownVpc = vpcs.find((x) => x.id === r.vpcId);
    const fromVpc = new Map<string, { ports: string[]; evidence: string[]; via?: string }>();
    for (const id of r.securityGroups) {
      const sg = groups.get(id);
      if (!sg) continue;
      // 0.0.0.0/0 and ::/0
      const open = list(sg.facts?.openIngress).map(parsePorts).filter((p): p is Ports => !!p && !webOnly(p));
      if (open.length) {
        const ports: Ports = open.some((p) => p === "all") ? "all" : open.flatMap((p) => p as Range[]);
        reach ??= reachable();
        const hit = intersect(ports, reach);
        if (!empty(hit)) {
          const why = `reachable from the internet on ${portLabel(hit)} (${id} allows 0.0.0.0/0)`;
          raise(r, "error", why);
          internetNeeded = true;
          addEdge({
            from: INTERNET, to: r.key, kind: "http", label: portLabel(hit), confidence: "allowed",
            evidence: [`security group ${id} allows 0.0.0.0/0 on ${portLabel(ports)}`, "publicly addressable", r.subnetIds?.length ? "subnet routes to an internet gateway" : "subnets unknown — counted as routed to the internet"],
          });
        } else raise(r, "warning", `security group ${id} allows 0.0.0.0/0 on ${portLabel(ports)}; ${unreachable()}`);
      }
      // Other VPCs' CIDRs ("5432/tcp<-10.30.0.0/16"); only when the resource's own VPC is known.
      for (const entry of r.vpcId ? list(sg.facts?.cidrIngress) : []) {
        const [port, range] = entry.split("<-");
        if (!range || (ownVpc && ownVpc.cidrs.some((c) => within(range, c)))) continue;
        const peer = vpcs.find((x) => x.id !== r.vpcId && x.cidrs.some((c) => within(range, c)));
        if (!peer) continue;
        const agg = fromVpc.get(peer.v.key) ?? { ports: [], evidence: [] };
        if (!agg.ports.includes(port)) agg.ports.push(port);
        agg.evidence.push(`security group ${id} allows ${range} on ${port}`);
        const ownKey = ownVpc?.v.key;
        const via = peerings.find((x) => x.vpcs.has(peer.v.key) && (!ownKey || x.vpcs.has(ownKey)));
        if (via) agg.via = idOf(via.p);
        fromVpc.set(peer.v.key, agg);
      }
    }
    for (const [vpc, agg] of fromVpc)
      addEdge({
        from: vpc, to: r.key, kind: r.kind === "elasticache" ? "cache" : /^(rds|rds-cluster|rds-proxy|docdb-cluster|neptune-cluster|redshift-)/.test(r.kind) ? "sql" : "http",
        label: `${agg.ports.join(", ")}${agg.via ? ` via ${agg.via}` : ""}`, confidence: "allowed", evidence: [...agg.evidence, ...(agg.via ? [`peering ${agg.via}`] : [])],
      });
  }
  if (internetNeeded && !byKey.has(INTERNET)) {
    const net: Resource = {
      key: INTERNET, kind: "external", provider: "inventory", name: "Internet", region: "global", tags: {}, health: "unknown",
      healthReason: "Anyone on the internet: drawn where a security group lets 0.0.0.0/0 reach something publicly addressable.", props: [],
    };
    resources.push(net);
    byKey.set(INTERNET, net);
  }
  const unknown = [...(unknownSubnets.size ? [`${plural(unknownSubnets.size, "subnet")} unknown`] : []), ...(noSubnets.size ? [`${plural(noSubnets.size, "public resource")} without known subnets`] : [])];
  if (unknown.length) notes.push(`R4: ${unknown.join(", ")} — counted as routed to the internet`);

  // R5 — a secret scheduled for deletion warns whatever reads it.
  for (const s of ofKind("secret")) {
    const at = ms(s.facts?.deletionDate);
    if (at === undefined && !/delet/i.test(str(s.facts?.state))) continue;
    const why = `reads secret ${s.name}, which is scheduled for deletion${at === undefined ? "" : ` on ${day(at)}`}`;
    for (const e of into.get(s.key) ?? []) {
      if (!READS_SECRET.has(e.kind)) continue; // a key that encrypts it or a stack that manages it doesn't read it
      raise(byKey.get(e.from), "warning", why);
      evidence(e, "scheduled for deletion");
    }
  }

  // R7 — unused: a security group nothing uses or references (not a default one), a certificate no service uses, a WAF
  // ACL that protects nothing, an IAM role never used. Idle, not unhealthy.
  const zero = (v: unknown) => v === 0 || v === "0" || (Array.isArray(v) && v.length === 0);
  for (const r of resources) {
    if (r.idle) continue;
    let why: string | undefined;
    if (r.kind === "security-group" && zero(r.facts?.attachments) && zero(r.facts?.referencedBy) && r.facts?.isDefault !== true)
      why = "no network interface uses it and no other group references it";
    else if (r.kind === "acm-certificate" && r.facts?.inUse === false) why = "no AWS service uses it";
    else if (r.kind === "waf-acl" && !out(r.key, "protects").length) why = "protects nothing";
    else if (r.kind === "iam-role" && r.facts?.neverUsed === true) why = "never used";
    if (why) r.idle = { why };
  }

  // R10 — an untouched default VPC: AWS creates one in every region, with a subnet per zone, an internet gateway and a
  // default security group. When nothing else sits in it and no network interface uses its default group, it and they
  // are hidden (listed, not drawn): reading every enabled region would otherwise add one to the map per empty region.
  // A default group whose network interfaces weren't read keeps the VPC drawn.
  const inVpc = new Map<string, Resource[]>();
  for (const r of resources) if (r.vpcId && r.kind !== "vpc") inVpc.set(r.vpcId, [...(inVpc.get(r.vpcId) ?? []), r]);
  const scaffolding = (r: Resource) =>
    r.kind === "subnet" || r.kind === "internet-gateway" || (r.kind === "security-group" && r.facts?.isDefault === true && zero(r.facts?.attachments));
  for (const v of ofKind("vpc")) {
    const inside = inVpc.get(idOf(v)) ?? [];
    if (v.facts?.isDefault !== true || !inside.some((r) => r.kind === "security-group") || !inside.every(scaffolding)) continue;
    for (const r of [v, ...inside]) r.hidden = true;
  }

  // R8 — a Cloud Map service with no instances while its ECS service wants tasks: discovery can't find them.
  for (const c of ofKind("cloudmap-service")) {
    const none = c.facts?.instances === 0 || (c.health === "stopped" && /no instances/i.test(c.healthReason ?? ""));
    if (!none) continue;
    for (const e of [...out(c.key), ...(into.get(c.key) ?? [])]) {
      const svc = byKey.get(e.from === c.key ? e.to : e.from);
      if (svc?.kind !== "ecs-service") continue;
      const tasks = /^(\d+)\s*\/\s*(\d+)/.exec(svc.props.find((p) => p.label === "Tasks")?.value ?? "");
      const desired = typeof svc.facts?.desired === "number" ? svc.facts.desired : tasks ? Number(tasks[2]) : undefined;
      if (desired && desired > 0) raise(c, "warning", `no instances registered while ${svc.name} wants ${plural(desired, "task")}`);
    }
  }

  // R9 — backups: the latest recovery point of each protected resource, from its plans' and vaults' facts.lastBackups
  // ("<arn>|<iso>|<state>"): failed, or older than 2 days → warning.
  const account = input.accountId ?? mostCommonAccount(resources);
  const byArn = new Map<string, string>();
  for (const r of resources) for (const a of [r.key, ...(r.aliases ?? [])]) if (a.startsWith("arn:") && !byArn.has(a)) byArn.set(a, r.key);
  const resolve = (arn: string) => {
    for (const c of arnCandidates(arn, input.home, account)) {
      if (byKey.has(c)) return c;
      if (byArn.has(c)) return byArn.get(c);
    }
    return undefined;
  };
  const latest = new Map<string, { at: number; state: string; from: string }>();
  for (const b of resources) {
    if (b.kind !== "backup-plan" && b.kind !== "backup-vault") continue;
    for (const line of list(b.facts?.lastBackups)) {
      const [arn, iso, state = ""] = line.split("|");
      const at = ms(iso), key = arn ? resolve(arn) : undefined;
      if (!key || at === undefined || IN_PROGRESS.test(state)) continue;
      const had = latest.get(key);
      if (!had || at > had.at) latest.set(key, { at, state: state.toUpperCase(), from: b.key });
    }
  }
  for (const [key, b] of latest) {
    const r = byKey.get(key);
    const age = Math.floor((now - b.at) / DAY);
    const why = b.state && !SUCCEEDED.has(b.state) ? `last backup ${b.state.toLowerCase()} (${day(b.at)})` : age >= 2 ? `last backup ${plural(age, "day")} ago (${day(b.at)})` : undefined;
    if (!why) continue;
    raise(r, "warning", why);
    evidence((outOf.get(b.from) ?? []).find((e) => e.to === key), why);
  }

  return { resources, edges, notes };
}

// Backup job states (CREATED, PENDING, RUNNING, ABORTING) and recovery-point statuses (CREATING) still in flight;
// COMPLETED (a job) and AVAILABLE (a recovery point) are good backups; anything else (FAILED, ABORTED, PARTIAL,
// EXPIRED, STOPPED…) is not.
const IN_PROGRESS = /^(created|pending|running|aborting|creating)$/i;
const SUCCEEDED = new Set(["COMPLETED", "AVAILABLE"]);

function mostCommonAccount(resources: Resource[]): string | undefined {
  const n = new Map<string, number>();
  for (const r of resources) for (const a of [r.key, ...(r.aliases ?? [])]) {
    const acct = a.startsWith("arn:") ? parseArn(a)?.account : undefined;
    if (acct && /^\d{12}$/.test(acct)) n.set(acct, (n.get(acct) ?? 0) + 1);
  }
  return [...n].sort((x, y) => y[1] - x[1])[0]?.[0];
}
