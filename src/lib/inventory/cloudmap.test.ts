import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudMapResults, fqdnOf, instanceRows, namespaceDetail, serviceDetail, serviceHealth, zoneKey, type CloudMapRaw, type RawCmService, type RawInstance } from "./cloudmap.ts";
import { propagate } from "./propagate.ts";
import type { Resource } from "./types.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const SENTINEL = "SECRET_SENTINEL_c10d";
const nsArn = `arn:aws:servicediscovery:${R}:${ACCT}:namespace/ns-acme`;
const svcArn = (id: string) => `arn:aws:servicediscovery:${R}:${ACCT}:service/${id}`;
const custom = { FailureThreshold: 1 };
const dnsA = { RoutingPolicy: "MULTIVALUE", DnsRecords: [{ Type: "A", TTL: 10 }] };
const svc = (id: string, Name: string): RawCmService => ({ Id: id, Arn: svcArn(id), Name, Type: "DNS_HTTP", DnsConfig: dnsA, HealthCheckCustomConfig: custom, CreateDate: "2026-09-27T16:29:26.800Z", ResourceOwner: ACCT });
const task = (id: string, ip: string, service: string): RawInstance => ({
  Id: id,
  Attributes: {
    AVAILABILITY_ZONE: "us-east-1a", AWS_INIT_HEALTH_STATUS: "HEALTHY", AWS_INSTANCE_IPV4: ip, ECS_CLUSTER_NAME: "acme-production", ECS_SERVICE_NAME: service,
    ECS_TASK_DEFINITION_FAMILY: `${service}-production`, REGION: R, CUSTOM_TOKEN: SENTINEL,
  },
});

// The real pattern (F18), anonymised: one private DNS namespace with three ECS-registered services; one runs without
// its registry (0 instances), one has a task the custom health check reports unhealthy.
const raw: CloudMapRaw = {
  namespaces: [{
    Id: "ns-acme", Arn: nsArn, Name: "acme.internal", Type: "DNS_PRIVATE", ResourceOwner: ACCT, CreateDate: "2026-09-27T16:29:11.547Z",
    Properties: { DnsProperties: { HostedZoneId: "Z0ACMEINTERNAL1" }, HttpProperties: { HttpName: "acme.internal" } },
  }],
  services: { "ns-acme": [svc("srv-one", "one"), svc("srv-go", "go"), svc("srv-api", "api")] },
  instances: {
    "srv-one": { value: [], state: "ok" },
    "srv-go": { value: [task("t-go-1", "10.20.0.52", "acme-go-background")], state: "ok" },
    "srv-api": { value: [task("t-api-1", "10.20.10.21", "api"), task("t-api-2", "10.20.11.22", "api")], state: "ok" },
  },
  health: { "srv-go": { value: { "t-go-1": "HEALTHY" }, state: "ok" }, "srv-api": { value: { "t-api-1": "HEALTHY", "t-api-2": "UNHEALTHY" }, state: "ok" } },
  tags: { [nsArn]: { value: [{ Key: "Environment", Value: "production" }], state: "ok" }, [svcArn("srv-one")]: { value: [], state: "ok" } },
};

test("golden: namespace → private zone; services with their DNS names, ECS links and health; 0 instances is stopped", () => {
  const out = cloudMapResults(raw, { region: R, accountId: ACCT, home: R, now: NOW });
  const by = (k: string) => out.resources.find((r) => r.key === k)!;
  assert.deepEqual(by(nsArn), {
    key: nsArn, kind: "cloudmap-namespace", provider: "cloudmap", name: "acme.internal", region: R, tags: { Environment: "production" }, health: "ok",
    props: [{ label: "Namespace id", value: "ns-acme", mono: true }, { label: "Type", value: "DNS, private (VPC)" }, { label: "Hosted zone", value: "Z0ACMEINTERNAL1", mono: true }, { label: "Services", value: "3" }],
    aliases: ["ns-acme"], consoleUrl: `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(nsArn)}`, createdAt: Date.parse("2026-09-27T16:29:11.547Z"),
    enrichment: { tags: "ok" }, observedAt: NOW,
  });
  const one = by(svcArn("srv-one"));
  assert.deepEqual(
    [one.name, one.health, one.healthReason, one.endpoints, one.parent, one.facts, one.tagsUnread, one.enrichment],
    ["one.acme.internal", "stopped", "no instances registered", ["one.acme.internal"], nsArn, { instances: 0 }, undefined, { instances: "ok", tags: "ok" }],
  );
  const api = by(svcArn("srv-api"));
  assert.deepEqual([api.health, api.healthReason, api.facts, api.tagsUnread], ["warning", "1 of 2 instances unhealthy", { instances: 2 }, true]);
  assert.equal(api.props.find((p) => p.label === "Instances")?.value, "2 — acme-production/api ×2");
  assert.equal(api.props.find((p) => p.label === "Health check")?.value, "custom (reported by ECS or the registrant) — failure threshold 1");
  assert.equal(by(svcArn("srv-go")).health, "ok");
  assert.deepEqual(out.links.map((l) => [l.from, l.to, l.kind, l.label]), [
    [nsArn, "arn:aws:route53:::hostedzone/Z0ACMEINTERNAL1", "manages", "DNS records"],
    [svcArn("srv-go"), "ecs:service/acme-production/acme-go-background", "route", "go.acme.internal → tasks"],
    [svcArn("srv-api"), "ecs:service/acme-production/api", "route", "api.acme.internal → tasks"],
  ]);
  assert.ok(!JSON.stringify(out).includes(SENTINEL), "custom instance attributes never reach the output");
});

test("outside the home region the ECS key carries @region; EC2 registrations link the instance", () => {
  const out = cloudMapResults({
    namespaces: [{ Id: "ns-eu", Name: "eu.internal", Type: "DNS_PRIVATE", Properties: { DnsProperties: { HostedZoneId: "ZEU" } } }],
    services: { "ns-eu": [{ Id: "srv-eu", Name: "api", Type: "DNS_HTTP", DnsConfig: dnsA }] },
    instances: { "srv-eu": { value: [task("t-1", "10.40.10.5", "api"), { Id: "i-1", Attributes: { AWS_EC2_INSTANCE_ID: "i-0abc", AWS_INSTANCE_IPV4: "10.40.11.9" } }], state: "ok" } },
  }, { region: "eu-west-1", accountId: ACCT, home: R });
  assert.deepEqual(out.links.slice(1).map((l) => l.to), ["ecs:service/acme-production/api@eu-west-1", "ec2:i-0abc@eu-west-1"]);
  assert.equal(out.resources[0].key, `arn:aws:servicediscovery:eu-west-1:${ACCT}:namespace/ns-eu`, "built with arnOf when the list carries no ARN");
  assert.equal(out.links[0].to, zoneKey("ZEU", "eu-west-1"));
  const svcRes = out.resources[1];
  assert.deepEqual([svcRes.tagsUnread, svcRes.enrichment, svcRes.health], [true, { instances: "ok", tags: "skipped" }, "ok"], "no health check: no health read to miss");
});

test("health: instances not read is unknown, never stopped; all unhealthy is an error; HTTP namespaces have no DNS name", () => {
  assert.deepEqual(serviceHealth(undefined, undefined, "denied"), { health: "unknown", healthReason: "instances not read (denied)" });
  assert.deepEqual(serviceHealth([{ Id: "a" }, { Id: "b" }], { a: "UNHEALTHY", b: "UNHEALTHY" }, "ok"), { health: "error", healthReason: "all 2 instances unhealthy" });
  assert.deepEqual(serviceHealth([{ Id: "a" }], { a: "UNKNOWN" }, "ok"), { health: "ok" });
  assert.equal(fqdnOf({ Name: "orders", Type: "HTTP" }, { Name: "acme.internal", Type: "DNS_PRIVATE" }), undefined);
  assert.equal(fqdnOf({ Name: "Orders", Type: "DNS_HTTP" }, { Name: "Acme.Internal", Type: "DNS_PRIVATE" }), "orders.acme.internal");
  assert.equal(fqdnOf({ Name: "orders" }, { Name: "acme-http", Type: "HTTP" }), undefined);
  const out = cloudMapResults({ namespaces: [{ Id: "ns-h", Name: "acme-http", Type: "HTTP" }], services: { "ns-h": [{ Id: "srv-h", Name: "orders", Type: "HTTP" }] } }, { region: R, accountId: ACCT });
  assert.deepEqual([out.resources[1].name, out.resources[1].endpoints, out.resources[1].health, out.links.length], ["orders (acme-http)", undefined, "unknown", 0]);
});

test("R8: a service with no instances while its ECS service wants tasks warns", () => {
  const out = cloudMapResults(raw, { region: R, accountId: ACCT, home: R });
  const ecs: Resource = { key: "ecs:service/acme-production/one", kind: "ecs-service", provider: "ecs", name: "one", region: R, tags: {}, health: "ok", props: [], facts: { desired: 2 } };
  const edge = { id: "x", from: svcArn("srv-one"), to: ecs.key, kind: "route" as const, evidence: ["ECS service registry"], confidence: "config" as const };
  const p = propagate({ resources: [...out.resources, ecs], edges: [edge], now: NOW });
  const one = p.resources.find((r) => r.key === svcArn("srv-one"))!;
  assert.equal(one.health, "warning");
  assert.match(one.healthReason!, /no instances registered while one wants 2 tasks/);
});

test("panels: DNS and health, instances with what registered them; the namespace's services", () => {
  const d = serviceDetail(svcArn("srv-api"), svc("srv-api", "api"), raw.instances!["srv-api"].value, raw.health!["srv-api"].value);
  assert.deepEqual(d.sections.map((s) => s.title), ["DNS and health", "Instances"]);
  assert.deepEqual(d.sections[1].table!.rows, [["t-api-1", "10.20.10.21", "us-east-1a", "ECS acme-production/api", "HEALTHY"], ["t-api-2", "10.20.11.22", "us-east-1a", "ECS acme-production/api", "UNHEALTHY"]]);
  assert.equal(serviceDetail("k", undefined, [], undefined).sections[0].note, "No instances registered: lookups of this name find nothing.");
  assert.deepEqual(instanceRows([{ Id: "x", Attributes: { AWS_INSTANCE_IPV4: "10.0.0.1", AWS_INSTANCE_PORT: "8080" } }]), [["x", "10.0.0.1:8080", "", "", "—"]]);
  const n = namespaceDetail(nsArn, raw.services["ns-acme"], raw.namespaces[0]);
  assert.deepEqual(n.sections[0].table!.rows[0], ["one", "one.acme.internal", "A", "custom (reported by ECS or the registrant) — failure threshold 1"]);
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
});
