// Runs the edge providers (S3, CloudFront, Route 53, Cloudflare) and the compute providers (EC2, Auto Scaling, EKS,
// App Runner, Beanstalk, ECS image deploys) against the simulated account and checks the graph the map depends on:
// which links exist, that they point at names the other simulated providers answer on, that the simulated actions
// change what the panels show, that every action says what it needs and how it is undone and verified, that the live
// protection reads answer (R01), that a stale image-deploy plan is refused (R04), and that a download link never
// reaches the audit summary (R08). The providers import "server-only", which only resolves under the react-server
// condition, so the scenarios run in child processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACM_CERTS, APIGW, BEANSTALK, CLOUDFRONT, EC2, EKS, EU, EXISTING, GLUE, HEALTH_CHECK, KMS_KEYS, LAMBDA, S3, WAF } from "./mock-names.ts";

interface L { from: string; to: string; kind: string; label?: string; evidence: string; routing?: Record<string, unknown> }
interface R {
  key: string; name: string; kind: string; health: string; endpoints?: string[]; aliases?: string[]; lastActivityAt?: number; region: string; tags: Record<string, string>;
  tagsUnread?: boolean; facts?: Record<string, unknown>; enrichment?: Record<string, string>;
}
interface Act {
  provider: string; id: string; iam?: string[]; summary?: string; undo?: string; verifies?: string; retrySafe?: boolean; titles: Record<string, string | null>; echo: string[];
  targets: boolean; auditSummary: boolean;
}
interface Decl { id: string; read: string[]; sensitive: string[]; write: string[]; implicit: string[]; scope?: string; multiRegionMock?: boolean; authoritative: boolean; kinds?: string[] }
interface Out {
  results: Record<string, { resources: R[]; links: L[] }>;
  checkpoints: Record<string, number>;
  eu: Record<string, number>;
  notes: string[];
  enabled: { mock: unknown; awsNoToken: unknown; awsToken: unknown };
  after: Record<string, unknown>;
  actions: Act[];
  decls: Decl[];
}

// What the scenarios share: run every provider of a group, record checkpoints, describe the actions and declarations.
const prelude = (group: string) => `
const { providers } = await import(${JSON.stringify(new URL(`./${group}.ts`, import.meta.url).href)});
const notes = [];
const checkpoints = {};
const ctxFor = (region, id) => ({
  region, home: "us-east-1", regions: ["us-east-1", "eu-west-1"], accountId: "123456789012", mock: true, cap: 2000, signal: new AbortController().signal,
  limit: (fn) => fn(), note: (m) => notes.push(m), checkpoint: (r) => { checkpoints[id] = r.resources.length; },
});
const ctx = ctxFor("us-east-1", "-");
const actx = { region: "us-east-1", mock: true, actor: "test@example.com" };
const by = Object.fromEntries(providers.map((p) => [p.id, p]));
const results = {};
for (const p of providers) results[p.id] = await p.discover(ctxFor("us-east-1", p.id));
const eu = {};
for (const p of providers.filter((p) => p.multiRegionMock)) eu[p.id] = (await p.discover(ctxFor("eu-west-1", p.id + "@eu"))).resources.length;
const res = (id, name) => results[id].resources.find((r) => r.name === name);
const act = (p, id) => by[p].actions.find((a) => a.id === id);
const status = (p) => p.then(() => 200, (e) => e.status ?? e.name ?? 500);
const actions = providers.flatMap((p) => (p.actions ?? []).map((a) => ({
  provider: p.id, id: a.id, iam: a.iam, summary: a.summary, undo: a.undo, verifies: a.verifies, retrySafe: a.retrySafe,
  titles: Object.fromEntries(Object.entries(a.input.properties ?? {}).map(([k, v]) => [k, v.title ?? null])),
  echo: Object.entries(a.input.properties ?? {}).filter(([, v]) => v["x-echo"] === true).map(([k]) => k), targets: !!a.targets, auditSummary: !!a.auditSummary,
})));
const decls = providers.map((p) => ({
  id: p.id, read: p.read, sensitive: p.sensitive ?? [], write: p.write ?? [], implicit: p.implicit ?? [], scope: p.scope, multiRegionMock: p.multiRegionMock,
  authoritative: typeof p.authoritative === "function", kinds: p.kinds,
}));
const after = {};
`;

const edgeScenario = `${prelude("edge")}
const cf = by.cloudflare;
delete process.env.CONSOLE_SOURCE; delete process.env.CLOUDFLARE_API_TOKEN;
const enabled = { mock: cf.enabled() };
process.env.CONSOLE_SOURCE = "aws"; enabled.awsNoToken = cf.enabled();
process.env.CLOUDFLARE_API_TOKEN = "t"; enabled.awsToken = cf.enabled();
delete process.env.CLOUDFLARE_API_TOKEN; process.env.CONSOLE_SOURCE = "mock";

const uploads = res("s3", ${JSON.stringify(S3.uploadsStaging.name)});
const up = { key: "hello.txt", contentBase64: Buffer.from("hi").toString("base64"), contentType: "text/plain" };
after.uploadPlan = await act("s3", "upload-object").plan(uploads, up, actx);
after.upload = await act("s3", "upload-object").run(uploads, up, actx);
after.uploadAgain = await act("s3", "upload-object").run(uploads, up, actx).then(() => "ok", (e) => e.name);
after.uploadTargets = act("s3", "upload-object").targets(uploads, up);
after.listed = (await by.s3.detail(uploads, ctx)).sections.find((s) => s.title === "Objects").table.rows.map((r) => r[0]);
after.download = await act("s3", "download-object").run(uploads, { key: "hello.txt" }, actx);
after.downloadAudit = act("s3", "download-object").auditSummary(after.download, { key: "hello.txt" });
after.deletePlan = await act("s3", "delete-object").plan(uploads, { key: "hello.txt" }, actx);
await act("s3", "delete-object").run(uploads, { key: "hello.txt" }, actx);
after.listedAfterDelete = (await by.s3.detail(uploads, ctx)).sections.find((s) => s.title === "Objects").table.rows.map((r) => r[0]);
after.badKey = await act("s3", "upload-object").plan(uploads, { ...up, key: "/x" }, actx).then(() => "ok", (e) => e.message);
after.folder = (await by.s3.detail(uploads, ctx, { prefix: "uploads/" })).sections.find((s) => s.title === "Objects").table.rows.map((r) => r[0]);
after.s3Tags = await by.s3.authoritative(uploads, actx);
// F25/R18: once the time budget is spent, the remaining buckets keep their place on the map — settings and tags unread,
// one note — instead of every read starting late.
{
  const { mockS3 } = await import(${JSON.stringify(new URL("./mock/s3.ts", import.meta.url).href)});
  const settings = mockS3.settings, realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  mockS3.settings = async (b, io) => { skew = 16_000; return settings(b, io); };
  const lateNotes = [];
  const late = await by.s3.discover({ ...ctx, note: (m) => lateNotes.push(m) }).finally(() => { mockS3.settings = settings; Date.now = realNow; });
  after.late = { states: late.resources.map((r) => r.enrichment?.settings), unread: late.resources.filter((r) => r.tagsUnread).length, unknown: late.resources.filter((r) => r.health === "unknown").length, notes: lateNotes };
}

const shop = res("cloudfront", ${JSON.stringify(CLOUDFRONT.shop.aliases[0])});
after.invalidate = await act("cloudfront", "invalidate").run(shop, { paths: ["/index.html", "/static/*"] }, actx);
after.invalidateBad = await act("cloudfront", "invalidate").plan(shop, { paths: ["/a*b"] }, actx).then(() => "ok", (e) => e.message);
after.cfDetail = (await by.cloudfront.detail(shop, ctx)).sections.map((s) => [s.title, s.table?.rows.length ?? 0, s.table?.rows[0]?.[0] ?? null]);
after.activity = by.cloudfront.activity(shop);
after.cfTags = await by.cloudfront.authoritative(shop, actx);

const zone = results.cloudflare.resources[0];
after.purgePlan = await act("cloudflare", "purge-cache").plan(zone, { urls: ["https://shop.acme-shop.com/index.html"] }, actx);
after.purge = await act("cloudflare", "purge-cache").run(zone, { hosts: ["shop.acme-shop.com"] }, actx);
after.purgeBad = await act("cloudflare", "purge-cache").plan(zone, { urls: ["https://other.example/x"] }, actx).then(() => "ok", (e) => e.message);
after.cfZoneDetail = (await by.cloudflare.detail(zone, ctx)).sections.map((s) => s.title);
after.cfZoneTags = await by.cloudflare.authoritative(zone, actx);
const r53zone = results.route53.resources.find((r) => r.kind === "route53-zone");
after.r53Detail = (await by.route53.detail(r53zone, ctx)).sections.map((s) => [s.title, s.table?.rows.length ?? 0]);
after.r53Activity = by.route53.activity(r53zone);
const hc = results.route53.resources.find((r) => r.kind === "health-check");
after.hcDetail = hc && (await by.route53.detail(hc, ctx)).sections.map((s) => [s.title, s.table?.rows.length ?? 0]);
after.hcActivity = hc && by.route53.activity(hc);
console.log(JSON.stringify({ results, checkpoints, eu, notes, enabled, after, actions, decls }));
`;

const computeScenario = `${prelude("compute")}
const { runAction } = await import(${JSON.stringify(new URL("../inventory-actions.ts", import.meta.url).href)});
const { listEnvs, servicesOf } = await import(${JSON.stringify(new URL("../discovery.ts", import.meta.url).href)});

const bastion = res("ec2", ${JSON.stringify(EC2.bastion.name)});
after.ec2Tags = await by.ec2.authoritative(bastion, actx);
const asg = results.asg.resources[0];
after.asgTags = await by.asg.authoritative(asg, actx);
const cluster = res("eks", ${JSON.stringify(EKS.cluster.name)});
after.eksTags = await by.eks.authoritative(cluster, actx);
const rec = results.eks.resources.find((r) => r.kind === "eks-workload" && r.name === ${JSON.stringify(EKS.workloads[0].name)});
after.workloadTags = await by.eks.authoritative(rec, actx);
after.apprunnerTags = await by.apprunner.authoritative(results.apprunner.resources[0], actx);
after.beanstalkTags = await by.beanstalk.authoritative(results.beanstalk.resources[0], actx);

// R04: deploy a new tag of the staging api's own image.
const env = (await listEnvs()).find((e) => e.id === "staging");
const svc = (await servicesOf(env.cluster, env.region)).find((s) => s.name === "api");
const key = "ecs:service/" + env.cluster + "/api";
const r = { key, kind: "ecs-service", provider: "ecs", name: "api", region: env.region, tags: svc.tags, health: "ok", props: [] };
const image = svc.taskDef.image.replace(/:[^:/@]+$/, "") + ":r04-test";
const deploy = act("ecs-image", "deploy-image");
after.imageTags = await by["ecs-image"].authoritative(r, actx);
after.imageTargets = deploy.targets(r, { image });
const plan = await deploy.plan(r, { image }, actx);
after.imagePlan = { echo: plan.echo, summary: plan.summary };
const live = plan.echo.expectedRevision;
// The service moved on since an older plan: refused, nothing registered.
after.staleRun = await status(deploy.run(r, { image, expectedRevision: live - 1 }, actx));
after.staleMessage = await deploy.run(r, { image, expectedRevision: live - 1 }, actx).then(() => "", (e) => e.message);
// No revision sent back: the last plan for exactly this change counts (here made to look older).
globalThis.__ecsImagePlans.get(key + "|api|" + image).revision = live - 1;
after.staleRecalled = await status(deploy.run(r, { image }, actx));
after.revsAfterRefusals = (await servicesOf(env.cluster, env.region)).find((s) => s.name === "api").taskDef.revision;
// Through the action runner (lock, live tags, audit): a stale revision is still refused.
const who = { user: { id: "u1", email: "op@example.com", role: "operator" }, actor: "op@example.com" };
after.runnerStale = await runAction({ key, provider: "ecs-image", action: "deploy-image", input: { image, expectedRevision: live - 1 }, dryRun: false, confirm: "api", reason: "r04 test" }, who)
  .then(() => [200, ""], (e) => [e.status ?? 500, e.message]);
// The plan's own revision: deployed.
await deploy.plan(r, { image }, actx);
const ok = await deploy.run(r, { image, expectedRevision: live }, actx);
after.deployed = { fromRevision: ok.fromRevision, taskDefinition: ok.taskDefinition };
console.log(JSON.stringify({ results, checkpoints, eu, notes, after, actions, decls }));
process.exit(0);
`;

function run(scenario: string): Out {
  const dir = mkdtempSync(path.join(tmpdir(), "edge-compute-mock-"));
  try {
    const out = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], {
      encoding: "utf8",
      env: { ...process.env, CONSOLE_SOURCE: "mock", CLOUDFLARE_API_TOKEN: "", CONSOLE_DATA_DIR: dir, CONSOLE_SQLITE_PATH: ":memory:", CONSOLE_CONFIG: "", AUTH_MODE: "dev", NODE_ENV: "test" },
      timeout: 90_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out.trim().split("\n").pop()!) as Out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const o = run(edgeScenario);
const c = run(computeScenario);
const link = (p: string, to: string, kind = "route") => o.results[p].links.find((l) => l.to === to && l.kind === kind);

test("S3: every bucket (the eu-west-1 replica with its own region), thumbnailer notifications, logs written by the ALB, KMS keys, replication, old backups idle-worthy", () => {
  const { resources } = o.results.s3;
  assert.deepEqual(resources.map((r) => r.name).sort(), [...Object.values(S3).map((b) => b.name), EU.s3Replica.name, GLUE.lakeBucket].sort());
  assert.ok(resources.every((r) => r.key === `arn:aws:s3:::${r.name}` && r.health === "ok" && !r.tagsUnread && r.enrichment?.settings === "ok"));
  assert.deepEqual(resources.filter((r) => r.region !== "us-east-1").map((r) => [r.name, r.region]), [[EU.s3Replica.name, "eu-west-1"]]);
  const prod = link("s3", LAMBDA.thumbnailerProd.arn, "event")!;
  assert.equal(prod.from, S3.uploads.arn);
  assert.equal(prod.evidence, "s3:ObjectCreated:* prefix uploads/");
  assert.equal(link("s3", LAMBDA.thumbnailerStaging.arn, "event")?.from, S3.uploadsStaging.arn);
  assert.equal(link("s3", S3.logs.arn, "writes")?.from, `elb:${EXISTING.alb.name}`);
  assert.equal(link("s3", EU.s3Replica.arn, "writes")?.from, S3.assets.arn, "replication → the eu copy");
  assert.deepEqual(o.results.s3.links.filter((l) => l.kind === "encrypts").map((l) => [l.from, l.to]).sort(), [[KMS_KEYS.legacy.arn, S3.backupsOld.arn], [KMS_KEYS.app.arn, `arn:aws:s3:::${GLUE.lakeBucket}`], [KMS_KEYS.app.arn, S3.uploads.arn]]);
  const old = resources.find((r) => r.name === S3.backupsOld.name)!;
  assert.ok(Date.now() - old.lastActivityAt! >= 399 * 86_400_000);
  const assets = resources.find((r) => r.name === S3.assets.name)!;
  assert.ok(assets.endpoints!.includes(S3.assets.domain));
  assert.equal(o.checkpoints.s3, resources.length, "R18: the bucket list was handed over before the settings reads");
});

test("CloudFront: shop serves the assets bucket by default and /api/* from the ALB; its certificate and web ACL point at it; staging from its box", () => {
  const shop = `arn:aws:cloudfront::123456789012:distribution/${CLOUDFRONT.shop.id}`;
  assert.deepEqual([link("cloudfront", S3.assets.arn)?.from, link("cloudfront", S3.assets.arn)?.label], [shop, "default → assets"]);
  assert.deepEqual([link("cloudfront", EXISTING.alb.dns)?.from, link("cloudfront", EXISTING.alb.dns)?.label], [shop, "/api/* → alb"]);
  assert.equal(link("cloudfront", S3.logs.arn, "writes")?.from, shop);
  assert.equal(link("cloudfront", "staging-origin.acme.example")?.from, `arn:aws:cloudfront::123456789012:distribution/${CLOUDFRONT.staging.id}`);
  assert.equal(link("cloudfront", shop, "tls")?.from, ACM_CERTS.cloudfront.arn);
  assert.equal(link("cloudfront", shop, "protects")?.from, WAF.cloudfront.arn);
  const r = o.results.cloudfront.resources.find((x) => x.key === shop)!;
  assert.deepEqual(r.endpoints, [CLOUDFRONT.shop.domain, ...CLOUDFRONT.shop.aliases]);
  assert.equal(r.region, "global");
  assert.deepEqual([r.tags, r.tagsUnread, r.enrichment], [{ Environment: "production" }, undefined, { tags: "ok", logging: "ok" }]);
  assert.equal(o.checkpoints.cloudfront, 2);
});

test("Route 53: every record lands on the resource that answers it (the API one as a failover primary); plumbing records are skipped; a health check watches api.acme.example", () => {
  const records = o.results.route53.links.filter((l) => l.from === "arn:aws:route53:::hostedzone/Z0ACMEEXAMPLE");
  const byLabel = Object.fromEntries(records.map((l) => [l.label, l.to]));
  assert.deepEqual(byLabel, {
    "www.acme.example": CLOUDFRONT.shop.domain,
    "api.acme.example (failover primary)": EXISTING.alb.dns,
    [APIGW.publicHttp.customDomain]: "d-9x8w7v6u5t.execute-api.us-east-1.amazonaws.com",
    "staging.acme.example": CLOUDFRONT.staging.domain,
    "bastion.acme.example": EC2.bastion.publicIp,
    "legacy-admin.acme.example": BEANSTALK.env.cname,
  });
  assert.ok(records.every((l) => l.kind === "route"));
  assert.deepEqual(records.find((l) => l.label?.startsWith("api."))?.routing, { policy: "failover", role: "primary", setId: "api-primary" });
  const hc = o.results.route53.resources.find((r) => r.kind === "health-check")!;
  assert.deepEqual([hc.key, hc.name, hc.health, hc.region, hc.tags.Environment], [HEALTH_CHECK.arn, "acme-api-health", "ok", "global", "production"]);
  assert.deepEqual(o.results.route53.links.filter((l) => l.from === HEALTH_CHECK.arn).map((l) => [l.to, l.kind]), [[HEALTH_CHECK.fqdn, "monitors"]]);
  const zone = o.results.route53.resources.find((r) => r.kind === "route53-zone")!;
  assert.deepEqual([zone.tags, zone.tagsUnread], [{ Owner: "platform" }, undefined]);
});

test("Cloudflare: shop is a proxied CNAME to the shop distribution, status goes outside AWS", () => {
  const shop = link("cloudflare", CLOUDFRONT.shop.domain)!;
  assert.deepEqual([shop.from, shop.label], ["cloudflare:zone/cf0acme1shop2zone3", "shop.acme-shop.com (proxied)"]);
  assert.equal(link("cloudflare", "acme.statuspage.io")?.label, "status.acme-shop.com");
  assert.equal(o.results.cloudflare.links.length, 2);
  assert.deepEqual(o.enabled.mock, { ok: true });
  assert.equal((o.enabled.awsNoToken as { ok: boolean }).ok, false);
  assert.deepEqual(o.enabled.awsToken, { ok: true });
});

test("edge links resolve inside the simulated account (own resources or names other providers answer on)", () => {
  const all = Object.values(o.results).flatMap((r) => r.resources);
  const known = new Set([...all.flatMap((r) => [r.key, ...(r.endpoints ?? []), ...(r.aliases ?? [])])]);
  const elsewhere = new Set([
    EXISTING.alb.dns, `elb:${EXISTING.alb.name}`, LAMBDA.thumbnailerProd.arn, LAMBDA.thumbnailerStaging.arn, EC2.bastion.publicIp, BEANSTALK.env.cname,
    "d-9x8w7v6u5t.execute-api.us-east-1.amazonaws.com", "staging-origin.acme.example", "acme.statuspage.io", // the last two: outside the account (externals)
    KMS_KEYS.app.arn, KMS_KEYS.legacy.arn, ACM_CERTS.cloudfront.arn, WAF.cloudfront.arn, // the KMS, ACM and WAF providers' keys
    HEALTH_CHECK.fqdn, // a name the zone's record teaches the inventory (→ the ALB)
  ]);
  const links = Object.values(o.results).flatMap((r) => r.links);
  for (const l of links) {
    assert.ok(known.has(l.from) || elsewhere.has(l.from), `unresolved from ${l.from}`);
    assert.ok(known.has(l.to) || elsewhere.has(l.to), `unresolved to ${l.to}`);
  }
  assert.deepEqual(o.notes, []);
});

test("simulated edge actions change the simulation: upload, list, download, delete, invalidate, purge", () => {
  const a = o.after as Record<string, never>;
  assert.match((a.uploadPlan as { summary: string }).summary, /Upload hello.txt \(2 B\)/);
  assert.equal((a.upload as { bytes: number }).bytes, 2);
  assert.equal(a.uploadAgain, "PreconditionFailed");
  assert.deepEqual(a.uploadTargets, [`arn:aws:s3:::${S3.uploadsStaging.name}/hello.txt`], "the object is a lock target (mutation-keys: s3:<bucket>/<key>)");
  assert.ok((a.listed as string[]).includes("hello.txt"));
  assert.ok(!(a.listedAfterDelete as string[]).includes("hello.txt"));
  assert.match((a.download as { url: string }).url, /^data:text\/plain;base64,aGk=$/);
  // The runner, not the plan, decides what must be typed (the bucket name for this danger action).
  assert.equal((a.deletePlan as { confirm?: string }).confirm, undefined);
  assert.match((a.deletePlan as { warnings: string[] }).warnings[0], /permanently/);
  assert.match(a.badKey, /start with \//);
  assert.deepEqual(a.folder, ["uploads/test-cat.jpg"]);
  assert.match((a.invalidate as { invalidationId: string }).invalidationId, /^I/);
  assert.match(a.invalidateBad, /only end/);
  const inv = (a.cfDetail as [string, number, string | null][]).find(([t]) => t === "Invalidations")!;
  assert.deepEqual([inv[1], inv[2]], [2, (a.invalidate as { invalidationId: string }).invalidationId]);
  assert.deepEqual((a.activity as { dims: Record<string, string>; required?: boolean }[])[0], {
    namespace: "AWS/CloudFront", metric: "Requests", dims: { DistributionId: CLOUDFRONT.shop.id, Region: "Global" }, stat: "Sum", label: "Requests", region: "us-east-1", required: true,
  });
  assert.match((a.purgePlan as { summary: string }).summary, /Purge 1 URL/);
  assert.match((a.purge as { purgeId: string }).purgeId, /^purge-/);
  assert.match(a.purgeBad, /not in acme-shop.com/);
  assert.ok((a.cfZoneDetail as string[]).includes("Recent purges (simulated)"));
  assert.deepEqual(a.r53Detail, [["Delegation", 0], ["Records", 12]]);
  assert.equal((a.r53Activity as { metric: string; required?: boolean }[])[0].metric, "DNSQueries");
  assert.equal((a.r53Activity as { required?: boolean }[])[0].required, true);
  assert.deepEqual(a.hcDetail, [["Checkers", 8]]);
  assert.deepEqual(a.hcActivity, []);
});

test("F25/R18: past the time budget the remaining buckets stay on the map, their settings and tags unread, with one note", () => {
  const late = o.after.late as { states: string[]; unread: number; unknown: number; notes: string[] };
  assert.deepEqual(late.states.slice(0, 1), ["ok"]);
  assert.ok(late.states.slice(1).every((x) => x === "skipped"), late.states.join(","));
  assert.equal(late.unread, late.states.length - 1);
  assert.equal(late.unknown, late.states.length - 1);
  assert.deepEqual(late.notes, [`s3: bucket settings: ${late.states.length - 1} not read (discovery time budget)`]);
});

test("R08: the download link never reaches the audit summary — the object and its expiry do", () => {
  const sum = o.after.downloadAudit as Record<string, unknown>;
  assert.deepEqual(sum, { bucket: S3.uploadsStaging.name, key: "hello.txt", expiresInSeconds: 300 });
  assert.ok(!JSON.stringify(sum).includes("data:") && !/X-Amz-Signature|https?:/.test(JSON.stringify(sum)));
});

test("R01: live protection reads answer for every provider with actions (Cloudflare: no tags, protection comes from its environment)", () => {
  const a = { ...o.after, ...c.after } as Record<string, { tags: Record<string, string> }>;
  assert.deepEqual(a.s3Tags, { tags: { Environment: "staging" } });
  assert.deepEqual(a.cfTags, { tags: { Environment: "production" } });
  assert.deepEqual(a.cfZoneTags, { tags: {} });
  assert.equal(a.ec2Tags.tags.Name, EC2.bastion.name);
  assert.equal(a.asgTags.tags["eks:nodegroup-name"], EKS.nodegroup.name);
  assert.deepEqual(a.eksTags.tags, { Environment: "production", Team: "data" });
  assert.deepEqual(a.workloadTags.tags, { app: EKS.workloads[0].name, "app.kubernetes.io/part-of": "ml-platform" });
  assert.equal(a.apprunnerTags.tags.Environment, "staging");
  assert.equal(a.beanstalkTags.tags.Owner, "back-office");
  assert.equal(typeof a.imageTags.tags, "object");
  for (const d of [...o.decls, ...c.decls]) if (d.write.length) assert.ok(d.authoritative, `${d.id} has actions but no authoritative() read`);
});

test("R04: an image deploy locks the canonical service and refuses a plan whose task definition moved on", () => {
  const a = c.after as Record<string, unknown>;
  assert.deepEqual(a.imageTargets, ["ecs:service/acme-staging/api"]);
  const live = (a.imagePlan as { echo: { expectedRevision: number } }).echo.expectedRevision;
  assert.ok(Number.isInteger(live) && live > 1, JSON.stringify(a.imagePlan));
  assert.match((a.imagePlan as { summary: string }).summary, new RegExp(`from revision ${live}\\)`));
  assert.equal(a.staleRun, 409);
  assert.equal(a.staleMessage, `task definition changed since the plan (rev ${live - 1} → ${live}) — re-plan`);
  assert.equal(a.staleRecalled, 409, "without an echoed revision, the last plan of this exact change counts");
  assert.equal(a.revsAfterRefusals, live, "a refused deploy registers nothing");
  assert.deepEqual(a.runnerStale, [409, a.staleMessage], "the action runner (lock, live tags, audit intent) passes the refusal on");
  assert.deepEqual((a.deployed as { fromRevision: number }).fromRevision, live);
  assert.match((a.deployed as { taskDefinition: string }).taskDefinition, new RegExp(`:${live + 1}$`));
});

test("compute: regional providers answer per region (the simulated estate is in us-east-1), wire roles, keys and logs, and hand over their lists first", () => {
  assert.deepEqual(c.eu, { ec2: 0, asg: 0, eks: 0, apprunner: 0, beanstalk: 0 }, "nothing simulated in eu-west-1");
  assert.deepEqual(o.eu, {}, "the edge providers are global");
  const bastion = c.results.ec2.resources.find((r) => r.name === EC2.bastion.name)!;
  assert.deepEqual([bastion.key, bastion.region, bastion.facts?.public], [`ec2:${EC2.bastion.id}`, "us-east-1", true]);
  assert.ok(bastion.aliases!.includes(`arn:aws:ec2:us-east-1:123456789012:instance/${EC2.bastion.id}`));
  const box = c.results.ec2.resources.find((r) => r.key === `ec2:${EXISTING.stagingBox.id}`)!;
  assert.ok(box, "the staging ECS host joins from discovery");
  assert.ok(c.results.ec2.links.some((l) => l.from === box.key && l.to === EXISTING.stagingBox.instanceProfile && l.kind === "assumes"));
  const cluster = c.results.eks.resources.find((r) => r.kind === "eks-cluster")!;
  const kinds = (from: string) => c.results.eks.links.filter((l) => l.from === from || l.to === from).map((l) => l.kind);
  for (const k of ["assumes", "encrypts", "logs"]) assert.ok(kinds(cluster.key).includes(k), `EKS ${k}`);
  assert.ok(c.results.eks.links.some((l) => l.from === KMS_KEYS.app.arn && l.to === cluster.key));
  const preview = c.results.apprunner.resources[0];
  assert.ok(c.results.apprunner.links.some((l) => l.from === preview.key && l.kind === "pulls" && l.to === "arn:aws:ecr:us-east-1:123456789012:repository/acme/storefront-api"));
  const eb = c.results.beanstalk.resources[0];
  assert.deepEqual(c.results.beanstalk.links.filter((l) => l.kind === "assumes").map((l) => l.to), [
    "arn:aws:iam::123456789012:instance-profile/aws-elasticbeanstalk-ec2-role", "arn:aws:iam::123456789012:role/aws-elasticbeanstalk-service-role",
  ]);
  assert.ok(eb && !eb.tagsUnread);
  assert.equal(c.checkpoints.eks, 1, "the cluster before its workloads");
  for (const d of c.decls.filter((x) => x.id !== "ecs-image")) assert.deepEqual([d.id, d.scope, d.multiRegionMock], [d.id, "regional", true]);
  assert.equal(c.decls.find((d) => d.id === "ecs-image")?.scope, "home");
  for (const d of o.decls) assert.equal(d.scope, "global", d.id);
});

test("every action says what it needs (iam), what it does, how it is undone and verified, whether a retry is safe, and labels its fields; writes equal the actions' IAM", () => {
  const all = [...o.actions, ...c.actions];
  assert.equal(all.length, 3 + 1 + 1 + 3 + 1 + 3 + 3 + 2 + 1);
  for (const a of all) {
    const what = `${a.provider}.${a.id}`;
    assert.ok(a.iam?.length, `${what}: iam`);
    assert.ok(a.summary && a.summary.length > 20 && !a.summary.includes("Returns"), `${what}: summary`);
    assert.ok(a.undo, `${what}: undo`);
    assert.ok(a.verifies, `${what}: verifies`);
    assert.equal(typeof a.retrySafe, "boolean", `${what}: retrySafe`);
    for (const [field, title] of Object.entries(a.titles)) assert.ok(title, `${what}.${field}: title`);
  }
  const retry = Object.fromEntries(all.map((a) => [`${a.provider}.${a.id}`, a.retrySafe]));
  assert.deepEqual([retry["ec2.stop"], retry["ec2.start"], retry["ec2.reboot"], retry["ecs-image.deploy-image"]], [true, true, true, false], "F31");
  assert.equal(all.find((a) => a.provider === "ecs-image")?.targets, true);
  // R04: the plan's revision is a field forms fill from plan.echo, never one a person types; no other action has one.
  assert.deepEqual(all.filter((a) => a.echo.length).map((a) => [`${a.provider}.${a.id}`, a.echo]), [["ecs-image.deploy-image", ["expectedRevision"]]]);
  assert.equal(all.find((a) => a.id === "download-object")?.auditSummary, true);
  // Each provider's write list is exactly what its actions need, beyond the reads, sensitive reads and implicit grants.
  for (const d of [...o.decls, ...c.decls]) {
    const need = new Set(all.filter((a) => a.provider === d.id).flatMap((a) => a.iam ?? []));
    const extra = [...need].filter((x) => !d.write.includes(x) && !d.read.includes(x) && !d.sensitive.includes(x) && !d.implicit.includes(x));
    assert.deepEqual(extra, [], `${d.id}: actions need actions it doesn't declare`);
    assert.deepEqual(d.write.filter((x) => !need.has(x)), [], `${d.id}: writes no action needs`);
  }
});

test("permission lists: object reads are sensitive, writes separate, Cloudflare lists token scopes, live tag reads declared", () => {
  const iam = Object.fromEntries([...o.decls, ...c.decls].map((d) => [d.id, d]));
  assert.deepEqual(iam.s3.sensitive, ["s3:GetObject"]);
  assert.deepEqual(iam.s3.write, ["s3:PutObject", "s3:DeleteObject"]);
  assert.ok(!iam.s3.read.includes("s3:GetObject"));
  assert.deepEqual(iam.cloudfront.write, ["cloudfront:CreateInvalidation"]);
  assert.deepEqual(iam.route53.write, []);
  assert.ok(iam.route53.read.includes("route53:ListHealthChecks") && iam.route53.read.includes("route53:GetHealthCheckStatus"));
  assert.ok([...iam.cloudflare.read, ...iam.cloudflare.write].every((s: string) => s.startsWith("cloudflare:")));
  assert.ok(iam.ec2.read.includes("ec2:DescribeTags"));
  assert.ok(iam.asg.read.includes("autoscaling:DescribeTags"));
  assert.deepEqual(iam["ecs-image"].read, ["ecs:ListTagsForResource"]);
});
