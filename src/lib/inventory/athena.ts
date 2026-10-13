// Athena workgroups, pure part: ListWorkGroups summaries (+ GetWorkGroup configuration), real or simulated, →
// Resources and links (audit §6 A.2, P2 athena).
// - Key: arnOf.athenaWorkgroup. Every region has the default "primary" workgroup; it is hidden while it has no query
//   result location (an untouched default), and also when its configuration wasn't read.
// - Links: workgroup → its query-results bucket (writes); KMS → workgroup (encrypts) for SSE_KMS / CSE_KMS results and
//   customer content encryption; workgroup → its execution role (assumes, Spark workgroups).
// - Health: ENABLED ok, DISABLED stopped. Tags aren't read (tagsUnread, R01). No activity series.
// Spark properties (AdditionalConfiguration) may hold credentials: they are never copied (athena.test.ts sentinel).
// No AWS calls and no `server-only`, so node:test runs it (athena.test.ts).
import { arnOf, partitionOf } from "./arn.ts";
import { assumesLink, awsTime, clip, encryptsLink, enrichmentOf, fmtBytes, fmtTime, kmsKeyRef, props, unread } from "./serverless-common.ts";
import type { EnrichState, Link, ProviderResult, Resource, ResourceDetail } from "./types.ts";

// GetWorkGroup's WorkGroupConfiguration, the parts the map uses.
export interface AthenaConfig {
  ResultConfiguration?: { OutputLocation?: string; EncryptionConfiguration?: { EncryptionOption?: string; KmsKey?: string }; ExpectedBucketOwner?: string };
  ManagedQueryResultsConfiguration?: { Enabled?: boolean; EncryptionConfiguration?: { KmsKey?: string } };
  EnforceWorkGroupConfiguration?: boolean;
  PublishCloudWatchMetricsEnabled?: boolean;
  BytesScannedCutoffPerQuery?: number;
  RequesterPaysEnabled?: boolean;
  EngineVersion?: { SelectedEngineVersion?: string; EffectiveEngineVersion?: string };
  ExecutionRole?: string;
  CustomerContentEncryptionConfiguration?: { KmsKey?: string };
}

export interface RawWorkGroup {
  Name?: string;
  State?: string; // ENABLED | DISABLED
  Description?: string;
  CreationTime?: Date | string;
  EngineVersion?: { SelectedEngineVersion?: string; EffectiveEngineVersion?: string };
  config?: AthenaConfig; // GetWorkGroup; undefined = not read (see enrichment.config)
  enrichment?: Record<string, EnrichState>;
}

// "s3://bucket/prefix/" → the bucket's ARN (S3 keys are partition-wide, region-less).
export function bucketArnOf(location: string | undefined, region: string): string | undefined {
  const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/|$)/i.exec(location?.trim() ?? "");
  return m ? `arn:${partitionOf(region)}:s3:::${m[1]}` : undefined;
}

const hasResults = (w: RawWorkGroup) => !!w.config?.ResultConfiguration?.OutputLocation || w.config?.ManagedQueryResultsConfiguration?.Enabled === true;
export const isHiddenWorkGroup = (w: RawWorkGroup) => w.Name === "primary" && !hasResults(w);

export function athenaConsoleUrl(region: string, name: string) {
  return `https://${region}.console.aws.amazon.com/athena/home?region=${region}#/workgroups/details/${encodeURIComponent(name)}`;
}

function resultsText(w: RawWorkGroup): string | undefined {
  const c = w.config;
  if (!c) return unread("configuration", w.enrichment?.config);
  if (c.ManagedQueryResultsConfiguration?.Enabled) return "managed by Athena";
  return c.ResultConfiguration?.OutputLocation ?? "not set";
}

const encryptionText = (c: AthenaConfig | undefined) => {
  const e = c?.ResultConfiguration?.EncryptionConfiguration;
  if (!e?.EncryptionOption) return undefined;
  return `${e.EncryptionOption}${e.KmsKey ? ` · ${e.KmsKey.replace(/^arn:aws[\w-]*:kms:[^:]+:\d+:/, "")}` : ""}`;
};

export function athenaResult(groups: RawWorkGroup[], o: { region: string; account?: string }): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const w of groups) {
    if (!w.Name || !o.account) continue;
    const key = arnOf.athenaWorkgroup(o.region, o.account, w.Name);
    const c = w.config;
    const enrichment = enrichmentOf(w.enrichment);
    const disabled = w.State === "DISABLED";
    const engine = (c?.EngineVersion ?? w.EngineVersion)?.EffectiveEngineVersion;
    resources.push({
      key,
      kind: "athena-workgroup",
      provider: "athena",
      name: w.Name,
      region: o.region,
      tags: {},
      tagsUnread: true,
      health: disabled ? "stopped" : w.State === "ENABLED" ? "ok" : "unknown",
      ...(disabled ? { healthReason: "disabled — queries can't run in it" } : !w.State ? { healthReason: "state not reported" } : {}),
      ...(isHiddenWorkGroup(w) ? { hidden: true } : {}),
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Query results", value: resultsText(w), mono: !!c?.ResultConfiguration?.OutputLocation },
        { label: "Encryption", value: encryptionText(c) },
        { label: "Engine", value: engine },
        { label: "Enforce settings", value: c?.EnforceWorkGroupConfiguration === undefined ? undefined : c.EnforceWorkGroupConfiguration ? "yes" : "no" },
        { label: "Scan limit per query", value: c?.BytesScannedCutoffPerQuery ? fmtBytes(c.BytesScannedCutoffPerQuery) : undefined },
        { label: "Execution role", value: c?.ExecutionRole?.split("/").pop() },
        { label: "Description", value: w.Description ? clip(w.Description, 200) : undefined },
        { label: "Created", value: w.CreationTime ? fmtTime(awsTime(w.CreationTime)) : undefined },
      ]),
      aliases: [w.Name],
      consoleUrl: athenaConsoleUrl(o.region, w.Name),
      ...(w.CreationTime ? { createdAt: awsTime(w.CreationTime) } : {}),
    });
    const bucket = bucketArnOf(c?.ResultConfiguration?.OutputLocation, o.region);
    if (bucket) links.push({ from: key, to: bucket, kind: "writes", label: "query results", evidence: "ResultConfiguration.OutputLocation" });
    const kms = new Set([
      ...(/KMS/.test(c?.ResultConfiguration?.EncryptionConfiguration?.EncryptionOption ?? "") ? [c?.ResultConfiguration?.EncryptionConfiguration?.KmsKey] : []),
      c?.ManagedQueryResultsConfiguration?.EncryptionConfiguration?.KmsKey,
      c?.CustomerContentEncryptionConfiguration?.KmsKey,
    ].map((k) => kmsKeyRef(k, o.region, o.account)).filter((k): k is string => !!k));
    for (const k of kms) links.push(...encryptsLink(k, key, "query results", "workgroup encryption configuration"));
    links.push(...assumesLink(key, c?.ExecutionRole, "execution role", "WorkGroupConfiguration.ExecutionRole"));
  }
  return { resources, links, mentions: [] };
}

// The panel: the workgroup's configuration (GetWorkGroup, live or simulated).
export function athenaDetail(key: string, w: RawWorkGroup | undefined): ResourceDetail {
  if (!w) return { key, sections: [{ title: "Workgroup", note: "This workgroup no longer exists." }] };
  const c = w.config;
  return {
    key,
    sections: [
      {
        title: "Workgroup",
        rows: props([
          { label: "State", value: w.State },
          { label: "Query results", value: resultsText(w), mono: true },
          { label: "Expected bucket owner", value: c?.ResultConfiguration?.ExpectedBucketOwner, mono: true },
          { label: "Encryption", value: encryptionText(c) },
          { label: "Enforce workgroup settings", value: c?.EnforceWorkGroupConfiguration === undefined ? undefined : String(c.EnforceWorkGroupConfiguration) },
          { label: "CloudWatch metrics", value: c?.PublishCloudWatchMetricsEnabled === undefined ? undefined : c.PublishCloudWatchMetricsEnabled ? "published" : "off" },
          { label: "Scan limit per query", value: c?.BytesScannedCutoffPerQuery ? fmtBytes(c.BytesScannedCutoffPerQuery) : "none" },
          { label: "Requester pays", value: c?.RequesterPaysEnabled ? "yes" : undefined },
          { label: "Engine", value: (c?.EngineVersion ?? w.EngineVersion)?.EffectiveEngineVersion },
          { label: "Execution role", value: c?.ExecutionRole, mono: true },
          { label: "Description", value: w.Description },
          { label: "Created", value: w.CreationTime ? fmtTime(awsTime(w.CreationTime)) : undefined },
        ]),
      },
    ],
  };
}
