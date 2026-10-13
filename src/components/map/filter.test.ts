import { test } from "node:test";
import assert from "node:assert/strict";
import { KIND_INFO, type Edge, type Resource, type ResourceKind } from "../../lib/inventory/types.ts";
import { DEFAULT_FILTERS, PASS_THROUGH, SHARED, activeFilterCount, applyFilters, filtersFromParams, filtersToParams, matchesQuery } from "./filter.ts";

const r = (key: string, kind: ResourceKind, env?: string, extra: Partial<Resource> = {}): Resource => ({ key, kind, env, name: key, provider: "t", region: "us-east-1", tags: {}, health: "ok", props: [], ...extra });
const e = (from: string, to: string): Edge => ({ id: `${from}->${to}:uses`, from, to, kind: "uses", evidence: [], confidence: "config" });

const RES = [
  r("api", "ecs-service", "production", { tags: { team: "checkout" } }),
  r("orders", "sqs", "production", { health: "warning", aliases: ["https://sqs.us-east-1.amazonaws.com/1/acme-orders"] }),
  r("fn", "lambda", "production"),
  r("stg-api", "ecs-service", "staging"),
  r("logs", "s3", undefined, { idle: { why: "no writes in 30 days" } }),
  r("dns", "route53-zone", undefined, { endpoints: ["acme.example"] }),
  r("old", "sqs", undefined, { idle: { why: "no messages" } }),
];
const EDGES = [e("api", "orders"), e("orders", "fn"), e("api", "logs"), e("stg-api", "logs"), e("dns", "api")];
const keys = (x: { resources: Resource[] }) => x.resources.map((r) => r.key).sort();

test("no filters: everything", () => {
  const f = applyFilters(RES, EDGES, DEFAULT_FILTERS);
  assert.equal(f.resources.length, RES.length);
  assert.equal(f.edges.length, EDGES.length);
  assert.equal(f.matches, null);
  assert.equal(f.idleCount, 2);
  assert.equal(f.problemCount, 1);
});

test("one environment brings the shared resources wired to it; Shared shows only unclaimed ones", () => {
  assert.deepEqual(keys(applyFilters(RES, EDGES, { ...DEFAULT_FILTERS, env: "production" })), ["api", "dns", "fn", "logs", "orders"]);
  assert.deepEqual(keys(applyFilters(RES, EDGES, { ...DEFAULT_FILTERS, env: "staging" })), ["logs", "stg-api"]);
  assert.deepEqual(keys(applyFilters(RES, EDGES, { ...DEFAULT_FILTERS, env: SHARED })), ["dns", "logs", "old"]);
});

test("kinds, idle only, problems only; counts follow the env filter", () => {
  const k = applyFilters(RES, EDGES, { ...DEFAULT_FILTERS, kinds: new Set<ResourceKind>(["sqs"]) });
  assert.deepEqual(keys(k), ["old", "orders"]);
  assert.equal(k.kindCounts.get("ecs-service"), 2, "counts ignore the kind filter itself");
  assert.deepEqual(keys(applyFilters(RES, EDGES, { ...DEFAULT_FILTERS, idle: true })), ["logs", "old"]);
  assert.deepEqual(keys(applyFilters(RES, EDGES, { ...DEFAULT_FILTERS, problems: true })), ["orders"]);
  assert.equal(applyFilters(RES, EDGES, { ...DEFAULT_FILTERS, env: "staging" }).kindCounts.get("sqs"), undefined);
});

test("search: every word must match name, key, tags, endpoints or aliases; neighbours come along as context", () => {
  assert.ok(matchesQuery(RES[0], "team=checkout"));
  assert.ok(matchesQuery(RES[0], "API checkout"));
  assert.ok(!matchesQuery(RES[0], "api billing"));
  assert.ok(matchesQuery(RES[1], "acme-orders"), "aliases (queue URL)");
  assert.ok(matchesQuery(RES[5], "acme.example"), "endpoints");
  assert.ok(matchesQuery(RES[2], "lambda function"), "kind label");
  const s = applyFilters(RES, EDGES, { ...DEFAULT_FILTERS, q: "orders" });
  assert.deepEqual([...s.matches!], ["orders"]);
  assert.deepEqual([...s.context].sort(), ["api", "fn"]);
  assert.deepEqual(keys(s), ["api", "fn", "orders"]);
  assert.equal(s.edges.length, 2);
  const none = applyFilters(RES, EDGES, { ...DEFAULT_FILTERS, q: "nothing-like-this" });
  assert.equal(none.resources.length, 0);
});

test("active filter count (search is not counted: it has its own field)", () => {
  assert.equal(activeFilterCount(DEFAULT_FILTERS), 0);
  assert.equal(activeFilterCount({ ...DEFAULT_FILTERS, env: "production", idle: true, q: "x" }), 2);
});

// ---- layers, region, confidence, pass-through, URL (D.9, F14, F44, req. 6) ----
const D = DEFAULT_FILTERS;

const ec = (from: string, to: string, kind: Edge["kind"] = "uses", confidence: Edge["confidence"] = "config", label?: string): Edge => ({ id: `${from}->${to}:${kind}`, from, to, kind, evidence: [`${from} → ${to}`], confidence, label });

test("hidden rows are never drawn; support layers only when switched on, with counts per layer", () => {
  const res = [r("api", "ecs-service", "production"), r("sg", "security-group", "production"), r("role", "iam-role", "production"), r("key", "kms-key", undefined, { hidden: true })];
  const def = applyFilters(res, [ec("api", "role", "assumes")], D);
  assert.deepEqual(keys(def), ["api"]);
  assert.equal(def.edges.length, 0);
  assert.equal(def.layerCounts.get("network"), 1);
  assert.equal(def.layerCounts.get("security"), 1, "hidden rows don't count");
  const on = applyFilters(res, [ec("api", "role", "assumes")], { ...D, layers: new Set(["network", "security"]) });
  assert.deepEqual(keys(on), ["api", "role", "sg"]);
  assert.equal(on.edges.length, 1);
  assert.equal(activeFilterCount({ ...D, layers: new Set(["network"]) }), 1);
  const s = applyFilters(res, [], { ...D, q: "sg" });
  assert.equal(s.offLayerMatches, 1, "a search hit on a layer that is off is counted, so the page can say so");
});

test("region: one region plus the global resources wired to it", () => {
  const res = [
    r("api", "ecs-service", "production", { region: "us-east-1" }),
    r("eu-api", "ecs-service", "production", { region: "eu-west-1" }),
    r("cdn", "cloudfront", "production", { region: "global" }),
    r("dns", "route53-zone", undefined, { region: "global" }),
  ];
  const f = applyFilters(res, [ec("cdn", "eu-api", "route"), ec("dns", "api", "route")], { ...D, region: "eu-west-1" });
  assert.deepEqual(keys(f), ["cdn", "eu-api"]);
  // R14: a reference to another region (outside the console's regions by definition) comes along with what names it.
  const ref = r("arn:aws:sqs:eu-central-1:2:partner-q", "aws-resource", undefined, { region: "eu-central-1", source: "reference", category: "messaging", service: "SQS" });
  const g = applyFilters([...res, ref], [ec("cdn", "eu-api", "route"), ec("eu-api", ref.key, "writes", "mentioned")], { ...D, region: "eu-west-1" });
  assert.deepEqual(keys(g), [ref.key, "cdn", "eu-api"]);
  assert.deepEqual(keys(applyFilters([...res, ref], [ec("api", ref.key, "writes", "mentioned")], { ...D, region: "eu-west-1" })), ["eu-api"], "only when something in the region names it");
});

test("connections: confidence filter (counts before it), and the strongest kinds stay", () => {
  const edges = [ec("api", "orders", "writes", "mentioned"), ec("orders", "fn", "poll", "config"), ec("api", "logs", "writes", "allowed")];
  const all = applyFilters(RES, edges, D);
  assert.deepEqual(all.confidenceCounts, { config: 1, allowed: 1, mentioned: 1 });
  const cfg = applyFilters(RES, edges, { ...D, edgeConfidence: new Set(["config"]) });
  assert.deepEqual(cfg.edges.map((x) => x.id), ["orders->fn:poll"]);
  assert.deepEqual(cfg.confidenceCounts, all.confidenceCounts, "counts ignore the confidence filter itself");
  assert.equal(cfg.resources.length, all.resources.length, "the filter hides lines, not resources");
  assert.equal(activeFilterCount({ ...D, edgeConfidence: new Set(["config"]) }), 1);
});

test("pass-through: a proxy, endpoint, NAT or Cloud Map service between two drawn resources becomes a 'via' label", () => {
  assert.deepEqual([...PASS_THROUGH].sort(), ["cloudmap-service", "nat-gateway", "rds-proxy", "vpc-endpoint"]);
  const res = [
    r("api", "ecs-service", "production"),
    r("worker", "ecs-service", "production"),
    r("proxy", "rds-proxy", "production", { name: "acme-pg-proxy" } as Partial<Resource>),
    r("db", "rds", "production"),
    r("disc", "cloudmap-service", "production", { name: "api.acme.internal" } as Partial<Resource>),
  ];
  const edges = [ec("api", "proxy", "sql", "allowed"), ec("proxy", "db", "sql", "config"), ec("worker", "disc", "uses", "mentioned"), ec("disc", "api", "route", "config")];
  const f = applyFilters(res, edges, D);
  assert.deepEqual(keys(f), ["api", "db", "worker"]);
  assert.deepEqual([...f.passThrough].sort(), ["disc", "proxy"]);
  const via = f.edges.find((x) => x.from === "api" && x.to === "db")!;
  assert.equal(via.label, "via acme-pg-proxy");
  assert.equal(via.kind, "sql");
  assert.equal(via.confidence, "allowed", "a joined connection is as sure as its weaker half");
  assert.deepEqual(via.evidence, ["api → proxy", "proxy → db"]);
  assert.ok(f.edges.some((x) => x.from === "worker" && x.to === "api" && x.label === "via api.acme.internal"), "the network layer is off: the Cloud Map service is a label");
  // Drawn as a node again: its layer is on, it has a problem, or it matches the search.
  assert.ok(keys(applyFilters(res, edges, { ...D, layers: new Set(["network", "other"]) })).includes("disc"));
  assert.ok(keys(applyFilters(res.map((x) => (x.key === "proxy" ? { ...x, health: "error" as const } : x)), edges, D)).includes("proxy"));
  assert.ok(keys(applyFilters(res, edges, { ...D, q: "pg-proxy" })).includes("proxy"));
  // Nothing on one side: nothing to join, and it stays (or stays hidden) as it is.
  assert.ok(keys(applyFilters(res.filter((x) => x.key !== "db"), edges, D)).includes("proxy"));
});

test("filters in the URL: round trip, defaults left out, unknown values ignored", () => {
  const isKind = (k: string): k is ResourceKind => Object.hasOwn(KIND_INFO, k);
  assert.equal(filtersToParams(D).toString(), "");
  const f = { ...D, q: "orders dlq", env: "production", kinds: new Set<ResourceKind>(["sqs", "lambda"]), problems: true, idle: true, region: "eu-west-1", layers: new Set(["network", "security"] as const), edgeConfidence: new Set(["config", "allowed"] as const) };
  const p = filtersToParams(f);
  assert.equal(p.get("kinds"), "lambda,sqs");
  assert.equal(p.get("layers"), "network,security");
  assert.equal(p.get("conn"), "config,allowed");
  const back = filtersFromParams(new URLSearchParams(p.toString()), isKind);
  assert.deepEqual({ ...back, kinds: [...back.kinds!].sort(), layers: [...back.layers].sort(), edgeConfidence: [...back.edgeConfidence!].sort() }, { ...f, kinds: ["lambda", "sqs"], layers: ["network", "security"], edgeConfidence: ["allowed", "config"] });
  const none = filtersFromParams(new URLSearchParams("layers=none&kinds=bogus,sqs&conn=config,allowed,mentioned&x=1"), isKind);
  assert.equal(none.layers.size, 0);
  assert.deepEqual([...none.kinds!], ["sqs"]);
  assert.equal(none.edgeConfidence, null, "every confidence = no filter");
  assert.equal(filtersToParams({ ...D, layers: new Set() }).get("layers"), "none");
  const keep = new URLSearchParams("r=abc&view=map");
  filtersToParams({ ...D, q: "x" }, keep);
  assert.equal(keep.toString(), "r=abc&view=map&q=x", "other parameters are kept");
});
