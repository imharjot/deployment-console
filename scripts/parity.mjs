#!/usr/bin/env node
// Real-account parity: what a running console shows (GET /api/inventory) against what AWS reports through the AWS CLI
// (read-only calls only) and against an expectations file you write for your account. Generic: nothing about any
// account lives here.
//
//   node scripts/parity.mjs --base http://127.0.0.1:3201 --profile console-readonly --regions eu-west-1,us-east-1 \
//     [--expect expectations.json] [--cookie "<Cookie header>"] [--no-aws] [--wait 150] [--save-envs envs.json]
//
// 1. Reads /api/inventory, waiting (up to --wait seconds) while regions are still merging. Keeps the AWS resources
//    (not external systems, declared workloads or remote references) and counts their ARNs — the key and every ARN
//    alias, qualifiers stripped — per Resource Explorer type and region: the ARN's region, else the resource's own
//    (S3 buckets carry theirs; IAM, CloudFront and the like are "global").
// 2. Asks Resource Explorer the same: `search "region:<r>"` in each region, and "region:global" where the global
//    resources are indexed (the aggregator's region, else us-east-1), grouped by ResourceType. Over 1,000 results it
//    counts per type. A region with no index (or no default view, or a refusal) falls back to the service's own list
//    call for the types in FALLBACK, and says so; other types in that region are not compared.
//    Where the map and Resource Explorer disagree, the service's own list call settles it: Resource Explorer doesn't
//    index AWS-managed KMS keys, Cloud Map namespaces or private hosted zones, and keeps released resources (Elastic
//    IPs) for a while. When the list call agrees with the console it is an info line, not a mismatch.
// 3. Compares per type and region. Types the console folds by design (sub-objects such as rules, snapshots and
//    versions: aws-services.ts visibility "drop") and the expectation file's `ignoreTypes` are listed, not compared.
// 4. Checks the expectations (format below), then prints every mismatch. Exit 0 = parity, 1 = mismatches, 2 = a usage,
//    connection or CLI error.
//
// Expectations (JSON; every part optional):
//   {
//     "counts":    { "<kind>[@<region>]": 3 | { "count": 3, "visible": 1, "hidden": 2, "health": { "warning": 1 } } },
//     "resources": { "<key> | <kind>:<name>[@<region>]": { "health": "error", "notHealth": "error", "reason": "substring",
//                    "env": "production" | null, "hidden": true, "idle": true } },
//     "envs":      { "<key> | <kind>:<name>[@<region>]": "production" | null },   // environment assignments
//     "global":    43,   // Resource Explorer's region:global total; the console must hold as many global ARNs
//     "providers": { "<provider id>": "ok" },
//     "ignoreTypes": { "<Resource Explorer type>": "why it can't match" }
//   }
//   A <kind>:<name> selector must match at least one resource, and every match must satisfy it.
//
// --save-envs writes the environment of every AWS resource the console shows ({ key: env | null }), to keep as the
// "envs" of a later run's expectations once you've checked them.
// Credentials: the AWS CLI's own chain (--profile, else AWS_PROFILE / the default). Nothing is written to AWS.
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { arnBase, arnType, parseArn } from "../src/lib/inventory/arn.ts";
import { infoOf } from "../src/lib/inventory/aws-services.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const usage = (why) => {
  console.error(`parity: ${why}\nusage: node scripts/parity.mjs --base <console URL> [--profile p] [--regions a,b] [--expect file] [--cookie c] [--no-aws] [--wait s] [--save-envs file]`);
  process.exit(2);
};

const BASE = (value("--base") ?? process.env.BASE ?? "").replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+$/.test(BASE)) usage("--base must be the console's origin, e.g. http://127.0.0.1:3201");
const PROFILE = value("--profile");
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const regionsArg = value("--regions")?.split(",").map((s) => s.trim()).filter(Boolean);
if (regionsArg?.some((r) => !REGION.test(r))) usage(`--regions: not a region code in ${regionsArg.join(",")}`);
const WAIT_S = Number(value("--wait") ?? 150);
const COOKIE = value("--cookie") ?? process.env.PARITY_COOKIE;

// ---------- the console ----------

async function inventory() {
  const deadline = Date.now() + WAIT_S * 1000;
  for (;;) {
    let r;
    try {
      r = await fetch(`${BASE}/api/inventory`, { headers: COOKIE ? { cookie: COOKIE } : {} });
    } catch (e) {
      console.error(`parity: can't reach ${BASE}: ${e.cause?.code ?? e.message}`);
      process.exit(2);
    }
    if (r.status === 401 || r.status === 403) usage(`${BASE}/api/inventory answered ${r.status}: run the console with AUTH_MODE=dev on 127.0.0.1, or pass --cookie with a signed-in session`);
    if (!r.ok) usage(`${BASE}/api/inventory answered ${r.status}`);
    const v = await r.json();
    if (!v.partial?.pendingRegions?.length || Date.now() > deadline) return v;
    await new Promise((res) => setTimeout(res, 3000));
  }
}

const SKIP_KINDS = new Set(["external", "workload"]);
const isAws = (r) => !SKIP_KINDS.has(r.kind) && r.source !== "reference" && !r.facts?.remote;

// type@region → Set of ARNs (one resource can hold several: an ElastiCache group and its member clusters).
function consoleCounts(v) {
  const by = new Map();
  for (const r of v.resources.filter(isAws)) {
    for (const name of new Set([r.key, ...(r.aliases ?? [])])) {
      if (!name.startsWith("arn:")) continue;
      const p = parseArn(name);
      if (!p || (v.accountId && p.account && p.account !== v.accountId)) continue;
      const type = r.kind === "aws-resource" && name === r.key && r.resourceType ? r.resourceType : arnType(p);
      // A region-less ARN is global (IAM, CloudFront, an RDS global cluster held as an alias), except an S3 bucket's:
      // Resource Explorer files buckets under their own region, which the resource carries.
      const at = `${type}@${p.region || (p.service === "s3" && r.region) || "global"}`;
      if (!by.has(at)) by.set(at, new Set());
      by.get(at).add(arnBase(name));
    }
  }
  return by;
}

// ---------- AWS (CLI, read-only calls only) ----------

const run = promisify(execFile);
async function aws(region, service, op, extra = []) {
  const argv = [service, op, ...extra, "--region", region, "--output", "json", ...(PROFILE ? ["--profile", PROFILE] : [])];
  const { stdout } = await run("aws", argv, { env: { ...process.env, AWS_PAGER: "" }, maxBuffer: 256 << 20, timeout: 120_000 });
  return stdout.trim() ? JSON.parse(stdout) : {};
}
const short = (e) => String(e.stderr || e.message).trim().split("\n").filter(Boolean).at(-1)?.replace(/^aws: \[ERROR\]: /, "") ?? "failed";

// The service's own list call per type, where Resource Explorer has no index: [service, operation, JMESPath count].
const FALLBACK = {
  "ec2:vpc": ["ec2", "describe-vpcs", "length(Vpcs)"],
  "ec2:subnet": ["ec2", "describe-subnets", "length(Subnets)"],
  "ec2:internet-gateway": ["ec2", "describe-internet-gateways", "length(InternetGateways)"],
  "ec2:natgateway": ["ec2", "describe-nat-gateways", "length(NatGateways[?State!='deleted'])"],
  "ec2:vpc-endpoint": ["ec2", "describe-vpc-endpoints", "length(VpcEndpoints)"],
  "ec2:vpc-peering-connection": ["ec2", "describe-vpc-peering-connections", "length(VpcPeeringConnections[?Status.Code!='deleted'])"],
  "ec2:security-group": ["ec2", "describe-security-groups", "length(SecurityGroups)"],
  "ec2:instance": ["ec2", "describe-instances", "length(Reservations[].Instances[?State.Name!='terminated'][])"],
  "ec2:elastic-ip": ["ec2", "describe-addresses", "length(Addresses)"],
  "ec2:volume": ["ec2", "describe-volumes", "length(Volumes)"],
  "ecr:repository": ["ecr", "describe-repositories", "length(repositories)"],
  "acm:certificate": ["acm", "list-certificates", "length(CertificateSummaryList)", ["--includes", "keyTypes=RSA_1024,RSA_2048,RSA_3072,RSA_4096,EC_prime256v1,EC_secp384r1,EC_secp521r1"]],
  "logs:log-group": ["logs", "describe-log-groups", "length(logGroups)"],
  "kms:key": ["kms", "list-keys", "length(Keys)"],
  "kms:alias": ["kms", "list-aliases", "length(Aliases[?TargetKeyId])"],
  "servicediscovery:namespace": ["servicediscovery", "list-namespaces", "length(Namespaces)"],
  "rds:db": ["rds", "describe-db-instances", "length(DBInstances)"],
  "rds:cluster": ["rds", "describe-db-clusters", "length(DBClusters)"],
  "elasticloadbalancing:loadbalancer/app": ["elbv2", "describe-load-balancers", "length(LoadBalancers[?Type=='application'])"],
  "elasticloadbalancing:loadbalancer/net": ["elbv2", "describe-load-balancers", "length(LoadBalancers[?Type=='network'])"],
  "elasticache:replicationgroup": ["elasticache", "describe-replication-groups", "length(ReplicationGroups)"],
  "elasticache:cluster": ["elasticache", "describe-cache-clusters", "length(CacheClusters)"],
  "lambda:function": ["lambda", "list-functions", "length(Functions)"],
  "sqs:queue": ["sqs", "list-queues", "length(QueueUrls || `[]`)"],
  "sns:topic": ["sns", "list-topics", "length(Topics)"],
  "dynamodb:table": ["dynamodb", "list-tables", "length(TableNames)"],
  "secretsmanager:secret": ["secretsmanager", "list-secrets", "length(SecretList)"],
  "ssm:parameter": ["ssm", "describe-parameters", "length(Parameters)"],
  "ssm:managed-instance": ["ssm", "describe-instance-information", "length(InstanceInformationList)"],
  "cloudwatch:alarm": ["cloudwatch", "describe-alarms", "length(MetricAlarms) + length(CompositeAlarms)"],
  "servicediscovery:service": ["servicediscovery", "list-services", "length(Services)"],
  "states:stateMachine": ["stepfunctions", "list-state-machines", "length(stateMachines)"],
};

// When the map and Resource Explorer disagree, the service's own list call settles it: Resource Explorer doesn't index
// everything (AWS-managed KMS keys and their aliases, Cloud Map namespaces, private hosted zones…), and keeps some
// released resources for a while (Elastic IPs). Global types are asked once, in the first region.
const DIRECT = { ...FALLBACK, "route53:hostedzone": ["route53", "list-hosted-zones", "length(HostedZones)"] };
async function directCount(type, region) {
  const d = DIRECT[type];
  if (!d) return undefined;
  const [svc, op, query, extra = []] = d;
  try {
    return { n: Number(await aws(region, svc, op, [...extra, "--query", query])), how: `${svc} ${op}` };
  } catch {
    return undefined;
  }
}

// Resource Explorer: type@region → count, plus how each region was read.
async function awsCounts(regions) {
  const counts = new Map();
  const how = new Map(); // region → "resource-explorer" | "fallback: …" | "not read: …"
  let indexes = [];
  try {
    indexes = (await aws(regions[0], "resource-explorer-2", "list-indexes")).Indexes ?? [];
  } catch (e) {
    console.log(`note: resource-explorer-2 list-indexes failed (${short(e)}); trying each region's default view`);
  }
  const indexed = (r) => !indexes.length || indexes.some((i) => i.Region === r);
  const aggregator = indexes.find((i) => i.Type === "AGGREGATOR")?.Region;
  const add = (type, region, n) => counts.set(`${type}@${region}`, (counts.get(`${type}@${region}`) ?? 0) + n);

  async function search(region, filter, into) {
    const out = await aws(region, "resource-explorer-2", "search", ["--query-string", filter]);
    if (out.Count?.Complete === false || (out.Resources?.length ?? 0) >= 1000) {
      // Over Resource Explorer's 1,000-result window: count each type the first page named, one query each.
      const types = [...new Set((out.Resources ?? []).map((x) => x.ResourceType))];
      for (const t of types) {
        const c = await aws(region, "resource-explorer-2", "search", ["--query-string", `${filter} resourcetype:${t}`, "--max-results", "1"]);
        into(t, c.Count?.TotalResources ?? 0, c.Count?.Complete !== false);
      }
      return `resource-explorer (counted per type: over 1,000 results; types beyond the first page may be missing)`;
    }
    for (const x of out.Resources ?? []) into(x.ResourceType, 1, true);
    return "resource-explorer";
  }

  for (const region of regions) {
    if (indexed(region)) {
      try {
        how.set(region, await search(region, `region:${region}`, (t, n) => add(t, region, n)));
        continue;
      } catch (e) {
        how.set(region, `fallback: Resource Explorer failed (${short(e)})`);
      }
    } else how.set(region, "fallback: no Resource Explorer index in this region");
    for (const [type, [svc, op, query, extra = []]] of Object.entries(FALLBACK)) {
      try {
        const n = await aws(region, svc, op, [...extra, "--query", query]);
        add(type, region, Number(n) || 0);
      } catch (e) {
        add(type, region, NaN);
        how.set(region, `${how.get(region)}; ${type} not read (${short(e)})`);
      }
    }
  }
  const globalRegion = aggregator ?? "us-east-1";
  let global;
  if (indexed(globalRegion)) {
    try {
      let total = 0;
      how.set("global", await search(globalRegion, "region:global", (t, n) => {
        add(t, "global", n);
        total += n;
      }));
      global = total;
    } catch (e) {
      how.set("global", `not read (${short(e)})`);
    }
  } else how.set("global", `not read: no Resource Explorer index in ${globalRegion}`);
  return { counts, how, global, fallbackTypes: new Set(Object.keys(FALLBACK)) };
}

// ---------- expectations ----------

function select(v, sel) {
  if (v.resources.some((r) => r.key === sel)) return v.resources.filter((r) => r.key === sel);
  const m = /^([a-z0-9-]+):(.+?)(?:@([a-z0-9-]+))?$/.exec(sel);
  if (!m) return [];
  return v.resources.filter((r) => r.kind === m[1] && r.name === m[2] && (!m[3] || r.region === m[3]));
}

function checkExpectations(v, exp, problems) {
  for (const [sel, want] of Object.entries(exp.counts ?? {})) {
    const [kind, region] = sel.split("@");
    const rows = v.resources.filter((r) => r.kind === kind && (!region || r.region === region));
    const w = typeof want === "number" ? { count: want } : want;
    const got = { count: rows.length, visible: rows.filter((r) => !r.hidden).length, hidden: rows.filter((r) => r.hidden).length };
    for (const k of ["count", "visible", "hidden"]) if (w[k] !== undefined && w[k] !== got[k]) problems.push(`counts ${sel}: ${k} ${got[k]}, expected ${w[k]}`);
    for (const [h, n] of Object.entries(w.health ?? {})) {
      const c = rows.filter((r) => r.health === h).length;
      if (c !== n) problems.push(`counts ${sel}: ${c} ${h}, expected ${n}`);
    }
  }
  const one = (sel, test) => {
    const rows = select(v, sel);
    if (!rows.length) return problems.push(`${sel}: not on the map`);
    for (const r of rows) {
      const why = test(r);
      if (why) problems.push(`${r.key}: ${why}`);
    }
  };
  for (const [sel, w] of Object.entries(exp.resources ?? {}))
    one(sel, (r) => {
      if (w.health && r.health !== w.health) return `health ${r.health} (${r.healthReason ?? "no reason"}), expected ${w.health}`;
      if (w.notHealth && r.health === w.notHealth) return `health ${r.health} (${r.healthReason ?? "no reason"}), expected anything else`;
      if (w.reason && !(r.healthReason ?? "").includes(w.reason)) return `reason "${r.healthReason ?? ""}", expected it to say "${w.reason}"`;
      if (w.hidden !== undefined && !!r.hidden !== w.hidden) return w.hidden ? "shown, expected hidden" : "hidden, expected shown";
      if (w.idle !== undefined && !!r.idle !== w.idle) return w.idle ? "not idle, expected idle" : `idle (${r.idle?.why}), expected active`;
      if (w.env !== undefined && (r.env ?? null) !== w.env) return `env ${r.env ?? "none"} (${r.envWhy ?? "unassigned"}), expected ${w.env ?? "none"}`;
      return undefined;
    });
  for (const [sel, env] of Object.entries(exp.envs ?? {}))
    one(sel, (r) => ((r.env ?? null) === env ? undefined : `env ${r.env ?? "none"} (${r.envWhy ?? "unassigned"}), expected ${env ?? "none"}`));
  for (const [id, state] of Object.entries(exp.providers ?? {})) {
    const p = v.providers.find((x) => x.id === id);
    if (p?.state !== state) problems.push(`provider ${id}: ${p ? `${p.state}${p.error ? ` (${p.error})` : ""}` : "not registered"}, expected ${state}`);
  }
}

// ---------- main ----------

const exp = value("--expect") ? JSON.parse(await readFile(value("--expect"), "utf8")) : {};
const v = await inventory();
const regions = regionsArg ?? v.regions ?? [v.homeRegion ?? v.region];
const problems = [];
const info = [];

console.log(`console ${BASE}: account ${v.accountId ?? "?"}, regions ${(v.regions ?? []).join(", ")}, ${v.resources.length} resources, ${v.edges?.length ?? 0} edges${v.partial?.pendingRegions?.length ? ` (still merging: ${v.partial.pendingRegions.join(", ")})` : ""}`);
const notOk = v.providers.filter((p) => p.state !== "ok" && !(p.state === "disabled" && p.error === "not implemented yet"));
for (const p of notOk) info.push(`provider ${p.id}: ${p.state}${p.error ? ` — ${p.error}` : ""}`);
for (const r of regions) if (v.regions && !v.regions.includes(r)) problems.push(`region ${r}: the console doesn't read it (its regions: ${v.regions.join(", ")})`);

if (!flag("--no-aws")) {
  const mine = consoleCounts(v);
  const theirs = await awsCounts(regions);
  for (const [where, how] of theirs.how) console.log(`aws ${where}: ${how}`);
  const ignore = exp.ignoreTypes ?? {};
  const keys = new Set([...theirs.counts.keys(), ...[...mine.keys()].filter((k) => [...regions, "global"].includes(k.slice(k.lastIndexOf("@") + 1)))]);
  const rows = [];
  let settledGlobal = 0; // console minus Resource Explorer, for global types the service's own list call settled
  for (const at of [...keys].sort()) {
    const type = at.slice(0, at.lastIndexOf("@"));
    const region = at.slice(at.lastIndexOf("@") + 1);
    const how = theirs.how.get(region) ?? "";
    if (how.startsWith("not read")) continue;
    if (how.startsWith("fallback") && !theirs.fallbackTypes.has(type)) continue;
    const a = theirs.counts.get(at) ?? 0;
    const c = mine.get(at)?.size ?? 0;
    if (Number.isNaN(a)) continue;
    if (Object.hasOwn(ignore, type)) {
      if (a !== c) info.push(`${at}: AWS ${a}, console ${c} — ignored: ${ignore[type]}`);
      continue;
    }
    if (infoOf(type).visibility === "drop") {
      if (a !== c) info.push(`${at}: AWS ${a}, console ${c} — folded by design (a sub-object; hiddenTypes counts it: ${v.hiddenTypes?.[type] ?? 0})`);
      continue;
    }
    if (c !== a && !how.startsWith("fallback")) {
      const d = await directCount(type, region === "global" ? regions[0] : region);
      if (d?.n === c) {
        const why = c > a ? `Resource Explorer doesn't index ${c - a} of them` : `Resource Explorer still lists ${a - c} that no longer exist`;
        info.push(`${at}: Resource Explorer ${a}, console ${c} — ${why}; ${d.how} agrees with the console`);
        if (region === "global") settledGlobal += c - a;
        rows.push({ at, a: c, c });
        continue;
      }
    }
    rows.push({ at, a, c });
    if (a !== c) problems.push(`${at}: AWS ${a}, console ${c}${a > c ? " (missing on the map)" : " (more on the map than AWS reports)"}`);
  }
  console.log(`compared ${rows.length} type×region pairs: ${rows.filter((r) => r.a === r.c).length} match`);
  if (theirs.global !== undefined) {
    const consoleGlobal = [...mine].filter(([k]) => k.endsWith("@global")).reduce((n, [k, s]) => n + (infoOf(k.slice(0, -7)).visibility === "drop" ? 0 : s.size), 0);
    const folded = [...theirs.counts].filter(([k]) => k.endsWith("@global") && infoOf(k.slice(0, -7)).visibility === "drop").reduce((n, [, x]) => n + x, 0);
    console.log(`global: Resource Explorer ${theirs.global} (${folded} folded sub-objects), console ${consoleGlobal} + ${folded} folded`);
    if (exp.global !== undefined && theirs.global !== exp.global) problems.push(`global: Resource Explorer reports ${theirs.global}, expected ${exp.global} (the account changed?)`);
    if (consoleGlobal + folded - settledGlobal !== theirs.global)
      problems.push(`global: console ${consoleGlobal} + ${folded} folded${settledGlobal ? ` ${settledGlobal > 0 ? "−" : "+"} ${Math.abs(settledGlobal)} settled by the services' own list calls` : ""}, Resource Explorer ${theirs.global}`);
  }
} else if (exp.global !== undefined) {
  info.push("global: not compared (--no-aws)");
}

checkExpectations(v, exp, problems);

if (value("--save-envs")) {
  const envs = Object.fromEntries(v.resources.filter(isAws).filter((r) => !r.hidden).map((r) => [r.key, r.env ?? null]).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(value("--save-envs"), JSON.stringify(envs, null, 2) + "\n");
  console.log(`wrote ${Object.keys(envs).length} environment assignments to ${value("--save-envs")}`);
}

for (const i of info) console.log(`info  ${i}`);
for (const p of problems) console.log(`FAIL  ${p}`);
console.log(problems.length ? `\n${problems.length} mismatch(es)` : "\nparity: everything matches");
process.exit(problems.length ? 1 : 0);
