import { test } from "node:test";
import assert from "node:assert/strict";
import { propagate } from "./propagate.ts";
import { keys, type Edge, type Resource } from "./types.ts";

const ACCT = "123456789012";
const NOW = Date.UTC(2026, 9, 5, 12);
const DAY = 86_400_000;
const R = (key: string, kind: Resource["kind"], name: string, extra: Partial<Resource> = {}): Resource => ({
  key, kind, provider: "test", name, region: "us-east-1", tags: {}, health: "ok", props: [], ...extra,
});
const E = (from: string, to: string, kind: Edge["kind"], extra: Partial<Edge> = {}): Edge => ({ id: `${from}->${to}:${kind}`, from, to, kind, evidence: ["test"], confidence: "config", ...extra });
const arn = (svc: string, rest: string, region = "us-east-1") => `arn:aws:${svc}:${region}:${ACCT}:${rest}`;
const run = (resources: Resource[], edges: Edge[] = []) => {
  const p = propagate({ resources, edges, home: "us-east-1", now: NOW, accountId: ACCT });
  return { ...p, by: (k: string) => p.resources.find((r) => r.key === k)!, edge: (from: string, to: string) => p.edges.find((e) => e.from === from && e.to === to) };
};

// The exposure the audit found on the real account (anonymised): a production database marked publicly accessible, in
// subnets named "private" that still route 0.0.0.0/0 to an internet gateway, its group open to the world on 5432 and to
// the peered staging VPC.
const sub = (id: string, vpc: string, facts: Resource["facts"]) => R(arn("ec2", `subnet/${id}`), "subnet", id, { vpcId: vpc, parent: arn("ec2", `vpc/${vpc}`), aliases: [id], facts });
const net = () => [
  R(arn("ec2", "vpc/vpc-prod"), "vpc", "prod", { facts: { cidrs: ["10.20.0.0/16"] } }),
  R(arn("ec2", "vpc/vpc-stg"), "vpc", "staging", { props: [{ label: "CIDR", value: "10.30.0.0/16" }] }),
  R(arn("ec2", "vpc-peering-connection/pcx-0001"), "vpc-peering", "pcx-0001"),
  sub("subnet-private-a", "vpc-prod", { routesToIgw: true, naclOpen: ["all"] }),
  sub("subnet-private-b", "vpc-prod", { routesToIgw: true, naclOpen: ["all"] }),
  sub("subnet-isolated", "vpc-prod", { routesToIgw: false, naclOpen: ["all"] }),
  sub("subnet-web-only", "vpc-prod", { routesToIgw: true, naclOpen: ["443/tcp", "32768-65535/tcp"] }),
];
const peeringEdges = [E(arn("ec2", "vpc-peering-connection/pcx-0001"), arn("ec2", "vpc/vpc-prod"), "route"), E(arn("ec2", "vpc-peering-connection/pcx-0001"), arn("ec2", "vpc/vpc-stg"), "route")];
const sg = (id: string, facts: Resource["facts"]) => R(arn("ec2", `security-group/${id}`), "security-group", id, { aliases: [id], facts });

test("R4: a public database in IGW-routed 'private' subnets, 5432 open to the world → error, internet edge, peered VPC edge", () => {
  const db = R("rds:prod-pg", "rds", "prod-pg", { vpcId: "vpc-prod", subnetIds: ["subnet-private-a", "subnet-private-b"], securityGroups: ["sg-db"], facts: { public: true } });
  const { by, edge, edges } = run([...net(), sg("sg-db", { openIngress: ["5432/tcp"], cidrIngress: ["5432/tcp<-10.30.0.0/16", "5432/tcp<-10.20.1.0/24", "5432/tcp<-198.51.100.10/32"] }), db], peeringEdges);
  assert.deepEqual([by(db.key).health, by(db.key).healthReason], ["error", "reachable from the internet on 5432/tcp (sg-db allows 0.0.0.0/0)"]);
  const inet = edge(keys.external("internet"), db.key)!;
  assert.deepEqual([inet.kind, inet.confidence, inet.label], ["http", "allowed", "5432/tcp"]);
  assert.ok(inet.evidence.includes("security group sg-db allows 0.0.0.0/0 on 5432/tcp"));
  assert.equal(by(keys.external("internet")).kind, "external");
  const peer = edge(arn("ec2", "vpc/vpc-stg"), db.key)!;
  assert.deepEqual([peer.kind, peer.confidence, peer.label, peer.evidence], ["sql", "allowed", "5432/tcp via pcx-0001", ["security group sg-db allows 10.30.0.0/16 on 5432/tcp", "peering pcx-0001"]]);
  assert.equal(edge(arn("ec2", "vpc/vpc-prod"), db.key), undefined, "its own VPC's CIDR is no cross-VPC path");
  assert.equal(edges.filter((e) => e.to === db.key).length, 2, "an office /32 matches no VPC");
});

test("R4: a public database whose groups admit nothing from 0.0.0.0/0 is not flagged", () => {
  const db = R("rds:prod-pg", "rds", "prod-pg", { vpcId: "vpc-prod", subnetIds: ["subnet-private-a"], securityGroups: ["sg-db"], facts: { public: true }, healthReason: "available" });
  const { by, edges, notes } = run([...net(), sg("sg-db", { cidrIngress: ["5432/tcp<-10.20.0.0/16"] }), db]);
  assert.deepEqual([by(db.key).health, by(db.key).healthReason], ["ok", "available"]);
  assert.equal(edges.length, 0);
  assert.deepEqual(notes, []);
});

test("R4: open but not reachable (private, isolated subnet, NACL closed) → warning; web ports on a public LB are fine", () => {
  const open = sg("sg-open", { openIngress: ["5432/tcp", "443/tcp"] });
  const cases = {
    notPublic: R("rds:a", "rds", "a", { vpcId: "vpc-prod", subnetIds: ["subnet-private-a"], securityGroups: ["sg-open"], facts: { public: false } }),
    isolated: R("rds:b", "rds", "b", { vpcId: "vpc-prod", subnetIds: ["subnet-isolated"], securityGroups: ["sg-open"], facts: { public: true } }),
    nacl: R("rds:c", "rds", "c", { vpcId: "vpc-prod", subnetIds: ["subnet-web-only"], securityGroups: ["sg-open"], facts: { public: true } }),
    unknown: R("rds:d", "rds", "d", { vpcId: "vpc-prod", subnetIds: ["subnet-private-a"], securityGroups: ["sg-open"] }),
  };
  const lb = R("elb:web", "loadbalancer", "web", { subnetIds: ["subnet-private-a"], securityGroups: ["sg-web"], facts: { public: true } });
  const { by, edges } = run([...net(), open, sg("sg-web", { openIngress: ["80/tcp", "443/tcp"] }), ...Object.values(cases), lb]);
  const why = (tail: string) => ["warning", `security group sg-open allows 0.0.0.0/0 on 5432/tcp; ${tail}`];
  assert.deepEqual([by(cases.notPublic.key).health, by(cases.notPublic.key).healthReason], why("not publicly addressable today"));
  for (const r of [cases.isolated, cases.nacl]) assert.deepEqual([by(r.key).health, by(r.key).healthReason], why("no internet route or network ACL lets it in today"), r.key);
  assert.deepEqual([by(cases.unknown.key).health, by(cases.unknown.key).healthReason], why("whether it is publicly addressable is unknown"), "no fact, no claim");
  assert.equal(by(lb.key).health, "ok");
  assert.equal(edges.length, 0);
});

test("R4: unknown subnets count as routed to the internet (noted); 'all' is reported as all ports", () => {
  const ec2 = R("ec2:i-1", "ec2-instance", "box", { securityGroups: ["sg-all"], subnetIds: ["subnet-nobody-listed"], facts: { public: true } });
  const db = R("rds:x", "rds", "x", { securityGroups: ["sg-all"], facts: { public: true } });
  const { by, notes } = run([sg("sg-all", { openIngress: ["all"] }), ec2, db]);
  assert.equal(by(ec2.key).healthReason, "reachable from the internet on all ports (sg-all allows 0.0.0.0/0)");
  assert.equal(by(db.key).health, "error");
  assert.deepEqual(notes, ["R4: 1 subnet unknown, 1 public resource without known subnets — counted as routed to the internet"]);
});

test("R1: an alarm in ALARM warns its target; a scaling alarm never does; health is never lowered", () => {
  const api = R("ecs:service/prod/api", "ecs-service", "api");
  const db = R("rds:prod", "rds", "prod", { health: "error", healthReason: "storage full" });
  const low = R(arn("cloudwatch", "alarm:TargetTracking-service/prod/api-AlarmLow-1"), "cloudwatch-alarm", "TargetTracking-…-AlarmLow", { facts: { alarmState: "ALARM", scaling: true } });
  const labelled = R(arn("cloudwatch", "alarm:scale-in"), "cloudwatch-alarm", "scale-in", { facts: { alarmState: "ALARM" } });
  const cpu = R(arn("cloudwatch", "alarm:prod-cpu"), "cloudwatch-alarm", "prod-cpu", { facts: { alarmState: "ALARM" } });
  const ok = R(arn("cloudwatch", "alarm:prod-latency"), "cloudwatch-alarm", "prod-latency", { facts: { alarmState: "OK" } });
  const { by, edge } = run([api, db, low, labelled, cpu, ok], [
    E(low.key, api.key, "monitors", { label: "scales" }), E(labelled.key, api.key, "monitors", { label: "scales" }), E(cpu.key, db.key, "monitors"), E(ok.key, api.key, "monitors"),
  ]);
  assert.equal(by(api.key).health, "ok");
  assert.deepEqual([by(db.key).health, by(db.key).healthReason], ["error", "storage full · alarm prod-cpu is in ALARM"], "error stays error; the reason is appended");
  assert.deepEqual(edge(cpu.key, db.key)!.evidence, ["test", "in ALARM"]);
  // A composite alarm in ALARM leaves its OK child alarms alone.
  const composite = R(arn("cloudwatch", "alarm:prod-any"), "cloudwatch-alarm", "prod-any", { facts: { alarmState: "ALARM" } });
  const c = run([ok, composite], [E(composite.key, ok.key, "monitors")]);
  assert.equal(c.by(ok.key).health, "ok");
});

test("R2/R3/R5: KMS keys, certificates and secrets warn what depends on them", () => {
  const t = (d: number) => new Date(NOW + d * DAY).toISOString();
  const res = (n: string) => R(`res:${n}`, "lambda", n);
  const keySoon = R(arn("kms", "key/1"), "kms-key", "legacy", { facts: { state: "PendingDeletion", deletionDate: t(3) } });
  const keyLater = R(arn("kms", "key/2"), "kms-key", "old", { facts: { state: "PendingDeletion", deletionDate: t(20) } });
  const keyOff = R(arn("kms", "key/3"), "kms-key", "off", { facts: { state: "Disabled" } });
  const certExpired = R(arn("acm", "certificate/1"), "acm-certificate", "a.example", { facts: { notAfter: t(-1) } });
  const certSoon = R(arn("acm", "certificate/2"), "acm-certificate", "b.example", { facts: { notAfter: t(5), autoRenew: true } });
  const certManual = R(arn("acm", "certificate/3"), "acm-certificate", "c.example", { facts: { notAfter: t(20), autoRenew: false } });
  const certAuto = R(arn("acm", "certificate/4"), "acm-certificate", "d.example", { facts: { notAfter: t(20), autoRenew: "ELIGIBLE" } });
  const secret = R(arn("secretsmanager", "secret:acme/api-Ab12Cd"), "secret", "acme/api", { facts: { deletionDate: t(6) } });
  const targets = ["k1", "k2", "k3", "c1", "c2", "c3", "c4", "s1"].map(res);
  const { by } = run([keySoon, keyLater, keyOff, certExpired, certSoon, certManual, certAuto, secret, ...targets], [
    E(keySoon.key, "res:k1", "encrypts"), E(keyLater.key, "res:k2", "encrypts"), E(keyOff.key, "res:k3", "encrypts"),
    E(certExpired.key, "res:c1", "tls"), E(certSoon.key, "res:c2", "tls"), E(certManual.key, "res:c3", "tls"), E(certAuto.key, "res:c4", "tls"),
    E("res:s1", secret.key, "reads"), E(keyOff.key, secret.key, "encrypts"), E("res:k2", secret.key, "manages"),
  ]);
  const h = (k: string) => [by(`res:${k}`).health, by(`res:${k}`).healthReason];
  assert.deepEqual(h("k1"), ["error", "KMS key legacy is pending deletion (deleted 2026-10-08, in 3 days)"]);
  assert.equal(h("k2")[0], "warning");
  assert.deepEqual(h("k3"), ["warning", "KMS key off is disabled"]);
  assert.deepEqual(h("c1"), ["error", "certificate a.example expired on 2026-10-04"]);
  assert.deepEqual(h("c2"), ["error", "certificate b.example expires in 5 days"]);
  assert.deepEqual(h("c3"), ["warning", "certificate c.example expires in 20 days and won't renew automatically"]);
  assert.deepEqual(h("c4"), ["ok", undefined]);
  assert.deepEqual(h("s1"), ["warning", "reads secret acme/api, which is scheduled for deletion on 2026-10-11"]);
  assert.equal(by(keyOff.key).health, "ok", "the key that encrypts a secret doesn't read it");
  assert.ok(!h("k2")[1]?.toString().includes("secret"), "nor does what manages it");
});

test("R6/R7/R8: vpcId from subnets, unused things marked idle, Cloud Map without instances", () => {
  const fn = R("fn", "lambda", "fn", { subnetIds: ["subnet-private-a"] });
  const unused = sg("sg-old", { attachments: 0, referencedBy: 0, isDefault: false });
  const dflt = sg("sg-default", { attachments: 0, referencedBy: 0, isDefault: true });
  const used = sg("sg-used", { attachments: 3, referencedBy: 0 });
  const unread = sg("sg-unread", { attachments: 0, isDefault: false }); // who references it wasn't read: never "unused"
  const cert = R(arn("acm", "certificate/9"), "acm-certificate", "old.example", { facts: { inUse: false } });
  const waf = R(arn("wafv2", "regional/webacl/idle/1"), "waf-acl", "idle");
  const wafOn = R(arn("wafv2", "regional/webacl/web/2"), "waf-acl", "web");
  const role = R(`arn:aws:iam::${ACCT}:role/acme-old-deployer`, "iam-role", "acme-old-deployer", { region: "global", facts: { neverUsed: true } });
  const billing = R("ecs:service/prod/billing", "ecs-service", "billing", { props: [{ label: "Tasks", value: "1/1 running" }] });
  const stopped = R("ecs:service/prod/old", "ecs-service", "old", { props: [{ label: "Tasks", value: "0/0 running" }] });
  const cm = R(arn("servicediscovery", "service/srv-billing"), "cloudmap-service", "billing", { health: "stopped", healthReason: "no instances registered" });
  const cmOld = R(arn("servicediscovery", "service/srv-old"), "cloudmap-service", "old", { health: "stopped", healthReason: "no instances registered" });
  const { by } = run([...net(), fn, unused, dflt, used, unread, cert, waf, wafOn, role, billing, stopped, cm, cmOld], [
    E(wafOn.key, "elb:web", "protects"), E(cm.key, billing.key, "route"), E(cmOld.key, stopped.key, "route"),
  ]);
  assert.equal(by("fn").vpcId, "vpc-prod");
  assert.deepEqual(by(unused.key).idle, { why: "no network interface uses it and no other group references it" });
  assert.equal(by(dflt.key).idle, undefined);
  assert.equal(by(used.key).idle, undefined);
  assert.equal(by(unread.key).idle, undefined);
  assert.deepEqual(by(cert.key).idle, { why: "no AWS service uses it" });
  assert.deepEqual(by(waf.key).idle, { why: "protects nothing" });
  assert.equal(by(wafOn.key).idle, undefined);
  assert.deepEqual(by(role.key).idle, { why: "never used" });
  assert.deepEqual([by(cm.key).health, by(cm.key).healthReason], ["warning", "no instances registered · no instances registered while billing wants 1 task"]);
  assert.equal(by(cmOld.key).health, "stopped", "nothing wants tasks there");
});

test("R9: the latest recovery point per resource, from plans and vaults — failed or older than 2 days warns", () => {
  const t = (d: number) => new Date(NOW - d * DAY).toISOString();
  const db = R("rds:acme-production-pg", "rds", "acme-production-pg");
  const table = R(arn("dynamodb", "table/acme-carts"), "dynamodb", "acme-carts");
  const efs = R(arn("elasticfilesystem", "file-system/fs-1"), "efs-filesystem", "shared");
  const fresh = R(arn("dynamodb", "table/acme-orders"), "dynamodb", "acme-orders");
  const point = R(arn("dynamodb", "table/acme-users"), "dynamodb", "acme-users"); // a recovery point's status, AVAILABLE = good
  const plan = R(arn("backup", "backup-plan:p1"), "backup-plan", "acme-daily", {
    facts: { lastBackups: [`${arn("rds", "db:acme-production-pg")}|${t(5)}|COMPLETED`, `${table.key}|${t(1)}|FAILED`, `${fresh.key}|${t(0.5)}|COMPLETED`, `${efs.key}|${t(0.1)}|RUNNING`, `${point.key}|${t(1)}|AVAILABLE`, `${point.key}|${t(0.2)}|CREATING`] },
  });
  const vault = R(arn("backup", "backup-vault:acme-backups"), "backup-vault", "acme-backups", { facts: { lastBackups: [`${table.key}|${t(3)}|COMPLETED`, `${efs.key}|${t(4)}|COMPLETED`] } });
  const { by, edge } = run([db, table, efs, fresh, point, plan, vault], [E(plan.key, db.key, "protects")]);
  assert.deepEqual([by(db.key).health, by(db.key).healthReason], ["warning", "last backup 5 days ago (2026-09-30)"], "an RDS ARN resolves to the console's key");
  assert.deepEqual([by(table.key).health, by(table.key).healthReason], ["warning", "last backup failed (2026-10-04)"], "the newest point wins, whichever source listed it");
  assert.equal(by(efs.key).healthReason, "last backup 4 days ago (2026-10-01)", "a running job is not a result");
  assert.equal(by(fresh.key).health, "ok");
  assert.deepEqual([by(point.key).health, by(point.key).healthReason], ["ok", undefined], "an AVAILABLE recovery point is a good backup; CREATING is still in flight");
  assert.deepEqual(edge(plan.key, db.key)!.evidence, ["test", "last backup 5 days ago (2026-09-30)"]);
});

test("never lowers health, copies its input and leaves untouched resources alone", () => {
  const input = [R("x", "lambda", "x", { health: "warning", healthReason: "throttled" }), R(arn("kms", "key/1"), "kms-key", "k", { facts: { state: "Disabled" } })];
  const edges = [E(arn("kms", "key/1"), "x", "encrypts")];
  const { by } = run(input, edges);
  assert.deepEqual([by("x").health, by("x").healthReason], ["warning", "throttled · KMS key k is disabled"]);
  assert.deepEqual([input[0].health, input[0].healthReason, edges[0].evidence], ["warning", "throttled", ["test"]], "the inputs are not modified");
  const none = propagate({ resources: [R("y", "lambda", "y")], edges: [] });
  assert.deepEqual(none.resources[0], R("y", "lambda", "y"));
  assert.deepEqual(none.notes, []);
});
