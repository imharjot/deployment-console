import { test } from "node:test";
import assert from "node:assert/strict";
import type { Resource, ResourceKind } from "../../lib/inventory/types.ts";
import { DEFAULT_TABLE, kindKeyOf, sourceOf, tableFromParams, tableRows, tableToParams, toCsv } from "./table-rules.ts";

const r = (key: string, kind: ResourceKind, extra: Partial<Resource> = {}): Resource => ({ key, kind, name: key, provider: "t", region: "us-east-1", tags: {}, health: "ok", props: [], ...extra });
const RES = [
  r("api", "ecs-service", { env: "production", health: "warning", healthReason: "1 of 2 tasks unhealthy" }),
  r("db", "rds", { env: "production", region: "eu-west-1" }),
  r("key", "kms-key", { hidden: true, slim: true }),
  r("sm", "aws-resource", { resourceType: "sagemaker:endpoint", service: "SageMaker", category: "compute", source: "resource-explorer", slim: true }),
  r("ext", "aws-resource", { resourceType: "s3:bucket", service: "S3", category: "storage", source: "reference", facts: { remote: true }, account: "210987654321" }),
  r("=cmd", "lambda", { health: "error", healthReason: 'said "no"' }),
];
const keys = (x: Resource[]) => x.map((y) => y.key);

test("All resources: hidden rows only on request; filters by kind (generic → type), service, category, region, env, health, source", () => {
  assert.deepEqual(keys(tableRows(RES, DEFAULT_TABLE)).sort(), ["=cmd", "api", "db", "ext", "sm"]);
  assert.ok(keys(tableRows(RES, { ...DEFAULT_TABLE, hidden: true })).includes("key"));
  assert.equal(kindKeyOf(RES[3]), "sagemaker:endpoint");
  assert.deepEqual(keys(tableRows(RES, { ...DEFAULT_TABLE, kind: "sagemaker:endpoint" })), ["sm"]);
  assert.deepEqual(keys(tableRows(RES, { ...DEFAULT_TABLE, service: "S3" })), ["ext"]);
  assert.deepEqual(keys(tableRows(RES, { ...DEFAULT_TABLE, category: "compute" })).sort(), ["=cmd", "api", "sm"]);
  assert.deepEqual(keys(tableRows(RES, { ...DEFAULT_TABLE, region: "eu-west-1" })), ["db"]);
  assert.deepEqual(keys(tableRows(RES, { ...DEFAULT_TABLE, env: "__shared" })).sort(), ["=cmd", "ext", "sm"]);
  assert.deepEqual(keys(tableRows(RES, { ...DEFAULT_TABLE, health: "problems" })), ["=cmd", "api"], "problems: error first (default sort is health)");
  assert.deepEqual(keys(tableRows(RES, { ...DEFAULT_TABLE, source: "reference" })), ["ext"]);
  assert.equal(sourceOf(RES[0]), "provider");
  assert.deepEqual(keys(tableRows(RES, { ...DEFAULT_TABLE, q: "sagemaker" })), ["sm"], "search covers the service");
});

test("sorting: any column, both directions, ties by name", () => {
  const byName = keys(tableRows(RES, { ...DEFAULT_TABLE, sort: "name", dir: 1 }));
  assert.deepEqual(byName, ["=cmd", "api", "db", "ext", "sm"]);
  assert.deepEqual(keys(tableRows(RES, { ...DEFAULT_TABLE, sort: "name", dir: -1 })), [...byName].reverse());
  assert.equal(keys(tableRows(RES, { ...DEFAULT_TABLE, sort: "region", dir: 1 }))[0], "db", "eu-west-1 before us-east-1");
});

test("CSV: quoted, quotes doubled, formula-looking cells defused, remote rows say so", () => {
  const csv = toCsv(tableRows(RES, { ...DEFAULT_TABLE, sort: "name" }));
  const lines = csv.split("\r\n");
  assert.equal(lines[0], '"name","key","kind","service","category","environment","region","health","reason","source","hidden","idle","account"');
  assert.ok(lines[1].startsWith(`"'=cmd","'=cmd","Lambda function"`), "a leading = can't run in a spreadsheet");
  assert.ok(lines[1].includes('"said ""no"""'));
  assert.ok(csv.includes("referenced — not in this account/region"));
});

test("URL: round trip, defaults left out; the map's filters carry over", () => {
  assert.equal(tableToParams(DEFAULT_TABLE).toString(), "");
  const f = { ...DEFAULT_TABLE, q: "orders", kind: "sqs", region: "eu-west-1", env: "production", health: "problems", source: "provider", hidden: true, sort: "name" as const, dir: -1 as const };
  assert.deepEqual(tableFromParams(tableToParams(f)), f);
  const fromMap = tableFromParams(new URLSearchParams("view=table&q=x&kinds=lambda&problems=1&region=eu-west-1"));
  assert.equal(fromMap.kind, "lambda");
  assert.equal(fromMap.health, "problems");
  assert.equal(fromMap.region, "eu-west-1");
  assert.equal(tableFromParams(new URLSearchParams("sort=bogus")).sort, DEFAULT_TABLE.sort);
});
