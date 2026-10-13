import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cfRecordLinks, cfZoneResource, healthCheckHealth, healthCheckResource, purgeBody, recordLinks, recordRouting, routingText, zoneIdOf, zoneKey, zoneResource, type RawHealthCheck,
  type RawRecord,
} from "./edge-dns.ts";

test("zones: key, private VPCs, no name alias", () => {
  assert.equal(zoneKey("/hostedzone/Z1"), "arn:aws:route53:::hostedzone/Z1");
  assert.equal(zoneIdOf("/hostedzone/Z1"), "Z1");
  const r = zoneResource({ id: "Z1", name: "internal.acme", private: true, recordCount: 12, vpcs: [{ id: "vpc-1", region: "us-east-1" }, { id: "vpc-9", region: "eu-west-1" }] }, "us-east-1");
  assert.equal(r.vpcId, "vpc-1");
  assert.deepEqual(r.aliases, ["Z1"]);
  assert.equal(r.props.find((p) => p.label === "Type")?.value, "Private");
  assert.equal(zoneResource({ id: "Z2", name: "acme.example", private: false }, "us-east-1").vpcId, undefined);
});

test("records → links: aliases, CNAMEs, IPs, delegations; plumbing and TXT skipped; duplicates merged", () => {
  const records: RawRecord[] = [
    { name: "acme.example", type: "NS", values: ["ns-1.awsdns-1.org."] },
    { name: "acme.example", type: "TXT", values: ['"v=spf1 -all"'] },
    { name: "_abc.acme.example", type: "CNAME", values: ["_x.acm-validations.aws."] },
    { name: "www.acme.example", type: "A", values: [], alias: { target: "d1.cloudfront.net." } },
    { name: "www.acme.example", type: "AAAA", values: [], alias: { target: "d1.cloudfront.net." } },
    { name: "api.acme.example", type: "A", values: [], alias: { target: "dualstack.acme-1.us-east-1.elb.amazonaws.com." }, routing: "weighted 10" },
    { name: "\\052.acme.example", type: "CNAME", values: ["acme-legacy.us-east-1.elasticbeanstalk.com"] },
    { name: "bastion.acme.example", type: "A", values: ["203.0.113.10", "203.0.113.11"] },
    { name: "dev.acme.example", type: "NS", values: ["ns-2.awsdns-2.org."] },
  ];
  const links = recordLinks("zone", "acme.example", records, new Map([["dev.acme.example", "zone-dev"]]));
  assert.deepEqual(links.map((l) => [l.to, l.label]), [
    ["d1.cloudfront.net", "www.acme.example"],
    ["acme-1.us-east-1.elb.amazonaws.com", "api.acme.example (weighted)"],
    ["acme-legacy.us-east-1.elasticbeanstalk.com", "*.acme.example"],
    ["203.0.113.10", "bastion.acme.example"],
    ["203.0.113.11", "bastion.acme.example"],
    ["zone-dev", "NS delegation"],
  ]);
  assert.ok(links.every((l) => l.kind === "route" && l.from === "zone"));
  assert.equal(links[0].evidence, "Route 53 alias A www.acme.example → d1.cloudfront.net; Route 53 alias AAAA www.acme.example → d1.cloudfront.net");
});

test("Cloudflare: zone health, record links with the proxied flag", () => {
  const z = cfZoneResource({ id: "abc", name: "acme-shop.com", status: "active", plan: "Pro Website", nameServers: ["ada.ns.cloudflare.com"], accountId: "acc1" });
  assert.deepEqual([z.key, z.kind, z.region, z.health], ["cloudflare:zone/abc", "cloudflare-zone", "global", "ok"]);
  assert.equal(z.consoleUrl, "https://dash.cloudflare.com/acc1/acme-shop.com/dns");
  assert.equal(cfZoneResource({ id: "a", name: "x.com", status: "pending", nameServers: [] }).health, "warning");
  assert.equal(cfZoneResource({ id: "a", name: "x.com", status: "active", paused: true, nameServers: [] }).health, "warning");
  assert.equal(cfZoneResource({ id: "a", name: "x.com", status: "moved", nameServers: [] }).health, "error");
  const links = cfRecordLinks("cf", [
    { name: "shop.acme-shop.com", type: "CNAME", content: "d1a2b3c4shop.cloudfront.net", proxied: true },
    { name: "status.acme-shop.com", type: "CNAME", content: "acme.statuspage.io", proxied: false },
    { name: "acme-shop.com", type: "MX", content: "mx.example" },
    { name: "_dmarc.acme-shop.com", type: "TXT", content: "v=DMARC1" },
    { name: "origin.acme-shop.com", type: "A", content: "203.0.113.7", proxied: true },
  ]);
  assert.deepEqual(links.map((l) => [l.to, l.label]), [
    ["d1a2b3c4shop.cloudfront.net", "shop.acme-shop.com (proxied)"],
    ["acme.statuspage.io", "status.acme-shop.com"],
    ["203.0.113.7", "origin.acme-shop.com (proxied)"],
  ]);
  assert.match(links[0].evidence, /proxied via Cloudflare/);
  assert.match(links[1].evidence, /DNS only/);
});

test("purge input: exactly one kind, ≤ 30, inside the zone, no credentials", () => {
  assert.deepEqual(purgeBody("acme-shop.com", { everything: true }), { body: { purge_everything: true }, summary: "Purge everything cached for acme-shop.com" });
  const u = purgeBody("acme-shop.com", { urls: ["https://shop.acme-shop.com/index.html", "https://shop.acme-shop.com/index.html"] });
  assert.ok("body" in u && "files" in u.body && u.body.files.length === 1);
  const h = purgeBody("acme-shop.com", { hosts: ["Shop.Acme-Shop.com", "*.acme-shop.com"] });
  assert.ok("body" in h && "hosts" in h.body && h.body.hosts[0] === "shop.acme-shop.com");
  const err = (i: Parameters<typeof purgeBody>[1]) => ("error" in purgeBody("acme-shop.com", i) ? (purgeBody("acme-shop.com", i) as { error: string }).error : "");
  assert.match(err({}), /exactly one/);
  assert.match(err({ everything: true, urls: ["https://shop.acme-shop.com/"] }), /exactly one/);
  assert.match(err({ urls: ["https://evil.com/x"] }), /not in acme-shop.com/);
  assert.match(err({ urls: ["ftp://shop.acme-shop.com/x"] }), /http/);
  assert.match(err({ urls: ["https://u:p@shop.acme-shop.com/"] }), /credentials/);
  assert.match(err({ urls: ["nope"] }), /not a URL/);
  assert.match(err({ hosts: ["evilacme-shop.com"] }), /not in/);
  assert.match(err({ hosts: ["bad host"] }), /not a hostname/);
  assert.match(err({ urls: Array.from({ length: 31 }, (_, i) => `https://acme-shop.com/${i}`) }), /30/);
});

test("R15: record sets with a routing policy carry it on their link — every answer of a weighted or failover name stays", () => {
  const z = "arn:aws:route53:::hostedzone/Z1";
  const alb = (n: number) => ({ target: `dualstack.acme-${n}.us-east-1.elb.amazonaws.com.` });
  const records: RawRecord[] = [
    { name: "api.acme.example", type: "A", values: [], alias: alb(1), setId: "blue", weight: 90 },
    { name: "api.acme.example", type: "A", values: [], alias: alb(2), setId: "green", weight: 10 },
    { name: "app.acme.example", type: "A", values: [], alias: alb(1), setId: "primary", failover: "PRIMARY", healthCheckId: "hc-1" },
    { name: "app.acme.example", type: "A", values: [], alias: alb(2), setId: "secondary", failover: "SECONDARY" },
    { name: "eu.acme.example", type: "CNAME", values: ["d1.cloudfront.net"], setId: "eu", latencyRegion: "eu-west-1" },
    { name: "geo.acme.example", type: "A", values: ["203.0.113.1"], setId: "de", geolocation: "DE" },
    { name: "mv.acme.example", type: "A", values: ["203.0.113.2"], setId: "a", multivalue: true },
    { name: "cidr.acme.example", type: "A", values: ["203.0.113.3"], setId: "office", cidr: "col-1/office" },
    { name: "plain.acme.example", type: "A", values: ["203.0.113.4"] },
  ];
  const links = recordLinks(z, "acme.example", records);
  const at = (name: string) => links.filter((l) => l.label?.startsWith(name)).map((l) => [l.to, l.label, l.routing]);
  assert.deepEqual(at("api.acme.example"), [
    ["acme-1.us-east-1.elb.amazonaws.com", "api.acme.example (weighted)", { policy: "weighted", weight: 90, setId: "blue" }],
    ["acme-2.us-east-1.elb.amazonaws.com", "api.acme.example (weighted)", { policy: "weighted", weight: 10, setId: "green" }],
  ]);
  assert.deepEqual(at("app.acme.example"), [
    ["acme-1.us-east-1.elb.amazonaws.com", "app.acme.example (failover primary)", { policy: "failover", role: "primary", setId: "primary" }],
    ["acme-2.us-east-1.elb.amazonaws.com", "app.acme.example (failover secondary)", { policy: "failover", role: "secondary", setId: "secondary" }],
  ]);
  assert.match(links.find((l) => l.label === "app.acme.example (failover primary)")!.evidence, /failover PRIMARY, set primary, health check hc-1/);
  assert.deepEqual(at("eu.acme.example")[0].slice(1), ["eu.acme.example (latency)", { policy: "latency", setId: "eu" }]);
  assert.deepEqual(at("geo.acme.example")[0][2], { policy: "geolocation", setId: "de" });
  assert.deepEqual(at("mv.acme.example")[0][2], { policy: "multivalue", setId: "a" });
  assert.deepEqual(at("cidr.acme.example")[0].slice(1), ["cidr.acme.example (ip-based)", { policy: "ip", setId: "office" }]);
  assert.deepEqual(at("plain.acme.example")[0].slice(1), ["plain.acme.example", undefined], "a simple record has no routing");
  // The older pre-formatted text still yields the policy.
  assert.deepEqual(recordRouting({ name: "x", type: "A", values: [], routing: "weighted 10" }), { policy: "weighted", weight: 10 });
  assert.deepEqual(recordRouting({ name: "x", type: "A", values: [], routing: "failover SECONDARY", setId: "s" }), { policy: "failover", role: "secondary", setId: "s" });
  assert.equal(routingText({ name: "x", type: "A", values: [], geolocation: "EU" }), "geolocation EU");
});

test("zones: Cloud Map-managed zones say so; tags not read are unread", () => {
  const r = zoneResource({ id: "Z9", name: "acme.internal", private: true, linkedService: "servicediscovery.amazonaws.com" }, "us-east-1", { tags: "skipped", vpcs: "ok" });
  assert.match(r.props.find((p) => p.label === "Managed by")!.value, /Cloud Map/);
  assert.deepEqual([r.tagsUnread, r.enrichment], [true, { tags: "skipped", vpcs: "ok" }]);
  const read = zoneResource({ id: "Z2", name: "acme.example", private: false, tags: {} }, "us-east-1");
  assert.deepEqual([read.tagsUnread, read.props.some((p) => p.label === "Managed by")], [undefined, false]);
});

test("CC-20 health checks: health from what the checkers report, → what they watch", () => {
  const hc: RawHealthCheck = { id: "4f9a", type: "HTTPS", fqdn: "API.acme.example.", port: 443, path: "/health", interval: 30, failureThreshold: 3, tags: { Name: "api-health" } };
  const ok = "Success: HTTP Status Code 200, OK";
  const bad = "Failure: Connection timed out.";
  assert.deepEqual(healthCheckHealth(hc, [ok, ok, ok]), { health: "ok", healthReason: undefined });
  assert.deepEqual(healthCheckHealth(hc, [ok, bad, ok]), { health: "warning", healthReason: `1 of 3 checkers report a failure: ${bad}` });
  assert.equal(healthCheckHealth(hc, [bad, bad]).health, "error");
  assert.equal(healthCheckHealth({ ...hc, inverted: true }, [bad, bad]).health, "ok", "inverted: healthy while the endpoint fails");
  assert.equal(healthCheckHealth({ ...hc, inverted: true }, [ok]).health, "error");
  assert.deepEqual(healthCheckHealth({ ...hc, disabled: true }, [bad]).health, "stopped");
  assert.match(healthCheckHealth(hc, undefined, "skipped").healthReason!, /time budget/);
  assert.match(healthCheckHealth(hc, undefined, "capped").healthReason!, /first checks/);
  assert.match(healthCheckHealth(hc, undefined, "denied").healthReason!, /GetHealthCheckStatus/);
  assert.equal(healthCheckHealth({ type: "CALCULATED" }, undefined).health, "unknown");

  const { resource: r, links } = healthCheckResource(hc, { statuses: [ok, ok, ok], state: { status: "ok", tags: "ok" }, account: "123456789012" });
  assert.deepEqual([r.key, r.kind, r.provider, r.region, r.name, r.health], ["arn:aws:route53:::healthcheck/4f9a", "health-check", "route53", "global", "api-health", "ok"]);
  assert.equal(r.props.find((p) => p.label === "Checks")?.value, "https://api.acme.example/health");
  assert.equal(r.props.find((p) => p.label === "Checkers")?.value, "3 of 3 report success");
  assert.deepEqual(links.map((l) => [l.from, l.to, l.kind, l.label]), [[r.key, "api.acme.example", "monitors", "HTTPS /health"]]);
  assert.equal(healthCheckResource({ ...hc, tags: undefined }).resource.name, "api.acme.example/health");
  assert.equal(healthCheckResource({ ...hc, tags: undefined }).resource.tagsUnread, true);
  // An IP check, a calculated parent and a metric check.
  assert.deepEqual(healthCheckResource({ id: "ip1", type: "TCP", ip: "203.0.113.20", port: 22 }).links.map((l) => [l.to, l.label]), [["203.0.113.20", "TCP 22"]]);
  assert.deepEqual(healthCheckResource({ id: "p", type: "CALCULATED", children: ["c1", "c2"], healthThreshold: 1 }).links.map((l) => [l.to, l.kind]), [
    ["arn:aws:route53:::healthcheck/c1", "monitors"], ["arn:aws:route53:::healthcheck/c2", "monitors"],
  ]);
  assert.deepEqual(healthCheckResource({ id: "m", type: "CLOUDWATCH_METRIC", alarm: { name: "api-5xx", region: "us-east-1" } }, { account: "123456789012" }).links.map((l) => l.to), [
    "arn:aws:cloudwatch:us-east-1:123456789012:alarm:api-5xx",
  ]);
});
