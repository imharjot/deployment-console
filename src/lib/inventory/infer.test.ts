import { test } from "node:test";
import assert from "node:assert/strict";
import { arnCandidates, bucketOf, hostsIn, infer, listenPorts, looksLikeHost, mentionKind, mergeResources, normalizeHost, scrubProps, sqsArnOf, tokenEligible } from "./infer.ts";
import { infoOf } from "./aws-services.ts";
import { keys, type Edge, type ProviderResult, type Resource, type Routing } from "./types.ts";

const R = (key: string, kind: Resource["kind"], name: string, extra: Partial<Resource> = {}): Resource => ({
  key, kind, provider: "test", name, region: "us-east-1", tags: {}, health: "ok", props: [], ...extra,
});
const result = (resources: Resource[], links: ProviderResult["links"] = [], mentions: ProviderResult["mentions"] = []): ProviderResult => ({ resources, links, mentions });
const edge = (edges: Edge[], from: string, to: string) => edges.find((e) => e.from === from && e.to === to);

test("hostnames: schemes, credentials, ports, paths, trailing dots and dualstack are stripped", () => {
  assert.equal(normalizeHost("https://user:pw@Foo.Example.com.:443/x?y"), "foo.example.com");
  assert.equal(normalizeHost("dualstack.acme-1.us-east-1.elb.amazonaws.com."), "acme-1.us-east-1.elb.amazonaws.com");
  assert.equal(normalizeHost("10.0.1.5:6379"), "10.0.1.5");
  assert.equal(normalizeHost("not a host"), undefined);
  assert.ok(looksLikeHost("status.example.org") && looksLikeHost("203.0.113.9"));
  assert.ok(!looksLikeHost("10.1.2.3") && !looksLikeHost("orders") && !looksLikeHost("192.168.0.4"));
  const hs = hostsIn("postgres://app:secret@db.abc.us-east-1.rds.amazonaws.com:5432/app, cache=10.0.0.7:6379 see docs.example.com");
  assert.deepEqual(hs.map((h) => [h.host, h.port]), [["db.abc.us-east-1.rds.amazonaws.com", 5432], ["10.0.0.7", 6379], ["docs.example.com", undefined]]);
});

test("ARNs, queue URLs and S3 endpoints resolve to the resource they live in", () => {
  assert.ok(arnCandidates("arn:aws:lambda:us-east-1:123456789012:function:orders:live").includes("arn:aws:lambda:us-east-1:123456789012:function:orders"));
  assert.ok(arnCandidates("arn:aws:s3:::acme-assets/img/a.png").includes("arn:aws:s3:::acme-assets"));
  assert.ok(arnCandidates("arn:aws:dynamodb:us-east-1:123456789012:table/carts/stream/2024").includes("arn:aws:dynamodb:us-east-1:123456789012:table/carts"));
  assert.ok(arnCandidates("arn:aws:ecs:us-east-1:123456789012:service/prod/api", "us-east-1", "123456789012").includes(keys.ecsService("prod", "api")));
  assert.ok(arnCandidates("arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/web/abc", "us-east-1", "123456789012").includes(keys.loadBalancer("web")));
  assert.equal(sqsArnOf("https://sqs.us-east-1.amazonaws.com/123456789012/orders"), "arn:aws:sqs:us-east-1:123456789012:orders");
  assert.equal(sqsArnOf("https://us-west-2.queue.amazonaws.com/123456789012/jobs.fifo"), "arn:aws:sqs:us-west-2:123456789012:jobs.fifo");
  assert.equal(sqsArnOf("https://example.com/123456789012/orders"), undefined);
  assert.equal(bucketOf("acme-assets.s3.us-east-1.amazonaws.com"), "acme-assets");
  assert.equal(bucketOf("https://acme-site.s3-website-us-east-1.amazonaws.com/index.html"), "acme-site");
  assert.equal(bucketOf("https://s3.eu-west-1.amazonaws.com/acme-logs/2024/"), "acme-logs");
  assert.equal(bucketOf("s3://acme-config/staging/api.env"), "acme-config");
});

test("merge by key: later non-empty fields win, lists and tags are unions, props merge by label", () => {
  const [m] = mergeResources([
    R("k", "lambda", "a", { tags: { a: "1" }, props: [{ label: "Runtime", value: "node20" }], endpoints: ["x.example.com"], health: "error", healthReason: "boom", lastActivityAt: 5 }),
    R("k", "lambda", "", { tags: { b: "2" }, props: [{ label: "Runtime", value: "node22" }, { label: "Memory", value: "512" }], endpoints: ["y.example.com"], health: "unknown", lastActivityAt: 3, env: "nope" }),
  ]);
  assert.equal(m.name, "a");
  assert.deepEqual(m.tags, { a: "1", b: "2" });
  assert.deepEqual(m.props.map((p) => p.value), ["node22", "512"]);
  assert.deepEqual(m.endpoints, ["x.example.com", "y.example.com"]);
  assert.deepEqual([m.health, m.healthReason, m.lastActivityAt, m.env], ["error", "boom", 5, undefined]);
});

test("links resolve by key, ARN, alias and hostname; unknown hostnames become externals", () => {
  const alb = R(keys.loadBalancer("web"), "loadbalancer", "web", { endpoints: ["web-1.us-east-1.elb.amazonaws.com"], aliases: ["arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/web/abc"] });
  const cf = R("arn:aws:cloudfront::1:distribution/E1", "cloudfront", "E1", { endpoints: ["d1.cloudfront.net"], aliases: ["www.acme.example"] });
  const bucket = R("arn:aws:s3:::acme-assets", "s3", "acme-assets", { endpoints: ["acme-assets.s3.us-east-1.amazonaws.com"] });
  const fn = R("arn:aws:lambda:us-east-1:1:function:orders", "lambda", "orders-fn");
  const zone = R("route53:Z1", "route53-zone", "acme.example");
  const { resources, edges } = infer({
    results: [
      result([alb, cf, bucket, fn, zone], [
        { from: cf.key, to: "acme-assets.s3.amazonaws.com", kind: "route", evidence: "origin S3" },
        { from: cf.key, to: "https://dualstack.web-1.us-east-1.elb.amazonaws.com.", kind: "route", label: "/api/*", evidence: "origin ALB" },
        { from: zone.key, to: "d1.cloudfront.net.", kind: "route", label: "www.acme.example", evidence: "A alias" },
        { from: zone.key, to: "status.vendor.io", kind: "route", label: "status.acme.example", evidence: "CNAME" },
        { from: "arn:aws:events:us-east-1:1:rule/nightly", to: "arn:aws:lambda:us-east-1:1:function:orders:live", kind: "invoke", evidence: "rule target" },
        { from: alb.key, to: "arn:aws:lambda:us-east-1:1:function:orders:live", kind: "invoke", evidence: "target group" },
        { from: alb.key, to: "10.0.3.7", kind: "route", evidence: "ip target" },
      ]),
    ],
    providerOf: () => "edge",
  });
  assert.equal(edge(edges, cf.key, bucket.key)?.kind, "route");
  assert.equal(edge(edges, cf.key, alb.key)?.label, "/api/*");
  assert.equal(edge(edges, zone.key, cf.key)?.confidence, "config");
  const ext = resources.find((r) => r.key === keys.external("status.vendor.io"));
  assert.ok(ext && ext.kind === "external" && ext.provider === "edge");
  assert.ok(edge(edges, zone.key, ext.key));
  assert.ok(edge(edges, alb.key, fn.key), "qualified Lambda ARN → the function");
  assert.ok(!edges.some((e) => e.from.includes("rule/nightly")), "unknown sources draw nothing");
  assert.ok(!resources.some((r) => r.key === keys.external("10.0.3.7")), "private IPs never become externals");
});

test("a DNS record that points at another record lands on the final resource", () => {
  const cf = R("arn:aws:cloudfront::1:distribution/E1", "cloudfront", "E1", { endpoints: ["d1.cloudfront.net"] });
  const r53 = R("route53:Z1", "route53-zone", "acme.example");
  const cfz = R("cloudflare:zone/z", "cloudflare-zone", "acme-shop.com");
  const { resources, edges } = infer({
    results: [result([cf, r53, cfz], [
      { from: cfz.key, to: "www.acme.example", kind: "route", label: "shop.acme-shop.com", evidence: "CNAME (proxied)" },
      { from: r53.key, to: "d1.cloudfront.net", kind: "route", label: "www.acme.example", evidence: "A alias" },
    ])],
  });
  assert.ok(edge(edges, cfz.key, cf.key), "shop → www → CloudFront");
  assert.ok(!resources.some((r) => r.kind === "external"));
  assert.ok(resources.find((r) => r.key === cf.key)!.endpoints!.includes("www.acme.example"));
});

test("mentions: connection strings, queue URLs, ARNs and distinctive names; evidence is the variable name, never the value", () => {
  const svc = R(keys.ecsService("prod", "api"), "ecs-service", "api");
  const db = R(keys.rds("shop-pg"), "rds", "shop-pg", { endpoints: ["shop-pg.c9.us-east-1.rds.amazonaws.com"], props: [{ label: "Engine", value: "postgres 17.6" }] });
  const cache = R(keys.elasticache("shop-valkey"), "elasticache", "shop-valkey", { endpoints: ["master.shop-valkey.abc123.use1.cache.amazonaws.com"] });
  const q = R("arn:aws:sqs:us-east-1:123456789012:shop-orders", "sqs", "shop-orders", { aliases: ["https://sqs.us-east-1.amazonaws.com/123456789012/shop-orders"] });
  const topic = R("arn:aws:sns:us-east-1:123456789012:shop-events", "sns", "shop-events");
  const table = R("arn:aws:dynamodb:us-east-1:123456789012:table/shop-sessions", "dynamodb", "shop-sessions");
  const bucket = R("arn:aws:s3:::shop-uploads", "s3", "shop-uploads");
  const common = R("arn:aws:dynamodb:us-east-1:123456789012:table/orders", "dynamodb", "orders");
  const { edges } = infer({
    results: [result([svc, db, cache, q, topic, table, bucket, common], [], [
      { from: svc.key, refs: ["postgres://app:hunter2@shop-pg.c9.us-east-1.rds.amazonaws.com:5432/app"], via: "env DATABASE_URL" },
      { from: svc.key, refs: ["rediss://shop-valkey-001.shop-valkey.abc123.use1.cache.amazonaws.com:6379"], via: "env REDIS_URL" },
      { from: svc.key, refs: ["https://sqs.us-east-1.amazonaws.com/123456789012/shop-orders"], via: "env ORDERS_QUEUE_URL" },
      { from: svc.key, refs: ["arn:aws:sns:us-east-1:123456789012:shop-events"], via: "env EVENTS_TOPIC_ARN" },
      { from: svc.key, refs: ["shop-sessions"], via: "env SESSIONS_TABLE" },
      { from: svc.key, refs: ["s3://shop-uploads/incoming/"], via: "env UPLOADS_BUCKET" },
      { from: svc.key, refs: ["orders"], via: "env WHATEVER" },
      { from: svc.key, refs: ["api"], via: "env SERVICE_NAME" },
    ])],
  });
  const d = edge(edges, svc.key, db.key)!;
  assert.deepEqual([d.kind, d.label, d.confidence, d.evidence], ["sql", "postgres:5432", "mentioned", ["env DATABASE_URL"]]);
  assert.equal(edge(edges, svc.key, cache.key)?.kind, "cache", "node endpoint → the cluster");
  assert.equal(edge(edges, svc.key, q.key)?.kind, "writes");
  assert.equal(edge(edges, svc.key, topic.key)?.kind, "writes");
  assert.equal(edge(edges, svc.key, table.key)?.kind, "uses");
  assert.equal(edge(edges, svc.key, bucket.key)?.kind, "uses");
  assert.equal(edge(edges, svc.key, common.key), undefined, "a common word is not a mention");
  assert.ok(!JSON.stringify(edges).includes("hunter2"));
  assert.ok(!edges.some((e) => e.from === e.to));
});

test("ambiguous names need the variable name to decide, else they're dropped", () => {
  const svc = R("svc", "lambda", "svc");
  const table = R("arn:aws:dynamodb:us-east-1:1:table/acme-carts", "dynamodb", "acme-carts");
  const queue = R("arn:aws:sqs:us-east-1:1:acme-carts", "sqs", "acme-carts");
  const one = infer({ results: [result([svc, table, queue], [], [{ from: "svc", refs: ["acme-carts"], via: "env CARTS_TABLE" }])] });
  assert.ok(edge(one.edges, "svc", table.key) && !edge(one.edges, "svc", queue.key));
  const none = infer({ results: [result([svc, table, queue], [], [{ from: "svc", refs: ["acme-carts"], via: "env CARTS" }])] });
  assert.equal(none.edges.length, 0);
  assert.ok(tokenEligible("acme-carts") && !tokenEligible("orders") && !tokenEligible("prod") && !tokenEligible("42"));
  assert.equal(mentionKind("loadbalancer", "env API_URL"), "http");
});

test("security groups: a rule into a data store must admit a port it listens on; file systems never connect out", () => {
  const api = R("api", "ecs-service", "api", { vpcId: "vpc-1", securityGroups: ["sg-api"] });
  const worker = R("worker", "ecs-service", "worker", { vpcId: "vpc-1", securityGroups: ["sg-worker"] });
  const search = R("search", "opensearch-domain", "acme-search", { vpcId: "vpc-1", securityGroups: ["sg-db"], props: [{ label: "Engine", value: "OpenSearch 2.13" }] });
  const dw = R("dw", "redshift-cluster", "acme-dw", { vpcId: "vpc-1", securityGroups: ["sg-db"], props: [{ label: "Port", value: "5439" }] });
  const pg = R("pg", "rds", "acme-pg", { vpcId: "vpc-1", securityGroups: ["sg-db"], props: [{ label: "Endpoint", value: "acme-pg.x.rds.amazonaws.com:5432" }] });
  const efs = R("efs", "efs-filesystem", "media", { vpcId: "vpc-1", securityGroups: ["sg-db"] });
  assert.deepEqual([listenPorts(search), listenPorts(dw), listenPorts(pg), listenPorts(efs)], [[443], [5439], [5432], []]);
  const only5432 = { "sg-db": [{ fromPort: 5432, toPort: 5432, groups: ["sg-api", "sg-worker", "sg-db"] }] };
  const a = infer({ results: [result([api, worker, search, dw, pg, efs])], rules: only5432 });
  const pairs = (es: Edge[]) => es.filter((e) => e.confidence === "allowed").map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(pairs(a.edges), ["api>efs", "api>pg", "worker>efs", "worker>pg"], "5432 reaches Postgres (and the file system, whose port is unknown) only; efs is never a source");
  const wider = { "sg-db": [...only5432["sg-db"], { fromPort: 443, toPort: 443, groups: ["sg-api"] }, { fromPort: 5439, toPort: 5439, groups: ["sg-worker"] }] };
  const b = infer({ results: [result([api, worker, search, dw, pg, efs])], rules: wider });
  assert.deepEqual(pairs(b.edges), ["api>efs", "api>pg", "api>search", "worker>dw", "worker>efs", "worker>pg"]);
  assert.equal(edge(b.edges, "api", "search")?.label, "opensearch:443");
  const all = infer({ results: [result([api, search])], rules: { "sg-db": [{ groups: ["sg-api"] }] } });
  assert.ok(edge(all.edges, "api", "search"), "a rule for all traffic admits every port");
});

test("security groups: same VPC only, merged into a stronger edge between the same pair, deduped", () => {
  const api = R("api", "ecs-service", "api", { vpcId: "vpc-1", securityGroups: ["sg-api"] });
  const db = R("db", "rds", "db", { vpcId: "vpc-1", securityGroups: ["sg-db"], props: [{ label: "Engine", value: "postgres 17" }] });
  const other = R("other", "lambda", "other", { vpcId: "vpc-2", securityGroups: ["sg-api"] });
  const rules = { "sg-db": [{ fromPort: 5432, toPort: 5432, groups: ["sg-api"] }] };
  const plain = infer({ results: [result([api, db, other])], rules });
  const e = edge(plain.edges, "api", "db")!;
  assert.deepEqual([e.kind, e.label, e.confidence, e.evidence], ["sql", "postgres:5432", "allowed", ["security group sg-db allows sg-api"]]);
  assert.equal(edge(plain.edges, "other", "db"), undefined, "another VPC");
  const both = infer({
    results: [
      result([api, db], [{ from: "api", to: "db", kind: "sql", evidence: "security group sg-db allows sg-api", confidence: "allowed" }], [
        { from: "api", refs: ["postgres://db.example.internal:5432/x"], via: "env DATABASE_URL" },
      ]),
    ],
    rules,
  });
  assert.equal(both.edges.filter((x) => x.from === "api" && x.to === "db").length, 1);
  assert.deepEqual(both.edges[0].evidence, ["security group sg-db allows sg-api"]);
});

test("link confidence defaults to config and the strongest confidence wins on merge", () => {
  const a = R("a", "lambda", "a"), b = R("b", "sqs", "bbb-queue");
  const { edges } = infer({
    results: [result([a, b], [{ from: "a", to: "b", kind: "writes", evidence: "IAM policy", confidence: "allowed" }], [{ from: "a", refs: ["bbb-queue"], via: "env Q_QUEUE" }]), result([], [{ from: "a", to: "b", kind: "writes", evidence: "destination" }])],
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].confidence, "config");
  assert.deepEqual(edges[0].evidence, ["IAM policy", "destination", "env Q_QUEUE"]);
});

test("props that look like URLs with credentials are masked before they leave the server", () => {
  const r = scrubProps(R("k", "beanstalk", "k", { props: [{ label: "Setting", value: "DATABASE_URL=postgres://app:hunter2@db.example.com:5432/x" }, { label: "Plain", value: "https://example.com/a@b" }] }));
  assert.deepEqual(r.props.map((p) => p.value), ["DATABASE_URL=postgres://****@db.example.com:5432/x", "https://example.com/a@b"]);
  const t = scrubProps(R("t", "apprunner", "t", { props: [{ label: "Source", value: "https://ghp_abc123@github.com/acme/app" }] }));
  assert.equal(t.props[0].value, "https://****@github.com/acme/app", "a lone token before @ is masked too");
});

test("coverage fields pass through clean(): parent, service, type, category, source, hidden, facts, enrichment…", () => {
  const [m] = mergeResources([
    R("arn:aws:sagemaker:us-east-1:123456789012:model/acme-recs-model", "aws-resource", "acme-recs-model", {
      parent: "arn:aws:sagemaker:us-east-1:123456789012:endpoint/acme-recs", service: "SageMaker", resourceType: "sagemaker:model", category: "compute",
      source: "resource-explorer", hidden: true, tagsUnread: true, account: "123456789012", observedAt: 1_000, slim: true,
      facts: { public: false, openIngress: ["5432/tcp"], attachments: 2, state: "Enabled" }, enrichment: { tags: "capped", policy: "denied" },
    }),
  ]);
  assert.equal(m.parent, "arn:aws:sagemaker:us-east-1:123456789012:endpoint/acme-recs");
  assert.deepEqual([m.service, m.resourceType, m.category, m.source, m.hidden, m.tagsUnread, m.account, m.observedAt], ["SageMaker", "sagemaker:model", "compute", "resource-explorer", true, true, "123456789012", 1_000]);
  assert.deepEqual(m.facts, { public: false, openIngress: ["5432/tcp"], attachments: 2, state: "Enabled" });
  assert.deepEqual(m.enrichment, { tags: "capped", policy: "denied" });
  assert.equal(m.slim, undefined, "slim is the inventory's payload decision, never a provider's");
});

test("clean() keeps only well-formed facts and enrichment states, and copies them", () => {
  const facts = { ok: "x", n: 3, list: ["a"], bad: { nested: true }, nan: Number.NaN, mixed: ["a", 1] } as unknown as Resource["facts"];
  const input = R("k", "kms-key", "k", { facts, enrichment: { tags: "ok", rotation: "maybe" } as unknown as Resource["enrichment"], hidden: "yes" as unknown as boolean });
  const [m] = mergeResources([input]);
  assert.deepEqual(m.facts, { ok: "x", n: 3, list: ["a"] });
  assert.deepEqual(m.enrichment, { tags: "ok" });
  assert.equal(m.hidden, undefined, "only true hides");
  const odd = mergeResources([R("o", "aws-resource", "o", { category: "bogus" as unknown as Resource["category"], source: "guess" as unknown as Resource["source"] })])[0];
  assert.deepEqual([odd.category, odd.source], [undefined, undefined], "an unknown category or source is dropped, not drawn as a column");
  (m.facts!.list as string[]).push("b");
  assert.deepEqual(input.facts!.list, ["a"], "a copy, not the provider's array");
  assert.equal(mergeResources([R("k", "kms-key", "k", { facts: {} })])[0].facts, undefined);
});

test("merge: facts and enrichment key by key, hidden only when every report hides, unread tags fail closed", () => {
  const [m] = mergeResources([
    R("k", "security-group", "sg", { facts: { openIngress: ["5432/tcp"], attachments: 1 }, enrichment: { tags: "ok" }, hidden: true }),
    R("k", "security-group", "sg", { facts: { attachments: 3, isDefault: false }, enrichment: { rules: "denied" }, tagsUnread: true }),
  ]);
  assert.deepEqual(m.facts, { openIngress: ["5432/tcp"], attachments: 3, isDefault: false });
  assert.deepEqual(m.enrichment, { tags: "ok", rules: "denied" });
  assert.equal(m.hidden, undefined, "one report shows it");
  assert.equal(m.tagsUnread, true, "one report couldn't read its tags");
  const [h] = mergeResources([R("h", "kms-key", "aws/rds", { hidden: true }), R("h", "kms-key", "aws/rds", { hidden: true, observedAt: 5 }), R("h", "kms-key", "", { observedAt: 3 })]);
  assert.equal(h.hidden, undefined, "the third report doesn't hide it");
  assert.equal(h.observedAt, 5, "the newest observation");
  const [both] = mergeResources([R("b", "iam-role", "r", { hidden: true }), R("b", "iam-role", "r", { hidden: true })]);
  assert.equal(both.hidden, true);
});

test("CC-5: a later report of another kind can't take over a resource's identity", () => {
  const [m] = mergeResources([
    R("rds:acme-production-pg", "rds", "acme-production-pg", { provider: "rds", region: "us-east-1", props: [{ label: "Engine", value: "postgres 16" }] }),
    { key: "rds:acme-production-pg", kind: "vpc", provider: "vpc", name: "stub", region: "", tags: { owner: "data" }, health: "unknown", props: [], facts: { public: true } } as Resource,
  ]);
  assert.deepEqual([m.kind, m.provider, m.name, m.region], ["rds", "rds", "acme-production-pg", "us-east-1"], "the first report owns the identity");
  assert.deepEqual(m.tags, { owner: "data" }, "everything else still merges");
  assert.deepEqual(m.facts, { public: true });
  const arn = "arn:aws:rds:us-east-1:123456789012:db:acme-production-pg";
  const [g] = mergeResources([
    R(arn, "rds", "acme-production-pg", { provider: "rds", region: "us-east-1" }),
    R(arn, "aws-resource", "acme-production-pg", { provider: "catchall", region: "us-east-1", service: "RDS", resourceType: "rds:db", category: "other", source: "resource-explorer" }),
  ]);
  assert.deepEqual([g.kind, g.category, g.service, g.resourceType, g.source], ["rds", undefined, undefined, undefined, undefined], "a generic row can't relabel or re-column it");
  const [same] = mergeResources([R("x", "lambda", "a", { provider: "lambda", region: "us-east-1" }), R("x", "lambda", "b", { provider: "lambda", region: "eu-west-1" })]);
  assert.deepEqual([same.name, same.region], ["b", "eu-west-1"], "same kind: later non-empty fields still win");
});

test("links carry their routing policy onto the edge; the first routing seen stays", () => {
  const zone = R("route53:Z1", "route53-zone", "acme.example");
  const lb = R(keys.loadBalancer("web"), "loadbalancer", "web", { endpoints: ["web-1.us-east-1.elb.amazonaws.com"] });
  const { edges } = infer({
    results: [result([zone, lb], [
      { from: zone.key, to: "web-1.us-east-1.elb.amazonaws.com", kind: "route", label: "api.acme.example", evidence: "A alias (weighted)", routing: { policy: "weighted", weight: 90, setId: "blue" } },
      { from: zone.key, to: lb.key, kind: "route", evidence: "again", routing: { policy: "simple" } },
    ])],
    home: "us-east-1",
    covered: new Set(["elasticloadbalancing:loadbalancer/app@us-east-1"]),
    accountId: "123456789012",
  });
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0].routing, { policy: "weighted", weight: 90, setId: "blue" });
  const plain = infer({ results: [result([zone, lb], [{ from: zone.key, to: lb.key, kind: "route", evidence: "A alias" }])] });
  assert.equal("routing" in plain.edges[0], false, "no routing key when no link had one");
});

// ---------- R14: account- and region-aware ARN resolution ----------

const ACCT = "123456789012";

test("R14: region-aware candidates — short keys only for the console's account, '@region' outside home", () => {
  const rds = (region: string, acct = ACCT) => `arn:aws:rds:${region}:${acct}:db:orders`;
  assert.ok(arnCandidates(rds("us-east-1"), "us-east-1", ACCT).includes("rds:orders"));
  assert.ok(arnCandidates(rds("eu-west-1"), "us-east-1", ACCT).includes("rds:orders@eu-west-1"));
  assert.ok(!arnCandidates(rds("eu-west-1"), "us-east-1", ACCT).includes("rds:orders"), "never the home key for another region");
  assert.deepEqual(arnCandidates(rds("us-east-1", "999999999999"), "us-east-1", ACCT), [rds("us-east-1", "999999999999")], "another account: the ARN only");
  assert.deepEqual(arnCandidates(rds("us-east-1"), "us-east-1"), [rds("us-east-1")], "account unknown on one side: no short key");
  const ecs = arnCandidates(`arn:aws:ecs:eu-west-1:${ACCT}:service/acme-production/api`, "us-east-1", ACCT);
  assert.ok(ecs.includes(keys.ecsService("acme-production", "api", "eu-west-1", "us-east-1")));
  assert.ok(arnCandidates(`arn:aws:ec2:eu-west-1:${ACCT}:instance/i-0abc`, "us-east-1", ACCT).includes("ec2:i-0abc@eu-west-1"));
  assert.ok(arnCandidates(`arn:aws:elasticache:eu-west-1:${ACCT}:replicationgroup:sessions`, "us-east-1", ACCT).includes("elasticache:sessions@eu-west-1"));
  assert.ok(arnCandidates(`arn:aws:elasticloadbalancing:eu-west-1:${ACCT}:loadbalancer/app/web/abc`, "us-east-1", ACCT).includes("elb:web@eu-west-1"));
  // partition and account survive in the ARN-shaped parents
  assert.ok(arnCandidates(`arn:aws-cn:dynamodb:cn-north-1:${ACCT}:table/carts/stream/1`).includes(`arn:aws-cn:dynamodb:cn-north-1:${ACCT}:table/carts`));
  assert.ok(arnCandidates(`arn:aws:secretsmanager:us-east-1:${ACCT}:secret:acme/api-Ab12Cd:password::`).includes(`arn:aws:secretsmanager:us-east-1:${ACCT}:secret:acme/api-Ab12Cd`));
  assert.ok(arnCandidates(`arn:aws:logs:us-east-1:${ACCT}:log-group:/ecs/api:*`).includes(`arn:aws:logs:us-east-1:${ACCT}:log-group:/ecs/api`));
});

test("R14 (REVIEW case): a foreign 'orders' RDS ARN never links to the local rds:orders — it becomes a reference node", () => {
  const app = R(keys.ecsService("prod", "api"), "ecs-service", "api", { aliases: [`arn:aws:ecs:us-east-1:${ACCT}:service/prod/api`] });
  const db = R("rds:orders", "rds", "orders", { aliases: [`arn:aws:rds:us-east-1:${ACCT}:db:orders`] });
  const foreign = "arn:aws:rds:eu-west-1:999999999999:db:orders";
  for (const scope of [{}, { home: "us-east-1", accountId: ACCT }]) {
    const { resources, edges } = infer({ results: [result([app, db], [], [{ from: app.key, refs: [foreign], via: "env REMOTE_DATABASE_ARN" }])], providerOf: () => "ecs", ...scope });
    assert.equal(edge(edges, app.key, db.key), undefined, "no edge to the local database of the same name");
    const ref = resources.find((r) => r.key === foreign)!;
    assert.deepEqual([ref.kind, ref.source, ref.health, ref.facts?.remote, ref.account, ref.region, ref.provider], ["aws-resource", "reference", "unknown", true, "999999999999", "eu-west-1", "ecs"]);
    assert.equal(ref.healthReason, "referenced in configuration — not in this account/region (999999999999/eu-west-1)");
    assert.deepEqual([ref.resourceType, ref.service, ref.name], ["rds:db", "RDS", "orders"]);
    const e = edge(edges, app.key, foreign)!;
    assert.deepEqual([e.kind, e.confidence, e.evidence], ["sql", "mentioned", ["env REMOTE_DATABASE_ARN"]], "the edge keeps its confidence");
  }
  // The same account and the home region still resolve to the short key, and a link to a foreign ARN makes the node too.
  const local = infer({
    results: [result([app, db], [{ from: app.key, to: "arn:aws:sqs:us-east-1:999999999999:partner-inbox", kind: "writes", evidence: "IAM policy" }], [{ from: app.key, refs: [`arn:aws:rds:us-east-1:${ACCT}:db:orders`], via: "env DATABASE_ARN" }])],
    home: "us-east-1", accountId: ACCT,
  });
  assert.ok(edge(local.edges, app.key, db.key));
  assert.equal(edge(local.edges, app.key, "arn:aws:sqs:us-east-1:999999999999:partner-inbox")?.confidence, "config");
  assert.ok(!local.resources.some((r) => r.key.includes("orders") && r.source === "reference"));
});

test("R14: other regions resolve through '@region' keys; a region the console doesn't read is a reference; names stay in scope", () => {
  const home = R("rds:orders", "rds", "orders");
  const eu = R("rds:orders@eu-west-1", "rds", "orders", { region: "eu-west-1" });
  const app = R("svc", "lambda", "svc", { aliases: [`arn:aws:lambda:us-east-1:${ACCT}:function:svc`] });
  const run = (ref: string, extra: Partial<Parameters<typeof infer>[0]> = {}) =>
    infer({ results: [result([home, eu, app], [], [{ from: "svc", refs: [ref], via: "env DB" }])], home: "us-east-1", accountId: ACCT, ...extra });
  assert.ok(edge(run(`arn:aws:rds:eu-west-1:${ACCT}:db:orders`).edges, "svc", eu.key));
  assert.ok(!edge(run(`arn:aws:rds:eu-west-1:${ACCT}:db:orders`).edges, "svc", home.key));
  const ap = run(`arn:aws:rds:ap-south-1:${ACCT}:db:orders`, { regions: ["us-east-1", "eu-west-1"] });
  assert.equal(ap.edges.length, 1);
  assert.equal(ap.edges[0].to, `arn:aws:rds:ap-south-1:${ACCT}:db:orders`);
  assert.match(ap.resources.find((r) => r.key === ap.edges[0].to)!.healthReason!, /\(123456789012\/ap-south-1\)/);
  // A same-account ARN in a covered region that names nothing is just stale: no node, no edge.
  assert.equal(run(`arn:aws:rds:us-east-1:${ACCT}:db:gone`).edges.length, 0);
  // AWS-owned ARNs and patterns are never references.
  assert.equal(run("arn:aws:iam::aws:policy/ReadOnlyAccess arn:aws:s3:::*").edges.length, 0);
  // An alias hit (a parameter's name) must live in the ARN's region.
  const param = R(`arn:aws:ssm:us-east-1:${ACCT}:parameter/acme/api/jwt-key`, "ssm-parameter", "/acme/api/jwt-key", { aliases: ["/acme/api/jwt-key"] });
  const short = infer({ results: [result([param, app], [], [{ from: "svc", refs: [`arn:aws:ssm:us-east-1:${ACCT}:parameter//acme/api/jwt-key`], via: "secret JWT" }])], home: "us-east-1", accountId: ACCT });
  assert.equal(edge(short.edges, "svc", param.key)?.kind, "reads", "an SSM ARN resolves by the parameter's name");
});

test("names and suffixes: secrets, KMS aliases, log groups, instance profiles, Aurora clusters, serverless caches", () => {
  const svc = R("svc", "ecs-service", "svc");
  const secret = R(`arn:aws:secretsmanager:us-east-1:${ACCT}:secret:acme/api-Ab12Cd`, "secret", "acme/api", { aliases: ["acme/api"] });
  const key = R(`arn:aws:kms:us-east-1:${ACCT}:key/1111`, "kms-key", "app", { aliases: ["alias/acme-app"] });
  const logs = R(`arn:aws:logs:us-east-1:${ACCT}:log-group:/ecs/api`, "log-group", "/ecs/api");
  const role = R(`arn:aws:iam::${ACCT}:role/acme-ecs-instance`, "iam-role", "acme-ecs-instance", { region: "global", aliases: ["acme-ecs-instance"] });
  const member = R("rds:acme-analytics-1", "rds", "acme-analytics-1", { aliases: ["aurora:acme-analytics"] });
  const sls = R(`arn:aws:elasticache:us-east-1:${ACCT}:serverlesscache:acme-sessions`, "elasticache-serverless", "acme-sessions", { endpoints: ["acme-sessions-abc123.serverless.use1.cache.amazonaws.com"] });
  const other = R(`arn:aws:elasticache:us-east-1:${ACCT}:serverlesscache:acme-other`, "elasticache-serverless", "acme-other", { endpoints: ["acme-other-def456.serverless.use1.cache.amazonaws.com"] });
  const { edges } = infer({
    results: [result([svc, secret, key, logs, role, member, sls, other], [], [
      { from: "svc", refs: [`${secret.key}:password::`], via: "secret DB_PASSWORD" },
      { from: "svc", refs: [`arn:aws:secretsmanager:us-east-1:${ACCT}:secret:acme/api`], via: "env SECRET_ID" },
      { from: "svc", refs: [`arn:aws:kms:us-east-1:${ACCT}:alias/acme-app`], via: "env KMS_KEY_ARN" },
      { from: "svc", refs: [`${logs.key}:*`], via: "env LOG_GROUP_ARN" },
      { from: "svc", refs: [`arn:aws:iam::${ACCT}:instance-profile/acme-ecs-instance`], via: "env PROFILE" },
      { from: "svc", refs: [`arn:aws:rds:us-east-1:${ACCT}:cluster:acme-analytics`], via: "env ANALYTICS_DB" },
      { from: "svc", refs: ["rediss://acme-sessions-abc123.serverless.use1.cache.amazonaws.com:6379"], via: "env SESSIONS_URL" },
    ])],
    home: "us-east-1", accountId: ACCT,
  });
  assert.deepEqual(edge(edges, "svc", secret.key)?.evidence, ["secret DB_PASSWORD", "env SECRET_ID"], "a JSON-key suffix and a partial ARN both name the secret");
  assert.equal(edge(edges, "svc", secret.key)?.kind, "reads");
  assert.equal(edge(edges, "svc", key.key)?.kind, "uses", "a KMS alias ARN → its key");
  assert.equal(edge(edges, "svc", logs.key)?.kind, "logs");
  assert.equal(edge(edges, "svc", role.key)?.kind, "assumes", "an instance profile → its role (global, by name)");
  assert.equal(edge(edges, "svc", member.key)?.kind, "sql", "a cluster ARN → its member instances");
  assert.equal(edge(edges, "svc", sls.key)?.kind, "cache");
  assert.equal(edge(edges, "svc", other.key), undefined, "serverless caches never match each other by their shared tail");
});

// ---------- R15: several DNS destinations ----------

test("R15 (REVIEW case): a weighted name points at both load balancers; the app links to both, labelled", () => {
  const app = R(keys.ecsService("prod", "api"), "ecs-service", "api");
  const zone = R("route53:Z1", "route53-zone", "example.com");
  const one = R("elb:one", "loadbalancer", "one", { endpoints: ["one.us-east-1.elb.amazonaws.com"] });
  const two = R("elb:two", "loadbalancer", "two", { endpoints: ["two.us-east-1.elb.amazonaws.com"] });
  const records = (r1?: Routing, r2?: Routing) => [
    { from: zone.key, to: one.endpoints![0], kind: "route" as const, label: "api.example.com", evidence: "A alias (weighted)", routing: r1 },
    { from: zone.key, to: two.endpoints![0], kind: "route" as const, label: "api.example.com", evidence: "A alias (weighted)", routing: r2 },
  ];
  const mention = [{ from: app.key, refs: ["https://api.example.com/v1"], via: "env API_URL" }];
  const weighted = infer({ results: [result([app, zone, one, two], records({ policy: "weighted", weight: 50, setId: "a" }, { policy: "weighted", weight: 50, setId: "b" }), mention)] });
  const a = edge(weighted.edges, app.key, one.key)!, b = edge(weighted.edges, app.key, two.key)!;
  assert.deepEqual([a.kind, a.label, a.routing?.weight, b.label, b.confidence], ["http", "weighted 50", 50, "weighted 50", "mentioned"]);
  const failover = infer({ results: [result([app, zone, one, two], records({ policy: "failover", role: "primary" }, { policy: "failover", role: "secondary" }), mention)] });
  assert.deepEqual([edge(failover.edges, app.key, one.key)?.label, edge(failover.edges, app.key, two.key)?.label], ["failover primary", "failover secondary"]);
  const unlabelled = infer({ results: [result([app, zone, one, two], records(), mention)] });
  assert.ok(edge(unlabelled.edges, app.key, one.key) && edge(unlabelled.edges, app.key, two.key), "two records for one name are DNS evidence even without a policy");
  assert.equal(unlabelled.notes.length, 0);
});

test("R15: two unrelated resources claiming one host without DNS evidence stay ambiguous — noted, not linked", () => {
  const app = R("app", "lambda", "app");
  const x = R("x", "ecs-service", "x", { endpoints: ["shop.example.com"] });
  const y = R("y", "apprunner", "y", { endpoints: ["shop.example.com"] });
  const { edges, resources, notes } = infer({ results: [result([app, x, y], [], [{ from: "app", refs: ["https://shop.example.com"], via: "env SHOP_URL" }])] });
  assert.equal(edges.length, 0);
  for (const k of ["x", "y"]) assert.deepEqual(resources.find((r) => r.key === k)!.facts?.ambiguousHost, ["shop.example.com"]);
  assert.equal(resources.find((r) => r.key === "app")!.facts, undefined);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /shop\.example\.com is claimed by 2 resources \(x, y\)/);
});

// ---------- F14 on the map, F72, CloudFormation ----------

test("F14 on the map: no service mesh from a self-referencing group, peer facts on members, evidence merged into known edges", () => {
  const svc = (n: string, extra: Partial<Resource> = {}) => R(keys.ecsService("prod", n), "ecs-service", n, { vpcId: "vpc-1", securityGroups: ["sg-tasks"], ...extra });
  const [api, worker, billing] = [svc("api"), svc("worker"), svc("billing")];
  const db = R("rds:main", "rds", "main", { vpcId: "vpc-1", securityGroups: ["sg-db"], props: [{ label: "Engine", value: "postgres 17" }] });
  const sgRules = [
    { groupId: "sg-tasks", region: "us-east-1", inbound: [{ protocol: "-1", groups: ["sg-tasks"], cidrs: [], prefixLists: [] }] },
    { groupId: "sg-db", region: "us-east-1", inbound: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, groups: ["sg-tasks"], cidrs: [], prefixLists: [] }] },
  ];
  const { edges, resources } = infer({
    results: [
      { resources: [api, worker, billing, db], links: [{ from: api.key, to: worker.key, kind: "http", label: "internal API", evidence: "console.config.json" }], mentions: [] },
      { resources: [], links: [], mentions: [], sgRules },
    ],
  });
  const between = edges.filter((e) => e.from.startsWith("ecs:") && e.to.startsWith("ecs:"));
  assert.deepEqual(between.map((e) => [e.from, e.to, e.confidence, e.label, e.evidence]), [[api.key, worker.key, "config", "internal API", ["console.config.json", "security group sg-tasks allows sg-tasks"]]]);
  assert.deepEqual(resources.find((r) => r.key === api.key)!.facts?.peerGroups, ["sg-tasks (self-referencing, 3 members)"]);
  assert.equal(edges.filter((e) => e.to === db.key).length, 3, "service → database kept");
  assert.equal(edge(edges, api.key, db.key)!.label, "postgres:5432");
});

test("F14 on the map: at most 50 security-group-only edges into one target, with a note", () => {
  const db = R("rds:main", "rds", "main", { securityGroups: ["sg-db"] });
  const fns = Array.from({ length: 60 }, (_, i) => R(`svc-${String(i).padStart(2, "0")}`, "ecs-service", `svc-${i}`, { securityGroups: [`sg-${i}`] }));
  const rules = { "sg-db": [{ fromPort: 5432, toPort: 5432, groups: fns.map((_, i) => `sg-${i}`) }] };
  const { edges, notes } = infer({ results: [result([db, ...fns], [{ from: "svc-59", to: db.key, kind: "sql", evidence: "console.config.json" }])], rules });
  assert.equal(edges.filter((e) => e.to === db.key).length, 51, "50 guesses plus the declared one, which is never capped");
  assert.equal(edge(edges, "svc-59", db.key)?.confidence, "config");
  assert.match(notes.join("\n"), /security groups allow 59 sources into main: showing 50, the other 9/);
});

test("F72: an ALB rule's hosts and a declared label are both kept, AWS first", () => {
  const lb = R("elb:web", "loadbalancer", "web"), svc = R("svc", "ecs-service", "svc");
  const { edges } = infer({
    results: [
      result([lb, svc], [{ from: lb.key, to: svc.key, kind: "route", label: "api.* → :3000", evidence: "console.config.json" }]),
      result([], [{ from: lb.key, to: svc.key, kind: "route", label: "api.example.com", evidence: "listener HTTPS:443 rule 10 → prod-api" }, { from: lb.key, to: svc.key, kind: "route", label: "api.example.com", evidence: "listener HTTPS:443 rule 11 → prod-api" }]),
    ],
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].label, "api.example.com · api.* → :3000");
  const awsFirst = infer({ results: [result([lb, svc], [{ from: lb.key, to: svc.key, kind: "route", label: "api.example.com", evidence: "listener HTTPS:443 rule 10" }, { from: lb.key, to: svc.key, kind: "route", label: "api.* → :3000", evidence: "console.config.json" }])] });
  assert.equal(awsFirst.edges[0].label, "api.example.com · api.* → :3000");
  const mentionOnly = infer({ results: [result([lb, svc], [{ from: lb.key, to: svc.key, kind: "route", label: "api.* → :3000", evidence: "console.config.json" }, { from: lb.key, to: svc.key, kind: "route", label: "tcp", evidence: "security group sg-1 allows sg-2", confidence: "allowed" }])] });
  assert.equal(mentionOnly.edges[0].label, "api.* → :3000", "a guess never relabels a declared edge");
});

test("CloudFormation tags draw stack → resource 'manages' edges", () => {
  const stack = R(`arn:aws:cloudformation:us-east-1:${ACCT}:stack/acme-network/0acme`, "cfn-stack", "acme-network");
  const vpc = R(`arn:aws:ec2:us-east-1:${ACCT}:vpc/vpc-prod`, "vpc", "acme-production", { tags: { "aws:cloudformation:stack-id": stack.key, "aws:cloudformation:logical-id": "Vpc" } });
  const orphan = R("q", "sqs", "q", { tags: { "aws:cloudformation:stack-id": `arn:aws:cloudformation:us-east-1:${ACCT}:stack/gone/1` } });
  const { edges } = infer({ results: [result([stack, vpc, orphan])], home: "us-east-1", accountId: ACCT });
  assert.deepEqual(edges.map((e) => [e.from, e.to, e.kind, e.label, e.evidence]), [[stack.key, vpc.key, "manages", "Vpc", ["tag aws:cloudformation:stack-id"]]]);
});

// ---------- the catch-all's generic rows (B.4) ----------

const infoOfCategory = (type: string) => infoOf(type).category;
const G = (arn: string, resourceType: string, extra: Partial<Resource> = {}): Resource =>
  R(arn, "aws-resource", arn.split(/[:/]/).pop()!, { provider: "catchall", source: "resource-explorer", resourceType, health: "unknown", ...extra });

test("B.4: generic rows fold into first-class resources (tags copied field by field), sub-objects are counted", () => {
  const lb = R("elb:acme-production", "loadbalancer", "acme-production", { provider: "elb", tags: { team: "web" }, aliases: [`arn:aws:elasticloadbalancing:us-east-1:${ACCT}:loadbalancer/app/acme-production/5f2c`] });
  const fn = R(`arn:aws:lambda:us-east-1:${ACCT}:function:orders`, "lambda", "orders", { provider: "lambda" });
  const euDb = R("rds:acme-eu-pg@eu-west-1", "rds", "acme-eu-pg", { region: "eu-west-1", provider: "rds" });
  const generics = [
    G(`arn:aws:elasticloadbalancing:us-east-1:${ACCT}:loadbalancer/app/acme-production/5f2c`, "elasticloadbalancing:loadbalancer/app", { tags: { team: "other", owner: "platform" } }),
    G(fn.key, "lambda:function", { tags: { cost: "orders" }, category: "compute" }),
    G(`arn:aws:rds:eu-west-1:${ACCT}:db:acme-eu-pg`, "rds:db", { region: "eu-west-1" }),
    G(`arn:aws:ec2:us-east-1:${ACCT}:network-interface/eni-1`, "ec2:network-interface"),
    G(`arn:aws:ec2:us-east-1:${ACCT}:network-interface/eni-2`, "ec2:network-interface"),
    G(`arn:aws:ec2:us-east-1:${ACCT}:security-group-rule/sgr-1`, "ec2:security-group-rule"),
  ];
  const { resources, hiddenTypes, notes } = infer({
    results: [result([lb, fn, euDb]), result(generics)], home: "us-east-1", accountId: ACCT,
    covered: new Set(["ec2:security-group-rule@us-east-1", "elasticloadbalancing:loadbalancer/app@us-east-1"]),
  });
  assert.deepEqual(resources.map((r) => r.key).sort(), [euDb.key, fn.key, lb.key].sort(), "every generic row was a duplicate or a sub-object");
  assert.deepEqual(resources.find((r) => r.key === lb.key)!.tags, { team: "web", owner: "platform" }, "only the tags it lacked");
  const f = resources.find((r) => r.key === fn.key)!;
  assert.deepEqual([f.kind, f.provider, f.category, f.source, f.tags], ["lambda", "lambda", undefined, undefined, { cost: "orders" }], "never relabelled");
  assert.deepEqual(hiddenTypes, { "ec2:network-interface": 2, "ec2:security-group-rule": 1 });
  assert.deepEqual(notes, [], "a dropped sub-object is never a key-format bug");
});

test("B.4: covered but unmatched → hidden and flagged once per type; table types hidden; the rest are generic resources", () => {
  const vpc = R(`arn:aws:ec2:us-east-1:${ACCT}:vpc/vpc-prod`, "vpc", "acme-production", { provider: "vpc" });
  const { resources, notes } = infer({
    results: [result([vpc]), result([
      G(`arn:aws:ec2:us-east-1:${ACCT}:vpc/vpc-new`, "ec2:vpc"), G(`arn:aws:ec2:us-east-1:${ACCT}:vpc/vpc-newer`, "ec2:vpc"),
      G(`arn:aws:glue:us-east-1:${ACCT}:database/acme_lake`, "glue:database"),
      G(`arn:aws:iam::${ACCT}:user/acme-ci`, "iam:user", { region: "global" }),
      G(`arn:aws:kendra:us-east-1:${ACCT}:index/abc`, "kendra:index", { service: undefined }),
      G(`arn:aws:sagemaker:us-east-1:${ACCT}:endpoint/acme-recs`, "sagemaker:endpoint"),
      G(`arn:aws:cloudfront::${ACCT}:distribution/E1`, "cloudfront:distribution", { region: "global" }),
    ])],
    home: "us-east-1", accountId: ACCT,
    covered: new Set(["ec2:vpc@us-east-1", "cloudfront:distribution@us-east-1"]),
    unreadable: { "sagemaker:endpoint@us-east-1": "sagemaker couldn't read it (sagemaker:ListEndpoints)" },
  });
  const by = (k: string) => resources.find((r) => r.key.endsWith(k))!;
  assert.deepEqual([by("vpc-new").hidden, by("vpc-new").healthReason], [true, "Covered by vpc but not matched — key-format bug?"]);
  assert.deepEqual(notes, [
    "catch-all: 2 ec2:vpc in us-east-1 covered by vpc but not matched — key-format bug?",
    "catch-all: 1 cloudfront:distribution in global covered by its provider but not matched — key-format bug?",
  ]);
  assert.equal(by("distribution/E1").hidden, true, "a global row is covered by the provider's run wherever it ran");
  assert.equal(by("acme_lake").hidden, true, "table-only type");
  assert.equal(by("user/acme-ci").hidden, true);
  const kendra = by("index/abc");
  assert.deepEqual([kendra.hidden, kendra.service, kendra.category, kendra.healthReason], [undefined, "Kendra", infoOfCategory("kendra:index"), "No dedicated reader for this type yet"]);
  assert.equal(by("endpoint/acme-recs").healthReason, "Listed by Resource Explorer — sagemaker couldn't read it (sagemaker:ListEndpoints)");
});

test("B.4: covered and partly matched → the unmatched rows are stale index entries: left out, one note, no key-format flag", () => {
  // The VPC provider returned both live Elastic IPs; Resource Explorer still indexes one that was released.
  const eip = (id: string) => R(`arn:aws:ec2:us-east-1:${ACCT}:elastic-ip/${id}`, "elastic-ip", id, { provider: "vpc" });
  const live = [eip("eipalloc-a"), eip("eipalloc-b")];
  const { resources, notes } = infer({
    results: [result(live), result([
      G(`arn:aws:ec2:us-east-1:${ACCT}:elastic-ip/eipalloc-a`, "ec2:elastic-ip"),
      G(`arn:aws:ec2:us-east-1:${ACCT}:elastic-ip/eipalloc-b`, "ec2:elastic-ip"),
      G(`arn:aws:ec2:us-east-1:${ACCT}:elastic-ip/eipalloc-gone`, "ec2:elastic-ip"),
    ])],
    home: "us-east-1", accountId: ACCT,
    covered: new Set(["ec2:elastic-ip@us-east-1"]),
  });
  assert.deepEqual(resources.map((r) => r.key).sort(), live.map((r) => r.key).sort(), "the released address is not listed, not even hidden");
  assert.deepEqual(notes, ["catch-all: 1 ec2:elastic-ip in us-east-1 listed by Resource Explorer but not by vpc, which returned the others of that type — stale index entries, left out"]);
});

test("B.4: a Systems Manager managed instance folds into its EC2 instance (tags copied, a Systems Manager prop), never a second row", () => {
  const inst = R("ec2:i-0abc", "ec2-instance", "acme-box", { provider: "ec2", tags: { Name: "acme-box" } });
  const { resources, notes } = infer({
    results: [result([inst]), result([
      G(`arn:aws:ssm:us-east-1:${ACCT}:managed-instance/i-0abc`, "ssm:managed-instance", { tags: { patch: "weekly" } }),
      G(`arn:aws:ssm:us-east-1:${ACCT}:managed-instance/mi-0onprem`, "ssm:managed-instance"),
    ])],
    home: "us-east-1", accountId: ACCT,
  });
  assert.deepEqual(resources.map((r) => r.key).sort(), [inst.key, `arn:aws:ssm:us-east-1:${ACCT}:managed-instance/mi-0onprem`].sort(), "an on-premises node has no instance to fold into");
  const box = resources.find((r) => r.key === inst.key)!;
  assert.deepEqual(box.tags, { Name: "acme-box", patch: "weekly" });
  assert.ok(box.props.some((p) => p.label === "Systems Manager" && p.value === "managed instance"));
  assert.equal(box.aliases?.at(-1), `arn:aws:ssm:us-east-1:${ACCT}:managed-instance/i-0abc`, "its ARN finds the instance, after the instance's own");
  assert.deepEqual(notes, []);
});

test("B.4: generic rows are resolvable by ARN (not as tokens) and keep their Config parent once mapped", () => {
  const svc = R("svc", "ecs-service", "svc");
  const sub = R(`arn:aws:ec2:us-east-1:${ACCT}:subnet/subnet-1`, "subnet", "a", { provider: "vpc" });
  const lake = G(`arn:aws:glue:us-east-1:${ACCT}:database/acme_lake`, "glue:database", { parent: `arn:aws:ec2:us-east-1:${ACCT}:subnet/subnet-1` });
  const kendra = G(`arn:aws:kendra:us-east-1:${ACCT}:index/acme-search-index`, "kendra:index");
  const { edges, resources } = infer({
    results: [result([svc, sub]), result([lake, kendra]), result([], [], [
      { from: "svc", refs: [kendra.key], via: "env SEARCH_INDEX_ARN" }, { from: "svc", refs: ["acme-search-index"], via: "env INDEX_NAME" },
    ])],
    home: "us-east-1", accountId: ACCT,
  });
  assert.deepEqual(edges.map((e) => [e.from, e.to, e.evidence]), [["svc", kendra.key, ["env SEARCH_INDEX_ARN"]]]);
  assert.equal(resources.find((r) => r.key === lake.key)!.parent, sub.key);
});

test("new kinds: mention kinds and the variable-name hints", () => {
  assert.equal(mentionKind("rds-cluster", "env X"), "sql");
  assert.equal(mentionKind("memorydb-cluster", "env X"), "cache");
  assert.equal(mentionKind("secret", "secret DB_PASSWORD"), "reads");
  assert.equal(mentionKind("iam-role", "env ROLE_ARN"), "assumes");
  assert.equal(mentionKind("msk-cluster", "env BROKERS"), "stream");
  assert.equal(mentionKind("classic-elb", "env LEGACY_URL"), "http");
  const svc = R("svc", "lambda", "svc");
  const secret = R(`arn:aws:secretsmanager:us-east-1:${ACCT}:secret:acme-orders-Ab12Cd`, "secret", "acme-orders");
  const db = R("rds:acme-orders", "rds", "acme-orders");
  const both = infer({ results: [result([svc, secret, db], [], [{ from: "svc", refs: ["acme-orders"], via: "env DB_SECRET_NAME" }])] });
  assert.deepEqual(both.edges.map((e) => e.to), [secret.key], "…_SECRET_… is a secret, not the database of the same name");
});

test("Auto Scaling groups resolve by name from an alarm's group pattern (their ARNs carry a UUID)", () => {
  const A = "123456789012";
  const asg = R(`arn:aws:autoscaling:us-east-1:${A}:autoScalingGroup:0f1e2d3c-aaaa-4bbb-8ccc-000000000001:autoScalingGroupName/acme-web`, "asg", "acme-web", { aliases: ["acme-web"] });
  const other = R(`arn:aws:autoscaling:eu-west-1:${A}:autoScalingGroup:0f1e2d3c-aaaa-4bbb-8ccc-000000000002:autoScalingGroupName/acme-web`, "asg", "acme-web", { region: "eu-west-1", aliases: ["acme-web"] });
  const alarm = R(`arn:aws:cloudwatch:us-east-1:${A}:alarm:web-cpu`, "cloudwatch-alarm", "web-cpu");
  const { edges } = infer({
    results: [result([asg, other, alarm], [{ from: alarm.key, to: `arn:aws:autoscaling:us-east-1:${A}:autoScalingGroup:*:autoScalingGroupName/acme-web`, kind: "monitors", evidence: "AWS/EC2 AutoScalingGroupName" }])],
    home: "us-east-1", accountId: A,
  });
  assert.deepEqual(edges.filter((e) => e.kind === "monitors").map((e) => e.to), [asg.key], "the group in the alarm's region, not the eu one of the same name");
});
