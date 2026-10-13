import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPaths, distributionName, distributionResource, invalidationPathsError, pathLabel, patternsByOrigin, type RawDistribution } from "./edge-cloudfront.ts";

const dist = (over: Partial<RawDistribution> = {}): RawDistribution => ({
  id: "E1", arn: "arn:aws:cloudfront::1:distribution/E1", domain: "d1.cloudfront.net", aliases: ["www.acme.example"], enabled: true, status: "Deployed",
  origins: [
    { id: "assets", domain: "acme-assets.s3.us-east-1.amazonaws.com", type: "s3", oac: true },
    { id: "alb", domain: "acme-1.us-east-1.elb.amazonaws.com", type: "custom", protocol: "https-only" },
  ],
  originGroups: [],
  behaviors: [
    { pattern: "*", originId: "assets", edgeLambdas: [], functions: [] },
    { pattern: "/api/*", originId: "alb", edgeLambdas: [{ arn: "arn:aws:lambda:us-east-1:1:function:auth:7", event: "viewer-request" }], functions: [] },
  ],
  unread: [],
  ...over,
});

test("path labels: default first, clipped", () => {
  assert.equal(pathLabel(["*"], "assets"), "default → assets");
  assert.equal(pathLabel(["/api/*"], "alb"), "/api/* → alb");
  assert.equal(pathLabel(["/a/*", "/b/*", "/c/*", "/d/*"], "o"), "/a/*, /b/*, /c/* +1 more → o");
  assert.equal(pathLabel([], "o"), "unused → o");
});

test("origin groups spread their patterns to every member", () => {
  const m = patternsByOrigin({ behaviors: [{ pattern: "*", originId: "g", edgeLambdas: [], functions: [] }], originGroups: [{ id: "g", members: ["primary", "backup"] }] });
  assert.deepEqual([...m.entries()], [["primary", ["*"]], ["backup", ["*"]]]);
});

test("distribution → resource and links (S3 by key, ALB by hostname, logs, Lambda@Edge)", () => {
  const { resource: r, links } = distributionResource(dist({ logging: { bucket: "acme-logs.s3.amazonaws.com", prefix: "cf/" }, webAclId: "arn:aws:wafv2:us-east-1:1:global/webacl/shop-waf/abc" }));
  assert.equal(r.key, "arn:aws:cloudfront::1:distribution/E1");
  assert.equal(r.region, "global");
  assert.deepEqual(r.endpoints, ["d1.cloudfront.net", "www.acme.example"]);
  assert.deepEqual(r.aliases, ["E1", "www.acme.example"]);
  assert.equal(r.props.find((p) => p.label === "WAF")?.value, "shop-waf");
  assert.deepEqual(links.map((l) => [l.from, l.to, l.kind, l.label]), [
    [r.key, "arn:aws:s3:::acme-assets", "route", "default → assets"],
    [r.key, "acme-1.us-east-1.elb.amazonaws.com", "route", "/api/* → alb"],
    [r.key, "arn:aws:s3:::acme-logs", "writes", "access logs"],
    [r.key, "arn:aws:lambda:us-east-1:1:function:auth", "invoke", "viewer-request"],
    ["arn:aws:wafv2:us-east-1:1:global/webacl/shop-waf/abc", r.key, "protects", "web ACL"],
  ]);
  assert.match(links[0].evidence, /origin access control/);
  const off = distributionResource(dist({ enabled: false })).resource;
  assert.deepEqual([off.health, off.healthReason], ["stopped", "distribution is disabled"]);
  assert.equal(distributionResource(dist({ aliases: [], comment: "" })).resource.name, "E1");
});

test("invalidation paths: leading slash, trailing wildcard only, ≤ 30, no spaces", () => {
  assert.equal(invalidationPathsError(["/index.html", "/static/*", "/*"]), undefined);
  assert.match(invalidationPathsError([])!, /at least one/);
  assert.match(invalidationPathsError(["index.html"])!, /start with \//);
  assert.match(invalidationPathsError(["/a*/b"])!, /only end/);
  assert.match(invalidationPathsError(["/a b"])!, /URL-encode/);
  assert.match(invalidationPathsError(Array.from({ length: 31 }, (_, i) => `/${i}`))!, /30/);
  assert.match(invalidationPathsError("/x")!, /at least one/);
  assert.deepEqual(cleanPaths(["/a", "/a", "/b"]), ["/a", "/b"]);
});

test("F41 name: alias, then the Name tag, then the comment, then the id; the certificate and web ACL point at the distribution", () => {
  assert.equal(distributionName({ id: "E1", aliases: ["www.acme.example"], tags: { Name: "shop" }, comment: "c" }), "www.acme.example");
  assert.equal(distributionName({ id: "E1", aliases: [], tags: { Name: "shop" }, comment: "c" }), "shop");
  assert.equal(distributionName({ id: "E1", aliases: [], tags: {}, comment: " Acme assets " }), "Acme assets");
  assert.equal(distributionName({ id: "E1", aliases: [], tags: { Name: " " }, comment: "" }), "E1");
  const d = dist({ aliases: [], tags: { Name: "assets" }, certificate: "arn:aws:acm:us-east-1:1:certificate/c1", webAclId: "classic-waf-id-1234" });
  const { resource: r, links } = distributionResource(d, { tags: "ok", logging: "ok" });
  assert.equal(r.name, "assets");
  assert.deepEqual(links.filter((l) => l.kind === "tls").map((l) => [l.from, l.to]), [["arn:aws:acm:us-east-1:1:certificate/c1", r.key]]);
  assert.equal(links.some((l) => l.kind === "protects"), false, "a classic WAF id is no ARN anything lists");
  assert.equal(distributionResource(dist({ certificate: "CloudFront default (*.cloudfront.net)" })).links.some((l) => l.kind === "tls"), false);
  assert.deepEqual([r.tagsUnread, r.enrichment], [undefined, { tags: "ok", logging: "ok" }]);
  // R01: the list carries no tags — unread until ListTagsForResource answered.
  const listed = distributionResource(dist()).resource;
  assert.deepEqual([listed.tagsUnread, listed.tags], [true, {}]);
});
