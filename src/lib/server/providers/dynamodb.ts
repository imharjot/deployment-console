// DynamoDB provider: tables with billing mode and capacity, approximate item count and size, key schema, indexes,
// stream (its ARN is an alias, so Lambda stream triggers resolve to the table), table class, global-table replicas,
// deletion protection and encryption (a customer-managed or AWS-managed KMS key: an encrypts edge). Discovery lists the
// names, hands them to ctx.checkpoint, then reads each table and its tags through enrich() (R18): a table whose details
// weren't read has unknown health, one whose tags weren't read is tagsUnread (R01); tags are read through every page
// (ListTagsOfResource pages them, and a protection tag on page two must not be missed). authoritative() reads them live
// for a change made through another provider. Data is out of scope: no item reads, no actions.
import "server-only";
import { DescribeTableCommand, DynamoDBClient, ListTablesCommand, ListTagsOfResourceCommand } from "@aws-sdk/client-dynamodb";
import { partitionOf } from "../../inventory/arn.ts";
import { arnName, fmtCount, parseArn, tagMap } from "../../inventory/serverless-common.ts";
import { billingLabel, dynamoResult, type RawTable } from "../../inventory/serverless-data.ts";
import type { Resource, ResourceDetail } from "../../inventory/types.ts";
import { simDynamo } from "./mock/dynamodb.ts";
import { budget, enrich, invalid, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const dynamo = perRegion((region) => new DynamoDBClient(sdkConfig(region)), "dynamodb");
const DETAILS_MAX = 1000;
const TAG_PAGES = 20; // a table holds at most 50 user tags (plus aws: ones): every page, bounded
const AUTHORITATIVE_MS = 5_000; // the live tag read before a change (R01)

const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || r.region || fallback;
// A table's ARN from its name, in the run's region and account (DescribeTable returns the same string).
const tableArn = (ctx: ProviderContext, name: string) => (ctx.accountId ? `arn:${partitionOf(ctx.region)}:dynamodb:${ctx.region}:${ctx.accountId}:table/${name}` : undefined);

// Every page of a table's tags. A last page that never comes throws: partial tags must never pass for all of them.
async function tableTags(c: DynamoDBClient, ResourceArn: string, opts: { abortSignal: AbortSignal }): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let NextToken: string | undefined;
  let pages = 0;
  do {
    const r = await c.send(new ListTagsOfResourceCommand({ ResourceArn, NextToken }), opts);
    Object.assign(out, tagMap(r.Tags));
    NextToken = r.NextToken || undefined;
    if (NextToken && ++pages >= TAG_PAGES) throw new Error(`dynamodb tags of ${arnName(ResourceArn)}: incomplete (more pages than read)`);
  } while (NextToken);
  return out;
}

async function fetchDynamo(ctx: ProviderContext): Promise<RawTable[]> {
  const c = dynamo(ctx.region);
  const names = await paged(ctx, "dynamodb", async (ExclusiveStartTableName) => {
    const r = await c.send(new ListTablesCommand({ ExclusiveStartTableName, Limit: 100 }), t(ctx));
    return { items: r.TableNames, next: r.LastEvaluatedTableName };
  }, { service: "dynamodb" });
  // Tables are listed by name; without the account id their ARN (the key) waits for DescribeTable.
  const base = (TableName: string): RawTable => ({ TableName, TableArn: tableArn(ctx, TableName), enrichment: { details: "skipped", tags: "skipped" } });
  ctx.checkpoint?.(dynamoResult(names.map(base)));
  const until = budget();
  const details = await enrich(ctx, names, { label: "dynamodb table details", max: DETAILS_MAX, until }, async (TableName) => (await c.send(new DescribeTableCommand({ TableName }), t(ctx))).Table);
  const tables = names.map((n, i): RawTable => ({ ...base(n), ...(details.results[i] ?? {}), enrichment: { details: details.state[i] } }));
  const tags = await enrich(ctx, tables, { label: "dynamodb tags", max: DETAILS_MAX, until }, async (x) =>
    x.TableArn ? tableTags(c, x.TableArn, t(ctx)) : undefined,
  );
  // Tables past the cap, or whose details were denied, still appear — by name, when their ARN is known.
  return tables
    .map((x, i): RawTable => ({ ...x, tags: tags.state[i] === "ok" && tags.results[i] ? tags.results[i] : undefined, enrichment: { ...x.enrichment, tags: tags.state[i] } }))
    .filter((x) => !!x.TableArn);
}

function buildDetail(r: Resource, t: RawTable | undefined): ResourceDetail {
  if (!t) return { key: r.key, sections: [{ title: "Not found", note: "This table no longer exists." }] };
  const gsis = t.GlobalSecondaryIndexes ?? [];
  return {
    key: r.key,
    sections: [
      {
        title: "Table",
        rows: [
          { label: "Status", value: t.TableStatus ?? "?" },
          { label: "Billing", value: billingLabel(t) },
          { label: "Key", value: (t.KeySchema ?? []).map((k) => `${k.AttributeName} (${k.KeyType === "HASH" ? "partition" : "sort"})`).join(", ") || "—", mono: true },
          ...(t.StreamSpecification?.StreamEnabled ? [{ label: "Stream", value: `${t.StreamSpecification.StreamViewType ?? "enabled"}${t.LatestStreamArn ? ` · ${t.LatestStreamArn.split("/stream/")[1] ?? ""}` : ""}`, mono: true }] : []),
          { label: "Item count", value: t.ItemCount !== undefined ? `~${fmtCount(t.ItemCount)} (updated about every 6 hours)` : "—" },
          ...(t.SSEDescription?.KMSMasterKeyArn ? [{ label: "KMS key", value: t.SSEDescription.KMSMasterKeyArn, mono: true }] : []),
        ],
      },
      {
        title: "Indexes",
        table: gsis.length || t.LocalSecondaryIndexes?.length ? {
          columns: ["Index", "Kind", "Status", "Items"],
          rows: [...gsis.map((g) => [g.IndexName ?? "", "global", g.IndexStatus ?? "", g.ItemCount !== undefined ? fmtCount(g.ItemCount) : ""]), ...(t.LocalSecondaryIndexes ?? []).map((l) => [l.IndexName ?? "", "local", "", ""])],
        } : undefined,
        note: gsis.length || t.LocalSecondaryIndexes?.length ? undefined : "No secondary indexes.",
      },
      ...(t.Replicas?.length ? [{ title: "Global table replicas", table: { columns: ["Region", "Status"], rows: t.Replicas.map((x) => [x.RegionName ?? "", x.ReplicaStatus ?? ""]) } }] : []),
    ],
  };
}

export const dynamodbProvider: Provider = {
  id: "dynamodb",
  label: "DynamoDB",
  scope: "regional",
  kinds: ["dynamodb"],
  covers: ["dynamodb:table"],
  multiRegionMock: true,
  read: ["dynamodb:ListTables", "dynamodb:DescribeTable", "dynamodb:ListTagsOfResource"],
  async discover(ctx) {
    return dynamoResult(ctx.mock ? simDynamo(ctx.region) : await fetchDynamo(ctx));
  },
  activity: (r) => [
    { namespace: "AWS/DynamoDB", metric: "ConsumedReadCapacityUnits", dims: { TableName: r.name }, stat: "Sum", label: "Read capacity used", region: regionOf(r, r.region), required: true },
    { namespace: "AWS/DynamoDB", metric: "ConsumedWriteCapacityUnits", dims: { TableName: r.name }, stat: "Sum", label: "Write capacity used", region: regionOf(r, r.region), required: true },
  ],
  async detail(r, ctx) {
    if (ctx.mock) return buildDetail(r, simDynamo(regionOf(r, ctx.region)).find((x) => x.TableArn === r.key));
    const d = await softly(ctx, "dynamodb table details")(() => dynamo(regionOf(r, ctx.region)).send(new DescribeTableCommand({ TableName: r.key }), t(ctx)));
    return buildDetail(r, d?.Table);
  },
  // R01: the table's tags, read live right before a change another provider makes to it (5 s for every page; throws
  // when they can't be read).
  async authoritative(r, ctx) {
    if (ctx.mock) {
      const table = simDynamo(regionOf(r, ctx.region)).find((x) => x.TableArn === r.key);
      if (!table) throw invalid(`table ${r.name} not found`);
      return { tags: { ...(table.tags ?? {}) } };
    }
    return { tags: await tableTags(dynamo(regionOf(r, ctx.region)), r.key, t(undefined, AUTHORITATIVE_MS)) };
  },
};
