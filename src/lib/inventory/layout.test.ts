import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_LANE, DEFAULT_LAYERS, GLOBAL_LANE, NODE_H, NODE_W, SHARED_LANE, adjacencyOf, groupId, intersects, laneOf, laneOrder, layoutGraph, neighbourInDirection, parentId, vpcIdOfKey, type Layout, type LayoutEdgeInput, type LayoutResource } from "./layout.ts";
import { FLOW_ORDER, KIND_INFO, SUPPORT_ORDER, categoryOf, type Category, type EdgeKind, type ResourceKind } from "./types.ts";

const r = (key: string, kind: ResourceKind, env?: string, name = key, extra: Partial<LayoutResource> = {}): LayoutResource => ({ key, kind, env, name, ...extra });
const e = (from: string, to: string, kind: EdgeKind = "uses", confidence: LayoutEdgeInput["confidence"] = "config"): LayoutEdgeInput => ({ id: `${from}->${to}:${kind}`, from, to, kind, confidence });

// A small shop: DNS → CDN → LB → service → queue → function → table.
const SHOP = [
  r("dns", "route53-zone"),
  r("cdn", "cloudfront", "production"),
  r("lb", "loadbalancer", "production"),
  r("api", "ecs-service", "production"),
  r("stg-api", "ecs-service", "staging"),
  r("q", "sqs", "production"),
  r("fn", "lambda", "production"),
  r("db", "rds", "production"),
  r("stg-db", "rds", "staging"),
  r("bucket", "s3"),
  r("stripe", "external"),
];
const SHOP_EDGES = [e("dns", "cdn", "route"), e("cdn", "lb", "route"), e("cdn", "bucket", "route"), e("lb", "api", "route"), e("api", "q", "writes"), e("q", "fn", "poll"), e("fn", "db", "sql"), e("api", "db", "sql"), e("stg-api", "stg-db", "sql"), e("api", "stripe", "http")];

// Seeded PRNG so the big graphs are the same every run.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// The flow kinds the budget was written for: support layers (network, security…) are off by default on the map.
const KINDS: ResourceKind[] = [
  "cloudflare-zone", "route53-zone", "cloudfront", "apigateway", "loadbalancer", "ecs-service", "ec2-instance", "asg", "lambda", "eks-cluster",
  "eks-workload", "apprunner", "beanstalk", "workload", "sqs", "sns", "eventbridge-rule", "eventbridge-bus", "kinesis", "stepfunctions", "rds",
  "elasticache", "dynamodb", "s3", "external",
];
function bigGraph(n: number, m: number, seed = 7) {
  const rand = rng(seed);
  const envs = ["production", "staging", "dev", undefined];
  const res: LayoutResource[] = Array.from({ length: n }, (_, i) => r(`res-${i}`, KINDS[Math.floor(rand() * KINDS.length)], envs[Math.floor(rand() * envs.length)], `name-${i}`));
  const edges: LayoutEdgeInput[] = [];
  const seen = new Set<string>();
  const kinds: EdgeKind[] = ["route", "invoke", "event", "poll", "sql", "reads", "writes", "uses", "http"];
  while (edges.length < m) {
    const a = Math.floor(rand() * n), b = Math.floor(rand() * n);
    if (a === b) continue;
    const x = e(`res-${a}`, `res-${b}`, kinds[Math.floor(rand() * kinds.length)]);
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    edges.push(x);
  }
  return { res, edges };
}

test("columns follow FLOW_ORDER left → right, and empty categories take no space", () => {
  const l = layoutGraph(SHOP, SHOP_EDGES);
  assert.deepEqual(l.columns.map((c) => c.category), FLOW_ORDER);
  for (let i = 1; i < l.columns.length; i++) assert.ok(l.columns[i].x > l.columns[i - 1].x + l.columns[i - 1].w, "columns do not overlap");
  const x = (key: string) => l.nodeById.get(key)!.x;
  assert.ok(x("dns") < x("api") && x("api") < x("q") && x("q") < x("db") && x("db") < x("bucket") && x("bucket") < x("stripe"));
  assert.equal(x("fn"), x("api"), "a Lambda function sits in the compute column with the ECS service");

  const noMessaging = layoutGraph(SHOP.filter((n) => KIND_INFO[n.kind].category !== "messaging"), []);
  assert.ok(!noMessaging.columns.some((c) => c.category === "messaging"));
  assert.equal(noMessaging.columns.length, FLOW_ORDER.length - 1);
});

test("swimlanes: production first, then the other envs by id, Shared last; flat without lanes", () => {
  assert.deepEqual(laneOrder(["staging", SHARED_LANE, "dev", "production"]), ["production", "dev", "staging", SHARED_LANE]);
  assert.deepEqual(laneOrder(["b", "live"], { live: "Production" }), ["live", "b"], "a production label counts too");
  const l = layoutGraph(SHOP, SHOP_EDGES, { envLabels: { production: "Production" } });
  assert.deepEqual(l.lanes.map((x) => x.id), ["production", "staging", SHARED_LANE]);
  assert.deepEqual(l.lanes.map((x) => x.label), ["Production", "staging", "Shared"]);
  for (let i = 1; i < l.lanes.length; i++) assert.ok(l.lanes[i].y >= l.lanes[i - 1].y + l.lanes[i - 1].h, "lanes stack without overlap");
  for (const n of l.nodes) {
    const lane = l.lanes.find((x) => x.id === n.lane)!;
    assert.ok(n.y >= lane.y && n.y + n.h <= lane.y + lane.h, `${n.id} sits inside its lane`);
  }
  assert.equal(l.nodeById.get("dns")!.lane, SHARED_LANE);
  assert.equal(l.lanes.find((x) => x.id === "production")!.count, 6);

  const flat = layoutGraph(SHOP, SHOP_EDGES, { groupByEnv: false });
  assert.deepEqual(flat.lanes.map((x) => x.id), [ALL_LANE]);
  assert.equal(flat.lanes[0].count, SHOP.length);
});

test("deterministic: same set in any order → identical positions and paths", () => {
  const a = layoutGraph(SHOP, SHOP_EDGES);
  const shuffled = [...SHOP].reverse();
  const b = layoutGraph(shuffled, [...SHOP_EDGES].reverse());
  const snap = (l: ReturnType<typeof layoutGraph>) => JSON.stringify({ n: l.nodes.map((n) => [n.id, n.x, n.y, n.order]), e: l.edges.map((x) => [x.id, x.path]), b: l.bounds });
  assert.equal(snap(a), snap(b));
  const { res, edges } = bigGraph(400, 1200);
  assert.equal(snap(layoutGraph(res, edges)), snap(layoutGraph([...res].reverse(), [...edges].reverse())));
});

test("no two nodes overlap, every node is inside the bounds, reading order covers all nodes once", () => {
  const { res, edges } = bigGraph(600, 1500, 3);
  for (const opts of [{}, { groupByEnv: false }, { groupThreshold: 1000 }]) {
    const l = layoutGraph(res, edges, opts);
    const seen = new Set<string>();
    for (const n of l.nodes) {
      const k = `${n.x},${n.y}`;
      assert.ok(!seen.has(k), `two nodes at ${k}`);
      seen.add(k);
      assert.ok(n.x >= l.bounds.x0 && n.y >= l.bounds.y0 && n.x + n.w <= l.bounds.x1 && n.y + n.h <= l.bounds.y1);
    }
    // Same-cell nodes are on a grid of at least node size, so equal-position checks imply no overlap within a
    // column; columns are disjoint (checked above), lanes are disjoint (checked above).
    for (const a of l.nodes.slice(0, 200))
      for (const b of l.nodes.slice(0, 200))
        if (a !== b) assert.ok(a.x + NODE_W <= b.x || b.x + NODE_W <= a.x || a.y + NODE_H <= b.y || b.y + NODE_H <= a.y, `${a.id} overlaps ${b.id}`);
    assert.deepEqual(l.nodes.map((n) => n.order), l.nodes.map((_, i) => i));
  }
});

test("large same-kind sets in one lane collapse into a group node; expanding shows the members", () => {
  const fns = Array.from({ length: 42 }, (_, i) => r(`fn-${String(i).padStart(2, "0")}`, "lambda", "production", `orders-${i}`));
  const queues = Array.from({ length: 5 }, (_, i) => r(`q-${i}`, "sqs", "production"));
  const stagingFns = Array.from({ length: 12 }, (_, i) => r(`sfn-${i}`, "lambda", "staging"));
  const edges = [e("q-0", "fn-00", "poll"), e("q-0", "fn-01", "poll"), e("q-1", "fn-02", "poll"), e("fn-03", "fn-04", "invoke"), e("fn-05", "q-2", "writes")];
  const l = layoutGraph([...fns, ...queues, ...stagingFns], edges);
  const gid = groupId("production", "lambda");
  const g = l.nodeById.get(gid)!;
  assert.equal(g.type, "group");
  assert.equal(g.members!.length, 42);
  assert.ok(!l.nodeById.has("fn-00"), "members are not drawn on their own");
  assert.equal(l.nodeOf.get("fn-07"), gid);
  assert.ok(l.nodeById.has("sfn-0"), "12 is not more than the threshold: staging's functions stay individual");
  assert.deepEqual(l.groups, [{ id: gid, lane: "production", kind: "lambda", count: 42, expanded: false }]);
  // Edges to members attach to the group, duplicates merge, member ↔ member edges disappear.
  const q0 = l.edges.find((x) => x.from === "q-0")!;
  assert.equal(q0.to, gid);
  assert.equal(q0.edgeIds.length, 2);
  assert.ok(!l.edges.some((x) => x.from === gid && x.to === gid));
  assert.ok(l.edges.some((x) => x.from === gid && x.to === "q-2"));

  const open = layoutGraph([...fns, ...queues, ...stagingFns], edges, { expanded: [gid] });
  assert.ok(!open.nodeById.has(gid));
  assert.ok(open.nodeById.has("fn-00"));
  assert.equal(open.groups[0].expanded, true);
  const col = open.columns.find((c) => c.category === "compute")!;
  assert.ok(col.w > NODE_W, "a crowded cell wraps into sub-columns instead of one very tall stack");
  const lane = open.lanes.find((x) => x.id === "production")!;
  assert.ok(lane.h < 42 * NODE_H, "the lane is shorter than 42 stacked nodes");

  const flat = layoutGraph([...fns, ...stagingFns], [], { groupByEnv: false });
  assert.equal(flat.nodeById.get(groupId(ALL_LANE, "lambda"))!.members!.length, 54, "without lanes the whole set groups");
});

test("viewport: crowded cells wrap to fit the canvas's shape", () => {
  const res = Array.from({ length: 60 }, (_, i) => r(`k-${i}`, i % 2 ? "lambda" : "ecs-service", "production"));
  const wide = layoutGraph(res, [], { viewport: { w: 1600, h: 500 }, groupThreshold: 100 });
  const tall = layoutGraph(res, [], { viewport: { w: 500, h: 1600 }, groupThreshold: 100 });
  const aspect = (l: ReturnType<typeof layoutGraph>) => (l.bounds.x1 - l.bounds.x0) / (l.bounds.y1 - l.bounds.y0);
  assert.ok(aspect(wide) > aspect(tall), `wide ${aspect(wide).toFixed(2)} vs tall ${aspect(tall).toFixed(2)}`);
  assert.ok(aspect(wide) > 1.2);
  const again = layoutGraph([...res].reverse(), [], { viewport: { w: 1600, h: 500 }, groupThreshold: 100 });
  assert.deepEqual(again.nodes.map((n) => [n.id, n.x, n.y]), wide.nodes.map((n) => [n.id, n.x, n.y]), "still deterministic");
});

test("barycenter ordering untangles a crossed pair", () => {
  // Left column: a, b (a sorts first by name). Right column: x, y. Edges a→y, b→x cross unless the right column flips.
  const res = [r("a", "loadbalancer", "p", "a"), r("b", "loadbalancer", "p", "b"), r("x", "ecs-service", "p", "x"), r("y", "ecs-service", "p", "y")];
  const l = layoutGraph(res, [e("a", "y", "route"), e("b", "x", "route")]);
  const Y = (k: string) => l.nodeById.get(k)!.y;
  assert.equal(Y("a") < Y("b"), Y("y") < Y("x"), "one column flipped so a–y and b–x no longer cross");
});

test("edge geometry: ports on facing sides, arcs within a column, strongest confidence wins when merged", () => {
  const l = layoutGraph(SHOP, [...SHOP_EDGES, e("api", "db", "reads", "mentioned"), e("db", "api", "uses", "allowed"), e("api", "fn", "invoke")]);
  const lb = l.nodeById.get("lb")!, api = l.nodeById.get("api")!, fn = l.nodeById.get("fn")!;
  const route = l.edges.find((x) => x.from === "lb" && x.to === "api")!;
  assert.ok(Math.abs(route.start.x - (lb.x + lb.w)) <= 3, "leaves from the right side of the source");
  assert.ok(Math.abs(route.end.x - api.x) <= 6, "arrives on the left side of the target");
  assert.match(route.path, /^M[\d.]+,[\d.]+C/);
  const sameCol = l.edges.find((x) => x.from === "api" && x.to === "fn")!;
  assert.ok(sameCol.start.x > api.x + api.w - 1 && sameCol.end.x > fn.x + fn.w - 1, "same sub-column → an arc on the right side");
  assert.ok(sameCol.box.x1 > api.x + api.w + 20, "the arc bulges out");
  const merged = l.edges.find((x) => x.from === "api" && x.to === "db")!;
  assert.deepEqual(merged.kinds.sort(), ["reads", "sql"]);
  assert.equal(merged.confidence, "config");
  assert.equal(merged.kind, "sql");
  assert.ok(l.edges.some((x) => x.from === "db" && x.to === "api"), "the reverse direction is its own line");
  const back = l.edges.find((x) => x.from === "db" && x.to === "api")!;
  const db = l.nodeById.get("db")!;
  assert.ok(Math.abs(back.start.x - db.x) <= 3, "a right-to-left edge leaves from the left side");
  // Edges to missing nodes are dropped.
  assert.equal(layoutGraph(SHOP, [e("api", "ghost")]).edges.length, 0);
});

test("helpers: culling intersection, arrow-key neighbours, adjacency", () => {
  assert.ok(intersects({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 5, x1: 20, y1: 20 }));
  assert.ok(!intersects({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 11, y0: 0, x1: 20, y1: 20 }));
  const l = layoutGraph(SHOP, SHOP_EDGES);
  const adj = adjacencyOf(l);
  assert.deepEqual([...adj.get("q")!].sort(), ["api", "fn"]);
  assert.equal(neighbourInDirection(l, "lb", "right", adj), "api", "right follows the connection");
  assert.equal(neighbourInDirection(l, "api", "left", adj), "lb");
  const down = neighbourInDirection(l, "api", "down", adj);
  assert.ok(down && l.nodeById.get(down)!.y > l.nodeById.get("api")!.y);
  assert.equal(neighbourInDirection(l, "stripe", "right", adj), undefined, "nothing further right");
});

// Target: ~12 ms warm on an idle machine. The bounds are loose because the suite runs files in parallel; they still
// catch an accidental O(n²), which costs seconds, not milliseconds.
test("performance: 1,000 nodes and 3,000 edges lay out quickly", () => {
  const { res, edges } = bigGraph(1000, 3000, 11);
  layoutGraph(res, edges); // warm the JIT
  const times: number[] = [];
  let last;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    last = layoutGraph(res, edges, { groupThreshold: 1_000 }); // no grouping: every node individually
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const best = times[0];
  assert.equal(last!.nodes.length, 1000);
  assert.ok(last!.edges.length > 2900, `${last!.edges.length} edges drawn`);
  assert.ok(best < 150, `best of 5: ${best.toFixed(1)} ms`);
  const grouped = performance.now();
  const g = layoutGraph(res, edges, { viewport: { w: 1200, h: 700 } }); // default grouping + canvas-fitted wrapping
  assert.ok(performance.now() - grouped < 150);
  assert.ok(g.nodes.length < 1000, "with default grouping, big same-kind sets collapse");
});

// ---- D.8: lanes by VPC / region, support layers, folding, per-kind thresholds, portrait (step 4), budgets (CC-18) ----

const noOverlap = (l: Layout) => {
  for (const a of l.nodes)
    for (const b of l.nodes)
      if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} overlaps ${b.id}`);
};

test("laneBy: environment (default, groupByEnv alias), VPC, region and none", () => {
  const res = [
    r("arn:aws:ec2:us-east-1:1:vpc/vpc-prod", "vpc", "production", "acme-production"),
    r("api", "ecs-service", "production", "api", { vpcId: "vpc-prod", region: "us-east-1" }),
    r("db", "rds", "production", "db", { vpcId: "vpc-prod", region: "us-east-1" }),
    r("eu-db", "rds", "production", "eu-db", { vpcId: "vpc-eu", region: "eu-west-1" }),
    r("fn", "lambda", "staging", "fn", { region: "us-east-1" }),
    r("cdn", "cloudfront", undefined, "cdn", { region: "global" }),
  ];
  assert.equal(vpcIdOfKey("arn:aws:ec2:us-east-1:1:vpc/vpc-prod"), "vpc-prod");
  assert.equal(vpcIdOfKey("ec2:i-0abc"), undefined);
  assert.equal(laneOf(res[0], "vpc"), "vpc-prod", "a VPC sits in its own lane");
  const byVpc = layoutGraph(res, [], { laneBy: "vpc", laneLabels: { "vpc-prod": "acme-production", "vpc-eu": "acme-eu" }, layers: ["network"] });
  assert.deepEqual(byVpc.lanes.map((x) => [x.id, x.label]), [["vpc-eu", "acme-eu"], ["vpc-prod", "acme-production"], [SHARED_LANE, "No VPC"]]);
  assert.equal(byVpc.nodeById.get("api")!.lane, "vpc-prod");
  assert.equal(byVpc.laneBy, "vpc");
  const byRegion = layoutGraph(res, [], { laneBy: "region", regions: ["us-east-1", "eu-west-1"] });
  assert.deepEqual(byRegion.lanes.map((x) => x.id), ["us-east-1", "eu-west-1", GLOBAL_LANE], "regions in the given order (home first), global last");
  assert.equal(byRegion.lanes.find((x) => x.id === GLOBAL_LANE)!.label, "Global");
  const none = layoutGraph(res, [], { laneBy: "none" });
  assert.deepEqual(none.lanes.map((x) => [x.id, x.label]), [[ALL_LANE, ""]]);
  assert.deepEqual(layoutGraph(res, [], { groupByEnv: false }).lanes.map((x) => x.id), [ALL_LANE], "groupByEnv: false is laneBy none");
  assert.deepEqual(layoutGraph(res, [], { groupByEnv: false, laneBy: "env" }).lanes.map((x) => x.id)[0], "production", "laneBy wins over the alias");
  // `regions` only orders lanes: a reference to a region the console doesn't read (R14) keeps its node and gets a
  // lane after the known ones; nothing is filtered out (the page filters by region before laying out).
  const ref = r("arn:aws:sqs:eu-central-1:2:partner-q", "aws-resource", undefined, "partner-q", { region: "eu-central-1", source: "reference", service: "SQS", category: "messaging" });
  const withRef = layoutGraph([...res, ref], [], { laneBy: "region", regions: ["us-east-1", "eu-west-1"] });
  assert.deepEqual(withRef.lanes.map((x) => x.id), ["us-east-1", "eu-west-1", "eu-central-1", GLOBAL_LANE]);
  assert.ok(withRef.nodeOf.has(ref.key), "the remote reference is drawn");
  const one = layoutGraph([...res, ref], [], { regions: ["eu-west-1"] });
  assert.equal(one.nodeOf.size, layoutGraph([...res, ref], []).nodeOf.size, "regions never filters");
  assert.ok(one.nodeOf.has("api") && one.nodeOf.has(ref.key));
});

test("support layers: off by default (other services on), drawn after the flow columns when switched on", () => {
  const res = [
    r("api", "ecs-service", "production"),
    r("role", "iam-role", "production"),
    r("logs", "log-group", "production"),
    r("sg", "security-group", "production"),
    r("gen", "aws-resource", "production", "acme-recs", { category: "other", service: "SageMaker", resourceType: "sagemaker:endpoint" }),
    r("hid", "lambda", "production", "hidden", { hidden: true }),
  ];
  assert.deepEqual(DEFAULT_LAYERS, ["other"]);
  const def = layoutGraph(res, [e("api", "role", "assumes")]);
  assert.deepEqual(def.columns.map((c) => c.category), ["compute", "other"], "security, observability and network are off; hidden rows are never drawn");
  assert.equal(def.edges.length, 0, "an edge to a resource on a switched-off layer is not drawn");
  const all = layoutGraph(res, [e("api", "role", "assumes")], { layers: [...SUPPORT_ORDER] });
  assert.deepEqual(all.columns.map((c) => c.category), ["compute", "network", "security", "observability", "other"]);
  const flowEnd = all.columns.find((c) => c.category === "compute")!;
  for (const c of all.columns.filter((x) => SUPPORT_ORDER.includes(x.category as never))) assert.ok(c.x > flowEnd.x, `${c.category} comes after the flow columns`);
  assert.equal(all.edges.length, 1);
  // Generic resources take their category from the row (categoryOf), not KIND_INFO.
  const gen = layoutGraph([r("g2", "aws-resource", "production", "m", { category: "compute", service: "SageMaker" })], []);
  assert.deepEqual(gen.columns.map((c) => c.category), ["compute"]);
});

test("group thresholds: support layers group past 6, generic resources always group per lane and AWS service", () => {
  const sgs = Array.from({ length: 7 }, (_, i) => r(`sg-${i}`, "security-group", "production"));
  const roles = Array.from({ length: 6 }, (_, i) => r(`role-${i}`, "iam-role", "production"));
  const gens = [
    r("sm-1", "aws-resource", "production", "a", { category: "other", service: "SageMaker" }),
    r("sm-2", "aws-resource", "production", "b", { category: "other", service: "SageMaker" }),
    r("gl-1", "aws-resource", "production", "c", { category: "other", service: "Glue" }),
  ];
  const l = layoutGraph([...sgs, ...roles, ...gens], [], { layers: ["network", "security", "other"] });
  assert.equal(l.nodeById.get(groupId("production", "security-group"))!.members!.length, 7, "7 > 6: grouped");
  assert.ok(l.nodeById.has("role-0"), "6 roles stay individual");
  const sm = l.nodeById.get(groupId("production", "aws-resource", "SageMaker"))!;
  assert.equal(sm.type, "group");
  assert.equal(sm.service, "SageMaker");
  assert.deepEqual(sm.members, ["sm-1", "sm-2"]);
  assert.equal(l.nodeById.get(groupId("production", "aws-resource", "Glue"))!.members!.length, 1, "threshold 0: even one generic resource is a group");
  assert.ok(l.groups.some((g) => g.service === "Glue"));
  // R14: references to another account or region are drawn on their own, not folded into the local service's group.
  const refs = layoutGraph([...gens, r("ext", "aws-resource", "production", "partner", { category: "other", service: "SageMaker", source: "reference" })], []);
  assert.ok(refs.nodeById.has("ext"));
  assert.deepEqual(refs.nodeById.get(groupId("production", "aws-resource", "SageMaker"))!.members, ["sm-1", "sm-2"]);
  // Overrides per kind or category.
  const o = layoutGraph([...sgs, ...roles], [], { layers: ["network", "security"], groupThresholds: { "security-group": 100, security: 2 } });
  assert.ok(o.nodeById.has("sg-0"));
  assert.ok(o.nodeById.has(groupId("production", "iam-role")));
});

test("folding: children fold into the top-most collapsed parent on the map; expanding shows them", () => {
  const vpc = "arn:aws:ec2:us-east-1:1:vpc/vpc-prod";
  const res = [
    r(vpc, "vpc", "production", "acme-production"),
    r("subnet-a", "subnet", "production", "private-a", { parent: vpc }),
    r("subnet-b", "subnet", "production", "private-b", { parent: vpc }),
    r("nat", "nat-gateway", "production", "nat-a", { parent: "subnet-a" }),
    r("api", "ecs-service", "production"),
    r("orphan", "subnet", "production", "orphan", { parent: "not-on-the-map" }),
    r("loop-a", "subnet", "production", "loop-a", { parent: "loop-b" }),
    r("loop-b", "subnet", "production", "loop-b", { parent: "loop-a" }),
  ];
  const edges = [e("subnet-a", "nat", "route"), e("api", "nat", "uses"), e("cluster-m1", "api")];
  const l = layoutGraph(res, edges, { layers: ["network"] });
  const v = l.nodeById.get(vpc)!;
  assert.deepEqual(v.folded, ["nat", "subnet-a", "subnet-b"]);
  assert.equal(l.nodeOf.get("nat"), vpc);
  assert.ok(!l.nodeById.has("subnet-a"));
  assert.ok(l.nodeById.has("orphan"), "a parent that isn't on the map folds nothing");
  assert.equal(l.lanes[0].count, res.length - 2 + 2, "folded children still count in their lane");
  assert.ok(l.edges.some((x) => x.from === "api" && x.to === vpc), "edges to a folded child attach to its parent");
  assert.ok(!l.edges.some((x) => x.from === x.to), "child → own parent edges disappear");
  const open = layoutGraph(res, edges, { layers: ["network"], expanded: [parentId(vpc)] });
  assert.ok(open.nodeById.has("subnet-a") && open.nodeById.has("subnet-b"));
  assert.equal(open.nodeOf.get("nat"), "subnet-a", "the NAT now folds into its own subnet");
  assert.deepEqual(open.parents, [{ id: parentId(vpc), key: vpc, count: 2 }]);
  assert.ok(layoutGraph(res, edges, { layers: ["network"], foldChildren: false }).nodeById.has("nat"));
});

test("portrait (phones held upright): categories stack top → bottom, lanes stand side by side, edges run down", () => {
  const land = layoutGraph(SHOP, SHOP_EDGES);
  const l = layoutGraph(SHOP, SHOP_EDGES, { orientation: "portrait" });
  assert.equal(l.orientation, "portrait");
  assert.deepEqual(l.columns.map((c) => c.category), land.columns.map((c) => c.category));
  for (let i = 1; i < l.columns.length; i++) assert.ok(l.columns[i].y >= l.columns[i - 1].y + l.columns[i - 1].h, "category bands stack without overlap");
  for (let i = 1; i < l.lanes.length; i++) assert.ok(l.lanes[i].x >= l.lanes[i - 1].x + l.lanes[i - 1].w, "lanes stand side by side");
  for (const n of l.nodes) {
    assert.equal(n.w, NODE_W, "nodes keep their on-screen size");
    assert.equal(n.h, NODE_H);
    const lane = l.lanes.find((x) => x.id === n.lane)!;
    assert.ok(n.x >= lane.x && n.x + n.w <= lane.x + lane.w, `${n.id} sits inside its lane`);
    const col = l.columns.find((c) => c.category === n.category)!;
    assert.ok(n.y >= col.y && n.y + n.h <= col.y + col.h, `${n.id} sits inside its band`);
  }
  noOverlap(l);
  const y = (k: string) => l.nodeById.get(k)!.y;
  assert.ok(y("dns") < y("api") && y("api") < y("q") && y("q") < y("db") && y("db") < y("bucket"), "flow runs top → bottom");
  const route = l.edges.find((x) => x.from === "lb" && x.to === "api")!;
  const lb = l.nodeById.get("lb")!, api = l.nodeById.get("api")!;
  assert.ok(Math.abs(route.start.y - (lb.y + lb.h)) <= 3, "leaves from the bottom of the source");
  assert.ok(Math.abs(route.end.y - api.y) <= 6, "arrives on the top of the target");
  const aspect = (x: Layout) => (x.bounds.y1 - x.bounds.y0) / (x.bounds.x1 - x.bounds.x0);
  assert.ok(aspect(l) > aspect(land) * 2, `a taller plane: ${aspect(l).toFixed(2)} vs ${aspect(land).toFixed(2)}`);
  assert.equal(neighbourInDirection(l, "lb", "down", adjacencyOf(l)), "api", "down follows the connection in portrait");
  const { res, edges } = bigGraph(300, 900, 5);
  const big = layoutGraph(res, edges, { orientation: "portrait", viewport: { w: 390, h: 700 } });
  noOverlap(big);
  assert.equal(JSON.stringify(big.nodes.map((n) => [n.id, n.x, n.y])), JSON.stringify(layoutGraph([...res].reverse(), [...edges].reverse(), { orientation: "portrait", viewport: { w: 390, h: 700 } }).nodes.map((n) => [n.id, n.x, n.y])), "still deterministic");
});

// CC-18: the budget is on the visible nodes after grouping, not on the input.
test("performance: 20,000 input resources collapse to ≤ 1,500 visible nodes and lay out in < 150 ms", () => {
  const rand = rng(23);
  const kinds = Object.keys(KIND_INFO) as ResourceKind[];
  const services = ["SageMaker", "Glue", "Batch", "Transfer", "IoT", "MediaConvert", "Pinpoint", "QuickSight"];
  const cats: Category[] = ["compute", "data", "other", "other"];
  const envs = ["production", "staging", "dev", undefined];
  const n = 20_000;
  const res: LayoutResource[] = Array.from({ length: n }, (_, i) => {
    const kind = kinds[Math.floor(rand() * kinds.length)];
    const extra: Partial<LayoutResource> = kind === "aws-resource" ? { service: services[Math.floor(rand() * services.length)], category: cats[Math.floor(rand() * cats.length)] } : {};
    if (kind === "subnet" && i > 10 && rand() < 0.5) extra.parent = `res-${i - 1 - Math.floor(rand() * 10)}`;
    return r(`res-${i}`, kind, envs[Math.floor(rand() * envs.length)], `name-${i}`, { region: rand() < 0.8 ? "us-east-1" : "eu-west-1", ...extra });
  });
  const edges: LayoutEdgeInput[] = [];
  for (let i = 0; i < n * 3; i++) {
    const a = Math.floor(rand() * n), b = Math.floor(rand() * n);
    if (a !== b) edges.push(e(`res-${a}`, `res-${b}`, "uses"));
  }
  layoutGraph(res, edges); // warm the JIT
  // CPU time, not wall time: `npm test` runs test files (and their child processes) in parallel, and a wall-clock
  // budget then measures the machine's load rather than the layout. The budget is the same 150 ms of work.
  const times: number[] = [];
  let l: Layout | undefined;
  for (let i = 0; i < 5; i++) {
    const t = process.cpuUsage();
    l = layoutGraph(res, edges, { viewport: { w: 1400, h: 800 } });
    const d = process.cpuUsage(t);
    times.push((d.user + d.system) / 1000);
  }
  times.sort((a, b) => a - b);
  assert.ok(l!.nodes.length <= 1500, `${l!.nodes.length} visible nodes`);
  assert.ok(times[0] < 150, `best of 5: ${times[0].toFixed(1)} ms of CPU`);
  assert.ok(l!.nodes.every((x) => !SUPPORT_ORDER.includes(x.category as never) || x.category === "other"), "default layers only");
  // Every layer on, lanes by VPC and region: still within the visible-node budget.
  for (const opts of [{ layers: [...SUPPORT_ORDER] }, { layers: [...SUPPORT_ORDER], laneBy: "region" as const }]) {
    const all = layoutGraph(res, edges, opts);
    assert.ok(all.nodes.length <= 1500, `${all.nodes.length} visible nodes with ${JSON.stringify(opts)}`);
  }
  // Informational (D.8): 5,000 nodes ungrouped.
  const t = performance.now();
  const flat = layoutGraph(res.slice(0, 5000).filter((x) => categoryOf(x) !== "other"), edges.slice(0, 15000), { groupThreshold: 100_000, groupThresholds: { network: 100_000, security: 100_000, observability: 100_000, delivery: 100_000 }, layers: [...SUPPORT_ORDER] });
  const ms = performance.now() - t;
  assert.ok(flat.nodes.length > 4000);
  if (ms > 600) console.log(`informational: 5,000 ungrouped nodes took ${ms.toFixed(0)} ms (target < 600 ms)`);
});
