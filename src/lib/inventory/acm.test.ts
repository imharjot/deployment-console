import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { acmDetail, acmResult, needsDetail, type RawCert } from "./acm.ts";
import { simAcm } from "../server/providers/mock/acm.ts";

const R = "us-east-1";
const A = "123456789012";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
const SENTINEL = "SENTINEL-acm-93be51";
const arn = (id: string) => `arn:aws:acm:${R}:${A}:certificate/${id}`;
const ALB = `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/app/shop/0123456789abcdef`;
const cert = (id: string, o: Partial<RawCert>): RawCert => ({
  CertificateArn: arn(id), DomainName: `${id}.acme.example`, Status: "ISSUED", Type: "AMAZON_ISSUED", KeyAlgorithm: "RSA-2048", InUse: false, RenewalEligibility: "ELIGIBLE",
  NotAfter: new Date(NOW + 200 * DAY), tags: [], enrichment: { tags: "ok" }, ...o,
});

// Golden: ListCertificates summaries plus DescribeCertificate where the provider reads it. The certificate body and
// private key never come from these calls; they carry the sentinel to prove unknown fields are never copied.
const GOLDEN: RawCert[] = [
  cert("in-use", { InUse: true, detail: { InUseBy: [ALB], DomainValidationOptions: [{ DomainName: "in-use.acme.example", ValidationMethod: "DNS", ValidationStatus: "SUCCESS" }], Certificate: SENTINEL } as never, enrichment: { detail: "ok", tags: "ok" }, tags: [{ Key: "Environment", Value: "production" }] }),
  cert("failed-unused", { Status: "FAILED", NotAfter: undefined, RenewalEligibility: "INELIGIBLE", detail: { InUseBy: [], FailureReason: "CAA_ERROR" }, PrivateKey: SENTINEL } as never),
  cert("failed-used", { Status: "VALIDATION_TIMED_OUT", InUse: true, detail: { InUseBy: [ALB] } }),
  cert("pending", { Status: "PENDING_VALIDATION", NotAfter: undefined, detail: { DomainValidationOptions: [{ DomainName: "pending.acme.example", ValidationStatus: "PENDING_VALIDATION", ValidationMethod: "DNS", ResourceRecord: { Name: "_a1.pending.acme.example.", Type: "CNAME", Value: "_b2.acm-validations.aws." } }] } }),
  cert("imported-soon", { Type: "IMPORTED", RenewalEligibility: "INELIGIBLE", NotAfter: new Date(NOW + 20 * DAY) }),
  cert("auto-soon", { NotAfter: new Date(NOW + 20 * DAY) }), // eligible, nothing wrong with the renewal yet: ok
  cert("renewal-failed", { NotAfter: new Date(NOW + 20 * DAY), detail: { RenewalSummary: { RenewalStatus: "FAILED" } } }),
  cert("days-left-5", { NotAfter: new Date(NOW + 5 * DAY) }),
  cert("expired", { Status: "EXPIRED", NotAfter: new Date(NOW - 3 * DAY) }),
  cert("unread", { InUse: true, tags: undefined, enrichment: { detail: "denied", tags: "denied" } }),
];
const result = () => acmResult(GOLDEN, { now: NOW });
const byId = (id: string) => result().resources.find((r) => r.key === arn(id))!;

test("ACM: key is the ARN; the domain is a prop — never an endpoint or an alias, and not the bare name", () => {
  const r = byId("in-use");
  assert.equal(r.kind, "acm-certificate");
  assert.equal(r.name, "in-use.acme.example · in-use");
  assert.equal(r.endpoints, undefined);
  assert.equal(r.aliases, undefined);
  assert.equal(r.props.find((p) => p.label === "Domain")?.value, "in-use.acme.example");
  assert.deepEqual(r.tags, { Environment: "production" });
  for (const x of result().resources) assert.ok(!(x.aliases ?? []).concat(x.endpoints ?? []).some((a) => a.includes("acme.example")));
});

test("ACM: InUseBy → tls links; facts notAfter, inUse, autoRenew, state", () => {
  assert.deepEqual(result().links.filter((l) => l.from === arn("in-use")), [{ from: arn("in-use"), to: ALB, kind: "tls", label: "serves", evidence: "ACM InUseBy" }]);
  assert.deepEqual(byId("in-use").facts, { inUse: true, autoRenew: true, state: "ISSUED", notAfter: new Date(NOW + 200 * DAY).toISOString() });
  assert.deepEqual(byId("imported-soon").facts?.autoRenew, false);
  assert.equal(byId("unread").props.find((p) => p.label === "In use by")?.value, "users not read (denied)");
  assert.equal(byId("unread").tagsUnread, true);
});

test("ACM: health — expiry windows, renewal, validation; FAILED and unused is a warning 'safe to delete'", () => {
  const h = (id: string) => [byId(id).health, byId(id).healthReason];
  assert.deepEqual(h("in-use"), ["ok", undefined]);
  assert.deepEqual(h("failed-unused"), ["warning", "validation failed — unused, safe to delete"]);
  assert.deepEqual(h("failed-used"), ["warning", "validation failed"]);
  assert.deepEqual(h("pending"), ["warning", "waiting for validation: create _a1.pending.acme.example. CNAME _b2.acm-validations.aws."]);
  assert.deepEqual(h("imported-soon"), ["warning", "expires in 20 days (imported — renew it yourself)"]);
  assert.deepEqual(h("auto-soon"), ["ok", undefined]);
  assert.deepEqual(h("renewal-failed"), ["warning", "expires in 20 days (renewal failed)"]);
  assert.deepEqual(h("days-left-5"), ["error", "expires in 5 days"]);
  assert.deepEqual(h("expired"), ["error", "expired"]);
});

test("ACM: DescribeCertificate only for in-use or problem certificates", () => {
  assert.equal(needsDetail(GOLDEN[0], NOW), true);
  assert.equal(needsDetail(cert("quiet", {}), NOW), false);
  assert.equal(needsDetail(cert("soon", { NotAfter: new Date(NOW + 10 * DAY) }), NOW), true);
  assert.equal(needsDetail(GOLDEN[1], NOW), true);
});

test("ACM: no secret sentinel in resources or detail; detail lists validation records and users", () => {
  assert.ok(!JSON.stringify(result()).includes(SENTINEL));
  const d = acmDetail(arn("in-use"), GOLDEN[0]);
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
  assert.deepEqual(d.sections.map((s) => s.title), ["Certificate", "Domain validation", "In use by", "Tags"]);
  assert.deepEqual(d.sections[2].table?.rows, [[ALB]]);
});

test("ACM: the Acme simulation — ALB, API and CloudFront certificates in use, the failed one a warning and unused; eu-west-1 has its own", () => {
  const home = acmResult(simAcm("us-east-1", NOW), { now: NOW });
  assert.deepEqual(home.resources.map((r) => [r.name.split(" · ")[0], r.health, r.facts?.inUse]), [["*.acme.dev", "ok", true], ["api-public.acme.example", "ok", true], ["www.acme.example", "ok", true], ["old.acme.example", "warning", false]]);
  assert.equal(home.links.length, 3);
  const eu = acmResult(simAcm("eu-west-1", NOW), { now: NOW }).resources;
  assert.deepEqual(eu.map((r) => [r.region, r.health]), [["eu-west-1", "ok"]]);
  assert.deepEqual(simAcm("ap-south-1", NOW), []);
});

// The provider's I/O: every key type is listed (the default is RSA only), the home run adds a us-east-1 pass when no
// run covers us-east-1 (CloudFront certificates live there), and DescribeCertificate runs only for in-use or problem
// certificates. providers/acm.ts imports "server-only": child process, react-server condition, the SDK's send() faked.
test("ACM provider: all key types, the us-east-1 pass from the home run only, DescribeCertificate only where needed", () => {
  const provider = new URL("../server/providers/acm.ts", import.meta.url).href;
  const script = `
    const { ACMClient } = await import("@aws-sdk/client-acm");
    const calls = [];
    const far = new Date(Date.now() + 200 * 86400000);
    const summary = (region, id, o) => ({ CertificateArn: "arn:aws:acm:" + region + ":${A}:certificate/" + id, DomainName: id + ".acme.example", Status: "ISSUED", Type: "AMAZON_ISSUED", InUse: false, RenewalEligibility: "ELIGIBLE", NotAfter: far, ...o });
    ACMClient.prototype.send = async function (cmd) {
      const op = cmd.constructor.name.replace(/Command$/, ""), i = cmd.input, region = await this.config.region();
      calls.push([op, region, i.CertificateArn?.split("/").pop() ?? null, i.Includes?.keyTypes?.length ?? null]);
      if (op === "ListCertificates") return { CertificateSummaryList: region === "us-east-1" ? [summary(region, "cf", { InUse: true })] : [summary(region, "alb", { InUse: true }), summary(region, "quiet", {}), summary(region, "failed", { Status: "FAILED", NotAfter: undefined })] };
      if (op === "DescribeCertificate") return { Certificate: { InUseBy: i.CertificateArn.endsWith("/alb") ? ["arn:aws:elasticloadbalancing:ap-south-1:${A}:loadbalancer/app/x/1"] : [] } };
      if (op === "ListTagsForCertificate") return { Tags: [] };
      throw new Error("unexpected " + op);
    };
    const { acmProvider } = await import(${JSON.stringify(provider)});
    const run = async (o) => {
      calls.length = 0;
      const ctx = { accountId: "${A}", mock: false, cap: 2000, signal: new AbortController().signal, limit: (fn) => fn(), note: () => {}, ...o };
      const r = await acmProvider.discover(ctx);
      return { calls: [...calls], keys: r.resources.map((x) => x.key.split(":")[3] + "/" + x.key.split("/").pop()), links: r.links.length };
    };
    const out = {
      home: await run({ region: "ap-south-1", home: "ap-south-1" }),
      covered: await run({ region: "ap-south-1", home: "ap-south-1", regions: ["ap-south-1", "us-east-1"] }),
      other: await run({ region: "eu-west-1", home: "ap-south-1" }),
    };
    process.stdout.write(JSON.stringify(out));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 }));
  const lists = (r: { calls: unknown[][] }) => r.calls.filter((c) => c[0] === "ListCertificates").map((c) => [c[1], c[3]]);
  assert.deepEqual(lists(out.home), [["ap-south-1", 7], ["us-east-1", 7]]);
  assert.deepEqual(out.home.keys, ["ap-south-1/alb", "ap-south-1/quiet", "ap-south-1/failed", "us-east-1/cf"]);
  assert.deepEqual(out.home.calls.filter((c: unknown[]) => c[0] === "DescribeCertificate").map((c: unknown[]) => `${c[1]}/${c[2]}`).sort(), ["ap-south-1/alb", "ap-south-1/failed", "us-east-1/cf"], "never the quiet, unused, healthy one; each in its own region");
  assert.equal(out.home.links, 1);
  assert.deepEqual(lists(out.covered), [["ap-south-1", 7]], "us-east-1 has its own run");
  assert.deepEqual(lists(out.other), [["eu-west-1", 7]], "only the home run adds us-east-1");
});
