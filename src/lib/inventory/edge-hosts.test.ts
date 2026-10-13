import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHost, decodeDnsName, dnsTargetRef, inZone, lambdaFunctionArn, mergeLinks, normHost, originRef, plumbingName, rfc3986, s3Endpoints, s3KeyPath,
  s3ObjectUrl, websiteEndpoint,
} from "./edge-hosts.ts";

test("hostnames: case, trailing dot, dualstack prefix, Route 53 octal escapes", () => {
  assert.equal(normHost("Dualstack.Acme-1.us-east-1.ELB.amazonaws.com."), "acme-1.us-east-1.elb.amazonaws.com");
  assert.equal(decodeDnsName("\\052.acme.example."), "*.acme.example");
  assert.equal(decodeDnsName("www.acme.example."), "www.acme.example");
  assert.ok(inZone("shop.acme-shop.com", "acme-shop.com"));
  assert.ok(inZone("ACME-SHOP.com.", "acme-shop.com"));
  assert.ok(!inZone("evilacme-shop.com", "acme-shop.com"));
  assert.ok(plumbingName("_3f1a.acme.example"));
  assert.ok(plumbingName("sel1._domainkey.acme.example"));
  assert.ok(!plumbingName("www.acme.example"));
});

test("origin domains → buckets, load balancers, APIs, CloudFront", () => {
  const c = classifyHost;
  assert.deepEqual([c("acme-assets.s3.us-east-1.amazonaws.com").kind, c("acme-assets.s3.us-east-1.amazonaws.com").bucket, c("acme-assets.s3.us-east-1.amazonaws.com").region], ["s3", "acme-assets", "us-east-1"]);
  assert.equal(c("acme-logs.s3.amazonaws.com").bucket, "acme-logs");
  assert.equal(c("my.dotted.bucket.s3.eu-west-1.amazonaws.com").bucket, "my.dotted.bucket");
  assert.equal(c("old.s3-us-west-2.amazonaws.com").region, "us-west-2");
  assert.equal(c("b.s3.dualstack.ap-south-1.amazonaws.com").bucket, "b");
  assert.deepEqual([c("site.s3-website-us-east-1.amazonaws.com").kind, c("site.s3-website-us-east-1.amazonaws.com").bucket], ["s3-website", "site"]);
  assert.deepEqual([c("site.s3-website.eu-central-1.amazonaws.com").bucket, c("site.s3-website.eu-central-1.amazonaws.com").region], ["site", "eu-central-1"]);
  assert.deepEqual([c("s3-website-us-east-1.amazonaws.com").kind, c("s3-website-us-east-1.amazonaws.com").bucket], ["s3-website", undefined]);
  const alb = c("acme-production-1839406127.us-east-1.elb.amazonaws.com");
  assert.deepEqual([alb.kind, alb.name, alb.region], ["loadbalancer", "acme-production", "us-east-1"]);
  assert.equal(c("internal-acme-int-123456.eu-west-1.elb.amazonaws.com").name, "acme-int");
  assert.equal(c("acme-nlb-0123456789abcdef.elb.us-east-1.amazonaws.com").name, "acme-nlb");
  assert.deepEqual([c("a1b2c3d4e5.execute-api.us-east-1.amazonaws.com").kind, c("a1b2c3d4e5.execute-api.us-east-1.amazonaws.com").id], ["apigateway", "a1b2c3d4e5"]);
  assert.equal(c("d-9x8w7v6u5t.execute-api.us-east-1.amazonaws.com").kind, "apigateway-domain");
  assert.equal(c("d1a2b3c4shop.cloudfront.net").kind, "cloudfront");
  assert.deepEqual([c("acme-legacy-admin-prod.us-east-1.elasticbeanstalk.com").kind, c("acme-legacy-admin-prod.us-east-1.elasticbeanstalk.com").name], ["beanstalk", "acme-legacy-admin-prod"]);
  assert.equal(c("abcd1234.us-east-1.awsapprunner.com").kind, "apprunner");
  assert.equal(c("203.0.113.10").kind, "ip");
  assert.equal(c("2001:db8::1").kind, "ip");
  assert.equal(c("staging-origin.acme.example").kind, "other");
  assert.equal(c("s3.us-east-1.amazonaws.com").kind, "other"); // path-style endpoint, no bucket
});

test("references the inventory resolves: buckets by key, everything else by hostname", () => {
  assert.equal(originRef("acme-production-assets.s3.us-east-1.amazonaws.com"), "arn:aws:s3:::acme-production-assets");
  assert.equal(originRef("site.s3-website-us-east-1.amazonaws.com"), "arn:aws:s3:::site");
  assert.equal(originRef("Acme-Production-1839406127.us-east-1.elb.amazonaws.com."), "acme-production-1839406127.us-east-1.elb.amazonaws.com");
  // S3 website aliases name the regional endpoint only: the bucket is named like the record.
  assert.equal(dnsTargetRef("acme.example", "s3-website-us-east-1.amazonaws.com."), "arn:aws:s3:::acme.example");
  assert.equal(dnsTargetRef("api-public.acme.example", "d-9x8w7v6u5t.execute-api.us-east-1.amazonaws.com."), "d-9x8w7v6u5t.execute-api.us-east-1.amazonaws.com");
  assert.equal(dnsTargetRef("api.acme.example", "dualstack.acme-production-1839406127.us-east-1.elb.amazonaws.com."), "acme-production-1839406127.us-east-1.elb.amazonaws.com");
  assert.equal(dnsTargetRef("bastion.acme.example", "203.0.113.10"), "203.0.113.10");
});

test("bucket endpoints: dash vs dot website regions, REST endpoints", () => {
  assert.equal(websiteEndpoint("b", "us-east-1"), "b.s3-website-us-east-1.amazonaws.com");
  assert.equal(websiteEndpoint("b", "eu-central-1"), "b.s3-website.eu-central-1.amazonaws.com");
  assert.deepEqual(s3Endpoints("b", "ap-south-1", false), ["b.s3.ap-south-1.amazonaws.com", "b.s3.amazonaws.com"]);
  assert.equal(s3Endpoints("b", "ap-south-1", true).length, 3);
});

test("Lambda qualifiers, SigV4 key encoding, object URL style", () => {
  assert.equal(lambdaFunctionArn("arn:aws:lambda:us-east-1:123456789012:function:thumb:3"), "arn:aws:lambda:us-east-1:123456789012:function:thumb");
  assert.equal(lambdaFunctionArn("arn:aws:lambda:us-east-1:123456789012:function:thumb"), "arn:aws:lambda:us-east-1:123456789012:function:thumb");
  assert.equal(rfc3986("a b(1)!*'"), "a%20b%281%29%21%2A%27");
  assert.equal(s3KeyPath("uploads/my file (1).jpg"), "uploads/my%20file%20%281%29.jpg");
  assert.equal(s3KeyPath("ünï/ç"), "%C3%BCn%C3%AF/%C3%A7");
  assert.deepEqual(s3ObjectUrl("acme-logs", "us-east-1", "a/b.txt"), { host: "acme-logs.s3.us-east-1.amazonaws.com", path: "/a/b.txt" });
  assert.deepEqual(s3ObjectUrl("my.site", "eu-west-1", "x"), { host: "s3.eu-west-1.amazonaws.com", path: "/my.site/x" });
});

test("links to the same target merge, labels and evidence clipped", () => {
  const m = mergeLinks([
    { from: "z", to: "cf", kind: "route", label: "www.acme.example", evidence: "A alias" },
    { from: "z", to: "cf", kind: "route", label: "www.acme.example", evidence: "AAAA alias" },
    { from: "z", to: "cf", kind: "route", label: "acme.example", evidence: "A alias" },
    { from: "z", to: "alb", kind: "route", label: "api.acme.example", evidence: "A alias" },
  ]);
  assert.equal(m.length, 2);
  assert.equal(m[0].label, "www.acme.example, acme.example");
  assert.equal(m[0].evidence, "A alias; AAAA alias");
  const many = mergeLinks(["a", "b", "c", "d", "e"].map((l) => ({ from: "z", to: "x", kind: "route" as const, label: l, evidence: l })));
  assert.equal(many[0].label, "a, b, c +2 more");
});
