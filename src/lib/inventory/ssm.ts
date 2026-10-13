// Parameter Store, pure part: DescribeParameters entries (real or simulated) → Resources and KMS links (audit §6 A.2 #8).
// Metadata only: DescribeParameters returns name, type, tier, version, KMS key and policies — never a value — and the
// provider never calls GetParameter(s). This mapper copies named metadata fields only (ssm.test.ts sentinel).
// - Key: arn:…:parameter/<name without its leading slash> (arnOf.ssmParameter); alias: the stored name.
// - Tags aren't listed by DescribeParameters: every parameter is tagsUnread (R01); detail() reads them.
// - Links: KMS → SecureString (encrypts), via its KeyId (default alias/aws/ssm).
// - Health: an Expiration policy whose time has passed → warning.
// No AWS calls and no `server-only`, so node:test runs it (ssm.test.ts).
import { arnOf } from "./arn.ts";
import { awsTime, clip, encryptsLink, fmtTime, kmsKeyRef, props } from "./serverless-common.ts";
import type { Health, Link, ProviderResult, Resource, ResourceDetail } from "./types.ts";

// DescribeParameters' ParameterMetadata.
export interface RawParameter {
  Name?: string;
  ARN?: string;
  Type?: string; // String | StringList | SecureString
  KeyId?: string;
  LastModifiedDate?: Date | string;
  LastModifiedUser?: string;
  Description?: string;
  AllowedPattern?: string;
  Version?: number;
  Tier?: string; // Standard | Advanced | Intelligent-Tiering
  Policies?: { PolicyText?: string; PolicyType?: string; PolicyStatus?: string }[];
  DataType?: string;
}

// The expiry an Expiration policy sets ({"Type":"Expiration","Attributes":{"Timestamp":"…"}}), if any.
export function expiresAt(p: RawParameter): number | undefined {
  for (const pol of p.Policies ?? []) {
    try {
      const v = JSON.parse(pol.PolicyText ?? "") as { Type?: string; Attributes?: { Timestamp?: string } };
      if ((v.Type ?? pol.PolicyType) === "Expiration" && v.Attributes?.Timestamp) return awsTime(v.Attributes.Timestamp);
    } catch {
      // not a policy we understand
    }
  }
  return undefined;
}

export function ssmConsoleUrl(region: string, name: string) {
  return `https://${region}.console.aws.amazon.com/systems-manager/parameters/${encodeURI(name.replace(/^\/+/, ""))}/description?region=${region}`;
}

export function ssmResult(params: RawParameter[], o: { region: string; account?: string; now: number }): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const p of params) {
    if (!p.Name) continue;
    const key = p.ARN ?? (o.account ? arnOf.ssmParameter(o.region, o.account, p.Name) : undefined);
    if (!key) continue;
    const region = key.split(":")[3] || o.region;
    const account = key.split(":")[4] || o.account;
    const expiry = expiresAt(p);
    const expired = expiry !== undefined && expiry <= o.now;
    const health: Health = expired ? "warning" : "ok";
    const modified = awsTime(p.LastModifiedDate);
    const secure = p.Type === "SecureString";
    resources.push({
      key,
      kind: "ssm-parameter",
      provider: "ssm",
      name: p.Name,
      region,
      tags: {},
      tagsUnread: true, // DescribeParameters doesn't return tags; the panel reads them
      health,
      ...(expired ? { healthReason: `expired on ${fmtTime(expiry)} (Expiration policy)` } : {}),
      props: props([
        { label: "Type", value: p.Type },
        { label: "Tier", value: p.Tier },
        { label: "Version", value: p.Version !== undefined ? String(p.Version) : undefined },
        { label: "Data type", value: p.DataType && p.DataType !== "text" ? p.DataType : undefined },
        { label: "KMS key", value: secure ? (p.KeyId ?? "alias/aws/ssm").replace(/^arn:aws[\w-]*:kms:[^:]+:\d+:/, "") : undefined },
        { label: "Expires", value: expiry !== undefined ? fmtTime(expiry) : undefined },
        { label: "Last modified", value: modified !== undefined ? `${fmtTime(modified)}${p.LastModifiedUser ? ` by ${p.LastModifiedUser.split("/").pop()}` : ""}` : undefined },
        { label: "Description", value: p.Description ? clip(p.Description, 200) : undefined },
      ]),
      aliases: [p.Name],
      consoleUrl: ssmConsoleUrl(region, p.Name),
      ...(modified !== undefined ? { lastModified: modified } : {}),
    });
    if (secure) links.push(...encryptsLink(kmsKeyRef(p.KeyId ?? "alias/aws/ssm", region, account), key, "SecureString", p.KeyId ? "KeyId" : "default key alias/aws/ssm"));
  }
  return { resources, links, mentions: [] };
}

// The panel: the metadata, its policies and tags (ListTagsForResource) — never the value.
export function ssmDetail(key: string, p: RawParameter | undefined, tags: { Key?: string; Value?: string }[] | undefined): ResourceDetail {
  if (!p) return { key, sections: [{ title: "Parameter", note: "This parameter no longer exists." }] };
  const t = (tags ?? []).filter((x) => x.Key);
  return {
    key,
    sections: [
      {
        title: "Parameter",
        rows: props([
          { label: "Name", value: p.Name, mono: true },
          { label: "Type", value: p.Type },
          { label: "Tier", value: p.Tier },
          { label: "Version", value: p.Version !== undefined ? String(p.Version) : undefined },
          { label: "KMS key", value: p.Type === "SecureString" ? (p.KeyId ?? "alias/aws/ssm") : undefined, mono: true },
          { label: "Allowed pattern", value: p.AllowedPattern, mono: true },
          { label: "Last modified", value: p.LastModifiedDate ? fmtTime(awsTime(p.LastModifiedDate)) : undefined },
          { label: "Modified by", value: p.LastModifiedUser, mono: true },
          { label: "Description", value: p.Description },
        ]),
        note: "The value is never read by the cloud map; reveal it through the service's Variables tab (audited).",
      },
      ...(p.Policies?.length ? [{ title: "Policies", table: { columns: ["Type", "Status"], rows: p.Policies.map((x) => [x.PolicyType ?? "?", x.PolicyStatus ?? "?"]) } }] : []),
      tags === undefined ? { title: "Tags", note: "Not read." } : { title: "Tags", ...(t.length ? { table: { columns: ["Key", "Value"], rows: t.map((x) => [x.Key!, x.Value ?? ""]) } } : { note: "No tags." }) },
    ],
  };
}
