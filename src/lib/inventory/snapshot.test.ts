import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { decodeSnapshot, encodeSnapshot, MAX_DECODED } from "./snapshot.ts";
import type { ProviderResult, Resource } from "./types.ts";

// A stand-in for secrets.ts seal/unseal: reversible, and visibly not the plain text.
const seal = (s: string) => `v1:${Buffer.from(s).toString("hex")}`;
const unseal = (s: string) => {
  if (!s.startsWith("v1:")) throw new Error("unknown secret format");
  return Buffer.from(s.slice(3), "hex").toString("utf8");
};
const SECRET = "postgres://app:s3cr3t-SENTINEL@acme-production-pg.c9x.us-east-1.rds.amazonaws.com:5432/app";

const res = (key: string, extra: Partial<Resource> = {}): Resource => ({
  key, kind: "lambda", provider: "lambda", name: key.split(":").pop()!, region: "us-east-1", tags: { team: "web" }, health: "ok", props: [{ label: "Runtime", value: "nodejs22.x" }], ...extra,
});
const RESULT: ProviderResult = {
  resources: [res("arn:aws:lambda:us-east-1:123456789012:function:acme-orders"), res("arn:aws:lambda:us-east-1:123456789012:function:acme-mailer", { props: [{ label: "Origin", value: "https://user:hunter2@origin.acme.example/x" }] })],
  links: [{ from: "arn:aws:lambda:us-east-1:123456789012:function:acme-orders", to: "arn:aws:sqs:us-east-1:123456789012:acme-orders", kind: "poll", evidence: "event source mapping" }],
  mentions: [{ from: "arn:aws:lambda:us-east-1:123456789012:function:acme-orders", refs: [SECRET], via: "env DATABASE_URL" }],
};

test("round trip: resources and links in clear, mentions sealed — the secret never appears in the stored row", () => {
  const e = encodeSnapshot(RESULT, { seal });
  assert.ok("data" in e);
  assert.equal(e.mentions, "sealed");
  assert.ok(!e.data.includes("SENTINEL"));
  const d = decodeSnapshot(e.data, { unseal });
  assert.deepEqual(d.links, RESULT.links);
  assert.deepEqual(d.mentions, RESULT.mentions);
  assert.equal(d.resources.length, 2);
  assert.deepEqual(d.resources[0], RESULT.resources[0]);
  assert.equal(d.resources[1].props[0].value, "https://****@origin.acme.example/x", "props are scrubbed again before they are stored");
});

test("the decompressed row holds no mention value (sealed text only)", () => {
  const e = encodeSnapshot(RESULT, { seal });
  assert.ok("data" in e);
  const json = gunzipSync(Buffer.from(e.data, "base64")).toString("utf8");
  assert.ok(!json.includes("SENTINEL") && !json.includes("hunter2") && !json.includes("DATABASE_URL"));
  assert.ok(json.includes('"mentions":"v1:'));
});

test("sealing fails (no key): mentions are dropped, the map still persists", () => {
  const e = encodeSnapshot(RESULT, { seal: () => { throw new Error("CONSOLE_SECRET_KEY is required"); } });
  assert.ok("data" in e);
  assert.equal(e.mentions, "dropped");
  assert.match(e.why ?? "", /mentions not stored: CONSOLE_SECRET_KEY/);
  const d = decodeSnapshot(e.data, { unseal });
  assert.deepEqual(d.mentions, []);
  assert.equal(d.resources.length, 2);
});

test("size caps: too large with mentions → stored without them; too large anyway → refused", () => {
  const big: ProviderResult = { ...RESULT, mentions: Array.from({ length: 2000 }, (_, i) => ({ from: RESULT.resources[0].key, refs: [`${Math.random()}-${i}-${"x".repeat(200)}`], via: `env V${i}` })) };
  const small = encodeSnapshot(RESULT, { seal });
  assert.ok("data" in small);
  const capped = encodeSnapshot(big, { seal, maxEncoded: small.bytes + 400 });
  assert.ok("data" in capped);
  assert.equal(capped.mentions, "dropped");
  assert.equal(capped.why, "mentions not stored: snapshot too large");
  const refused = encodeSnapshot(RESULT, { seal, maxEncoded: 50 });
  assert.ok("refused" in refused);
  assert.match(refused.refused, /over the 0 KB limit|over the \d+ KB limit/);
});

test("empty results round-trip (an ok run that found nothing is a fact worth keeping)", () => {
  const e = encodeSnapshot({ resources: [], links: [], mentions: [] }, { seal });
  assert.ok("data" in e);
  assert.equal(e.mentions, "none");
  assert.deepEqual(decodeSnapshot(e.data, { unseal }), { resources: [], links: [], mentions: [] });
});

test("decode is defensive: malformed entries dropped, unsealable mentions lost, garbage refused", () => {
  const pack = (o: unknown) => gzipSync(Buffer.from(JSON.stringify(o))).toString("base64");
  const d = decodeSnapshot(pack({ v: 1, resources: [RESULT.resources[0], { key: "x" }, null, "str"], links: [RESULT.links[0], { from: "a" }], mentions: "v2:other-key" }), { unseal });
  assert.equal(d.resources.length, 1);
  assert.equal(d.links.length, 1);
  assert.deepEqual(d.mentions, []);
  assert.equal(d.mentionsLost, true);
  assert.throws(() => decodeSnapshot(pack({ v: 99, resources: [] }), { unseal }), /unknown inventory snapshot format/);
  assert.throws(() => decodeSnapshot(pack([1, 2]), { unseal }), /unknown inventory snapshot format/);
  assert.throws(() => decodeSnapshot("not-base64-gzip", { unseal }));
  // A row that would decompress past the limit is refused rather than allocated.
  const bomb = gzipSync(Buffer.alloc(MAX_DECODED + 1024, 0x20)).toString("base64");
  assert.throws(() => decodeSnapshot(bomb, { unseal }), /RangeError|Cannot create a string|larger than|maxOutputLength|buffer/i);
});

test("security-group rules round-trip (a restored map keeps its \"allowed\" edges); malformed rules are dropped", () => {
  const sgRules = [{ groupId: "sg-0acme0db", region: "us-east-1", vpcId: "vpc-0acme", inbound: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, groups: ["sg-0acme0api"], cidrs: [], prefixLists: [] }] }];
  const e = encodeSnapshot({ ...RESULT, sgRules }, { seal });
  assert.ok("data" in e);
  assert.deepEqual(decodeSnapshot(e.data, { unseal }).sgRules, sgRules);
  const plain = encodeSnapshot(RESULT, { seal });
  assert.ok("data" in plain);
  assert.equal(decodeSnapshot(plain.data, { unseal }).sgRules, undefined, "none stored, none returned");
  const bad = gzipSync(Buffer.from(JSON.stringify({ v: 1, resources: [], links: [], sgRules: [{ groupId: "" }, { groupId: "sg-1", region: "us-east-1", inbound: "x" }, sgRules[0]] }))).toString("base64");
  assert.deepEqual(decodeSnapshot(bad, { unseal }).sgRules, sgRules);
});
