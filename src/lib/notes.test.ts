import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTE_LIMITS, cleanBody, ecsNoteTarget, isEdited, isNoteId, keyProblem, likePattern, linkify, parseNoteInput, parseNotePatch, parseSearch, parseTags,
  resourceHref, safeHref, sortNotes, suggestTags, tagPattern,
} from "./notes.ts";

const links = (s: string) => linkify(s).filter((x) => x.href).map((x) => x.href);
const texts = (s: string) => linkify(s).map((x) => x.text).join("");

test("keys: ARNs and the console's prefixes pass, anything else is refused", () => {
  for (const k of [
    "arn:aws:lambda:us-east-1:123456789012:function:orders",
    "arn:aws:s3:::acme-assets",
    "arn:aws:cloudfront::123456789012:distribution/E2QWRUHAPOMQZL",
    "arn:aws-cn:sqs:cn-north-1:123456789012:orders",
    "arn:aws-us-gov:sns:us-gov-west-1:123456789012:alerts",
    "ecs:service/acme-staging/api",
    "elb:acme-production",
    "rds:acme-production-pg",
    "elasticache:acme-redis",
    "ec2:i-0abc123",
    "eks:prod/default/deployment/web",
    "external:stripe",
    "external:api.stripe.com",
    "cloudflare:zone/abc",
  ])
    assert.equal(keyProblem(k), undefined, k);
  for (const k of ["", "service:api", "ecs:", "arn:", "arn:gcp:x:y:z:w", "javascript:alert(1)", " ecs:service/a/b", "ecs:service/a/b\n", "rds:x\u0000", "x".repeat(600), 42, null])
    assert.ok(keyProblem(k), String(k));
  assert.ok(keyProblem(`rds:${"a".repeat(NOTE_LIMITS.key)}`));
});

test("tags: lower-cased, trimmed, # dropped, deduped; bad shapes and too many refused", () => {
  assert.deepEqual(parseTags([" Traffic ", "#incident", "traffic", "db-2"]), { ok: true, value: ["traffic", "incident", "db-2"] });
  assert.deepEqual(parseTags(undefined), { ok: true, value: [] });
  for (const bad of [["-x"], ["a b"], ["ünïcode"], ["x".repeat(33)], [""], ["under_score"], [1], "traffic", Array.from({ length: 11 }, (_, i) => `t${i}`)])
    assert.equal(parseTags(bad).ok, false, JSON.stringify(bad));
  assert.equal(parseTags(Array.from({ length: 10 }, (_, i) => `t${i}`)).ok, true);
  assert.equal(parseTags(["x".repeat(32)]).ok, true);
});

test("body: trimmed, line endings normalised, control characters dropped, 1–10,000 characters", () => {
  assert.equal(cleanBody("  a\r\nb\rc\u0000d\te  "), "a\nb\ncd\te");
  const good = parseNoteInput({ key: "rds:db", body: "  migrated to gp3 \n\n" });
  assert.deepEqual(good, { ok: true, value: { key: "rds:db", body: "migrated to gp3", tags: [], pinned: false } });
  assert.equal(parseNoteInput({ key: "rds:db", body: "   \n\t " }).ok, false);
  assert.equal(parseNoteInput({ key: "rds:db", body: "x".repeat(10_000) }).ok, true);
  const long = parseNoteInput({ key: "rds:db", body: "x".repeat(10_001) });
  assert.equal(long.ok, false);
  assert.match(!long.ok ? long.error : "", /10,000/);
  // Surrounding whitespace doesn't count towards the limit.
  assert.equal(parseNoteInput({ key: "rds:db", body: `  ${"x".repeat(10_000)}\n\n` }).ok, true);
  // Unicode is kept as written.
  const uni = parseNoteInput({ key: "rds:db", body: "Überprüft ✅ — 日本語のメモ 🚀\nzweite Zeile" });
  assert.equal(uni.ok && uni.value.body, "Überprüft ✅ — 日本語のメモ 🚀\nzweite Zeile");
});

test("create input: own fields only, types checked, optional fields cleaned", () => {
  const v = parseNoteInput({ key: "ecs:service/c/api", body: "hi", tags: ["Traffic"], pinned: true, resourceName: " api\n ", env: "staging" });
  assert.deepEqual(v, { ok: true, value: { key: "ecs:service/c/api", body: "hi", tags: ["traffic"], pinned: true, resourceName: "api", env: "staging" } });
  assert.equal(parseNoteInput({ key: "rds:db", body: "hi", author: "someone@else" }).ok, false);
  assert.equal(parseNoteInput(JSON.parse('{"key":"rds:db","body":"hi","__proto__":{"pinned":true}}')).ok, false);
  assert.equal(parseNoteInput({ key: "rds:db", body: "hi", pinned: "yes" }).ok, false);
  assert.equal(parseNoteInput({ key: "rds:db", body: "hi", env: "../x" }).ok, false);
  assert.equal(parseNoteInput({ key: "rds:db", body: "hi", resourceName: "x".repeat(201) }).ok, false);
  assert.equal(parseNoteInput({ key: "rds:db", body: 5 }).ok, false);
  assert.equal(parseNoteInput([]).ok, false);
  assert.equal(parseNoteInput(null).ok, false);
  assert.deepEqual(parseNoteInput({ key: "rds:db", body: "hi", env: null, resourceName: null }), { ok: true, value: { key: "rds:db", body: "hi", tags: [], pinned: false } });
});

test("patch input: at least one of body, tags, pinned", () => {
  assert.deepEqual(parseNotePatch({ pinned: false }), { ok: true, value: { pinned: false } });
  assert.deepEqual(parseNotePatch({ body: " b ", tags: ["X"] }), { ok: true, value: { body: "b", tags: ["x"] } });
  assert.equal(parseNotePatch({}).ok, false);
  assert.equal(parseNotePatch({ key: "rds:other" }).ok, false);
  assert.equal(parseNotePatch({ body: "" }).ok, false);
  assert.equal(parseNotePatch({ tags: ["bad tag"] }).ok, false);
});

test("search: trimmed text, normalised tag, clamped limit; LIKE wildcards escaped", () => {
  assert.deepEqual(parseSearch({ q: "  cache  ", tag: "#Traffic", env: "production", limit: "500" }), { ok: true, value: { q: "cache", tag: "traffic", env: "production", limit: 200 } });
  assert.deepEqual(parseSearch({}), { ok: true, value: { limit: 50 } });
  assert.deepEqual(parseSearch({ q: "", limit: "-3" }), { ok: true, value: { limit: 1 } });
  assert.deepEqual(parseSearch({ limit: "abc" }), { ok: true, value: { limit: 50 } });
  assert.equal(parseSearch({ q: "x".repeat(201) }).ok, false);
  assert.equal(parseSearch({ tag: "bad tag" }).ok, false);
  assert.equal(parseSearch({ env: "a b" }).ok, false);
  assert.equal(likePattern("50%_off\\"), "%50\\%\\_off\\\\%");
  assert.equal(tagPattern("traffic"), '%"traffic"%');
});

test("linkify: http(s) URLs become links, trailing punctuation and stray brackets stay text", () => {
  assert.deepEqual(linkify("see https://grafana.example.com/d/abc?x=1&y=2 for the dashboard."), [
    { text: "see " },
    { text: "https://grafana.example.com/d/abc?x=1&y=2", href: "https://grafana.example.com/d/abc?x=1&y=2" },
    { text: " for the dashboard." },
  ]);
  assert.deepEqual(links("(https://a.example/x), [http://b.example] and https://c.example/wiki/Foo_(bar)."), ["https://a.example/x", "http://b.example/", "https://c.example/wiki/Foo_(bar)"]);
  assert.deepEqual(links("[runbook](https://docs.example/runbook)"), ["https://docs.example/runbook"]);
  assert.deepEqual(links("HTTPS://EXAMPLE.COM/Path"), ["https://example.com/Path"]);
  assert.deepEqual(links("two:\nhttps://a.example\nhttps://b.example"), ["https://a.example/", "https://b.example/"]);
  assert.deepEqual(links("https://例え.jp/パス"), ["https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9"]);
  // The text itself is never changed, only split.
  const s = "a <b>bold</b> https://x.example/?q=<script> & more";
  assert.equal(texts(s), s);
});

test("linkify: nothing but http(s) is ever linked", () => {
  for (const s of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://files.example.com",
    "mailto:a@example.com",
    "<a href=\"javascript:alert(1)\">x</a>",
    "[click](javascript:alert(1))",
    "www.example.com",
    "xhttps://example.com",
    "https://",
    "https://.",
    "https://user:pass@example.com/",
    "https://evil.example@good.example/",
  ])
    assert.deepEqual(links(s), [], s);
  // An http(s) URL inside a javascript: string links only to itself.
  assert.deepEqual(links("javascript:fetch('https://x.example/a')"), ["https://x.example/a"]);
  assert.equal(safeHref("javascript:alert(1)"), undefined);
  assert.equal(safeHref("https://ok.example"), "https://ok.example/");
});

test("linkify: very long bodies and URLs stay fast and bounded", () => {
  const long = `https://x.example/${"a".repeat(3000)}`;
  assert.deepEqual(links(long), []);
  assert.equal(texts(long), long);
  const body = `${"word ".repeat(1500)}https://ok.example/p ${"x".repeat(2000)}`.slice(0, 10_000);
  const t = performance.now();
  assert.deepEqual(links(body), ["https://ok.example/p"]);
  assert.ok(performance.now() - t < 50);
  // Pathological input: no backtracking blow-up.
  const nasty = "https://a" + "(".repeat(5000) + ")".repeat(5000) + ".";
  const t2 = performance.now();
  linkify(nasty);
  assert.ok(performance.now() - t2 < 200);
  // Bidi controls end a URL (no reordered link text).
  assert.deepEqual(links("https://good.example\u202Egpj.exe"), ["https://good.example/"]);
});

test("ordering, edited marker, tag suggestions", () => {
  const n = (id: string, createdAt: number, pinned = false) => ({ id, createdAt, pinned });
  assert.deepEqual(sortNotes([n("a", 1), n("b", 3), n("c", 2, true), n("d", 0, true)]).map((x) => x.id), ["c", "d", "b", "a"]);
  assert.equal(isEdited({ createdAt: 1, updatedAt: 1 }), false);
  assert.equal(isEdited({ createdAt: 1, updatedAt: 2 }), true);
  const all = [{ tag: "traffic", count: 5 }, { tag: "incident", count: 9 }, { tag: "cost", count: 2 }, { tag: "trace", count: 1 }, { tag: "retraffic", count: 7 }];
  assert.deepEqual(suggestTags(all, "tra", []), ["traffic", "trace", "retraffic"]);
  assert.deepEqual(suggestTags(all, "", ["incident"], 2), ["retraffic", "traffic"]);
  assert.deepEqual(suggestTags(all, "#TRA", ["traffic"]), ["trace", "retraffic"]);
});

test("where a note opens: ECS panel keys and links", () => {
  assert.deepEqual(ecsNoteTarget({ kind: "service", id: "api", name: "Storefront API", subtitle: "" }, "acme-staging"), { key: "ecs:service/acme-staging/api", name: "Storefront API" });
  assert.equal(ecsNoteTarget({ kind: "service", id: "api", name: "api", subtitle: "" }), undefined);
  assert.deepEqual(ecsNoteTarget({ kind: "loadbalancer", id: "alb", name: "Load balancer", subtitle: "acme-production" }), { key: "elb:acme-production", name: "acme-production" });
  assert.deepEqual(ecsNoteTarget({ kind: "database", id: "acme-pg", name: "PostgreSQL", subtitle: "acme-pg" }), { key: "rds:acme-pg", name: "acme-pg" });
  assert.deepEqual(ecsNoteTarget({ kind: "cache", id: "acme-redis", name: "Redis", subtitle: "acme-redis" }), { key: "elasticache:acme-redis", name: "acme-redis" });
  assert.deepEqual(ecsNoteTarget({ kind: "box", id: "i-1", name: "box-a", subtitle: "i-1 · t3.large" }), { key: "ec2:i-1", name: "box-a" });
  assert.equal(ecsNoteTarget({ kind: "box", id: "?", name: "EC2 hosts", subtitle: "" }), undefined);
  // Outside home the keys carry the region; in home they don't.
  assert.equal(ecsNoteTarget({ kind: "service", id: "api", name: "api", subtitle: "" }, "acme-production", "eu-west-1", "us-east-1")?.key, "ecs:service/acme-production/api@eu-west-1");
  assert.equal(ecsNoteTarget({ kind: "database", id: "acme-pg", name: "", subtitle: "" }, undefined, "eu-west-1", "us-east-1")?.key, "rds:acme-pg@eu-west-1");
  assert.equal(ecsNoteTarget({ kind: "box", id: "i-1", name: "", subtitle: "" }, undefined, "us-east-1", "us-east-1")?.key, "ec2:i-1");
  assert.equal(ecsNoteTarget({ kind: "external", id: "stripe", name: "Stripe", subtitle: "" }), undefined);

  assert.equal(resourceHref({ key: "ecs:service/acme-staging/api", env: "staging" }), "/?env=staging&r=service%3Aapi");
  assert.equal(resourceHref({ key: "rds:acme-pg", env: "production" }), "/?env=production&r=database%3Aacme-pg");
  assert.equal(resourceHref({ key: "elb:acme-production", env: "production" }), "/?env=production&r=loadbalancer%3Aalb");
  assert.equal(resourceHref({ key: "ecs:service/acme-staging/api" }), "/map?r=ecs%3Aservice%2Facme-staging%2Fapi");
  assert.equal(resourceHref({ key: "arn:aws:lambda:us-east-1:1:function:x", env: "production" }), "/map?r=arn%3Aaws%3Alambda%3Aus-east-1%3A1%3Afunction%3Ax");
  assert.equal(isNoteId("7c9e6679-7425-40de-944b-e07fc1f90ae7"), true);
  assert.equal(isNoteId("../etc"), false);
});
