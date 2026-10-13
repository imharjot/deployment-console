// CloudFront provider (global): distributions with their origins linked to what serves them — S3 buckets, load
// balancers, API Gateway domains, custom hosts — each edge labelled with the path patterns that reach it; standard
// access logs → the log bucket; Lambda@Edge → functions; the ACM certificate (tls) and the WAFv2 web ACL (protects).
// The list is handed over first; tags and logging are read per distribution within the time budget (R18), and a
// distribution whose tags weren't read is marked so (R01). Activity is the Requests metric (us-east-1, Region=Global).
// One action: invalidate cached paths.
import "server-only";
import {
  CloudFrontClient, CreateInvalidationCommand, GetDistributionConfigCommand, GetInvalidationCommand, ListDistributionsCommand, ListInvalidationsCommand,
  ListTagsForResourceCommand, type CacheBehavior, type DefaultCacheBehavior, type DistributionConfig, type LoggingConfig,
} from "@aws-sdk/client-cloudfront";
import { cleanPaths, distributionResource, invalidationPathsError, type CloudFrontApi, type RawBehavior, type RawDistribution } from "../../inventory/edge-cloudfront.ts";
import type { EnrichState, Link, Resource, ResourceDetail } from "../../inventory/types.ts";
import { limitedClient } from "../aws-limiter.ts";
import { abortOf, errMsg, fmtTime, field, idOf, ioOf, once, retry, writeOpts } from "./edge-util.ts";
import { mockCloudFront } from "./mock/cloudfront.ts";
import { budget, enrich } from "./serverless-util.ts";
import type { Provider, ProviderAction, ProviderContext } from "./types.ts";

const EXTRA_CAP = 300; // distributions whose tags and logging config discovery reads (2 calls each)

// ---- real source ----

const cf = limitedClient(new CloudFrontClient({ region: "us-east-1", ...retry }), "cloudfront", "us-east-1");
const cfWrite = limitedClient(new CloudFrontClient({ region: "us-east-1", ...once }), "cloudfront", "us-east-1"); // sent once (F31)

const behavior = (pattern: string, b: CacheBehavior | DefaultCacheBehavior): RawBehavior => ({
  pattern,
  originId: b.TargetOriginId ?? "",
  viewerProtocol: b.ViewerProtocolPolicy,
  cachePolicyId: b.CachePolicyId,
  edgeLambdas: (b.LambdaFunctionAssociations?.Items ?? []).flatMap((l) => (l.LambdaFunctionARN ? [{ arn: l.LambdaFunctionARN, event: l.EventType ?? "" }] : [])),
  functions: (b.FunctionAssociations?.Items ?? []).flatMap((f) => (f.FunctionARN ? [{ arn: f.FunctionARN, event: f.EventType ?? "" }] : [])),
});

// A DistributionSummary (list) or a DistributionConfig (GetDistributionConfig) — they share these fields.
type Shape = Pick<DistributionConfig, "Aliases" | "Origins" | "OriginGroups" | "DefaultCacheBehavior" | "CacheBehaviors" | "Comment" | "PriceClass" | "Enabled" | "ViewerCertificate" | "WebACLId" | "HttpVersion" | "Staging">
  & { Id?: string; ARN?: string; DomainName?: string; Status?: string; LastModifiedTime?: Date; Logging?: LoggingConfig };

function toDistribution(s: Shape): RawDistribution {
  const cert = s.ViewerCertificate;
  return {
    id: s.Id ?? "", arn: s.ARN ?? "", domain: s.DomainName ?? "", aliases: s.Aliases?.Items ?? [], enabled: s.Enabled === true, status: s.Status ?? "unknown",
    comment: s.Comment || undefined, priceClass: s.PriceClass, webAclId: s.WebACLId || undefined, httpVersion: s.HttpVersion,
    certificate: cert?.ACMCertificateArn ?? cert?.IAMCertificateId ?? (cert?.CloudFrontDefaultCertificate ? "CloudFront default (*.cloudfront.net)" : undefined),
    staging: s.Staging || undefined,
    origins: (s.Origins?.Items ?? []).map((o) => ({
      id: o.Id ?? "", domain: o.DomainName ?? "", path: o.OriginPath || undefined,
      type: o.VpcOriginConfig?.VpcOriginId ? "vpc" : o.S3OriginConfig ? "s3" : "custom",
      protocol: o.CustomOriginConfig?.OriginProtocolPolicy, oac: !!o.OriginAccessControlId,
    })),
    originGroups: (s.OriginGroups?.Items ?? []).map((g) => ({ id: g.Id ?? "", members: (g.Members?.Items ?? []).flatMap((m) => (m.OriginId ? [m.OriginId] : [])) })),
    behaviors: [
      ...(s.DefaultCacheBehavior ? [behavior("*", s.DefaultCacheBehavior)] : []),
      ...(s.CacheBehaviors?.Items ?? []).map((b) => behavior(b.PathPattern ?? "", b)),
    ],
    logging: s.Logging?.Enabled && s.Logging.Bucket ? { bucket: s.Logging.Bucket, prefix: s.Logging.Prefix ?? "" } : undefined,
    lastModified: s.LastModifiedTime?.getTime(),
    unread: [],
  };
}

const realCloudFront: CloudFrontApi = {
  async distributions(io, cap) {
    const items: RawDistribution[] = [];
    let marker: string | undefined, truncated = false;
    do {
      const r = await io.limit(() => cf.send(new ListDistributionsCommand({ Marker: marker, MaxItems: 100 }), abortOf(io)));
      for (const s of r.DistributionList?.Items ?? []) {
        if (items.length >= cap) {
          truncated = true;
          break;
        }
        if (s.Id && s.ARN && s.DomainName) items.push(toDistribution(s));
      }
      marker = r.DistributionList?.IsTruncated ? r.DistributionList.NextMarker : undefined;
    } while (marker && !truncated);
    return { items, truncated };
  },

  async tags(arn, io) {
    const r = await cf.send(new ListTagsForResourceCommand({ Resource: arn }), abortOf(io));
    return Object.fromEntries((r.Tags?.Items ?? []).map((t) => [t.Key ?? "", t.Value ?? ""]).filter(([k]) => k));
  },

  // The summary has no logging settings: they come with the full configuration.
  async logging(id, io) {
    const log = (await cf.send(new GetDistributionConfigCommand({ Id: id }), abortOf(io))).DistributionConfig?.Logging;
    return log?.Enabled && log.Bucket ? { bucket: log.Bucket, prefix: log.Prefix ?? "" } : null;
  },

  async config(id, io) {
    const r = await io.limit(() => cf.send(new GetDistributionConfigCommand({ Id: id }), abortOf(io)));
    return r.DistributionConfig ? toDistribution({ ...r.DistributionConfig, Id: id }) : undefined;
  },

  async invalidations(id, io) {
    const r = await io.limit(() => cf.send(new ListInvalidationsCommand({ DistributionId: id, MaxItems: 10 }), abortOf(io)));
    const list = (r.InvalidationList?.Items ?? []).map((i) => ({ id: i.Id ?? "", status: i.Status ?? "", createdAt: i.CreateTime?.getTime(), paths: undefined as string[] | undefined }));
    // Paths need one call each: only for the newest five.
    await Promise.all(list.slice(0, 5).map(async (i) => {
      const g = await io.limit(() => cf.send(new GetInvalidationCommand({ DistributionId: id, Id: i.id }), abortOf(io))).catch(() => undefined);
      i.paths = g?.Invalidation?.InvalidationBatch?.Paths?.Items;
    }));
    return list;
  },

  async invalidate(id, paths, callerReference) {
    const r = await cfWrite.send(
      new CreateInvalidationCommand({ DistributionId: id, InvalidationBatch: { CallerReference: callerReference, Paths: { Quantity: paths.length, Items: paths } } }),
      writeOpts(),
    );
    return { id: r.Invalidation?.Id ?? "", status: r.Invalidation?.Status ?? "InProgress" };
  },
};

const api = (mock: boolean): CloudFrontApi => (mock ? mockCloudFront : realCloudFront);

// ---- panel ----

async function detail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  const a = api(ctx.mock), io = ioOf(ctx), id = idOf(r.key);
  const [d, invs] = await Promise.all([
    a.config(id, io).catch((e: unknown) => new Error(errMsg(e))),
    a.invalidations(id, io).catch((e: unknown) => new Error(errMsg(e))),
  ]);
  const sections: ResourceDetail["sections"] = [];
  if (d instanceof Error) sections.push({ title: "Origins", note: `Couldn't read the configuration: ${d.message}` });
  else if (d) {
    sections.push({
      title: "Origins",
      table: { columns: ["Id", "Domain", "Type", "Path"], rows: d.origins.map((o) => [o.id, o.domain, o.type === "custom" ? `custom (${o.protocol ?? "—"})` : o.oac ? "s3 (OAC)" : o.type, o.path ?? ""]) },
    });
    sections.push({
      title: "Behaviours",
      table: {
        columns: ["Path", "Origin", "Viewer protocol", "Functions"],
        rows: d.behaviors.map((b) => [b.pattern === "*" ? "default (*)" : b.pattern, b.originId, b.viewerProtocol ?? "", [...b.edgeLambdas.map((l) => `λ ${l.event}`), ...b.functions.map((f) => `${idOf(f.arn)} (${f.event})`)].join(", ")]),
      },
    });
  }
  sections.push(invs instanceof Error
    ? { title: "Invalidations", note: `Couldn't list invalidations: ${invs.message}` }
    : invs.length
      ? { title: "Invalidations", table: { columns: ["Id", "Status", "Created", "Paths"], rows: invs.map((i) => [i.id, i.status, fmtTime(i.createdAt), i.paths?.join(", ") ?? "—"]) } }
      : { title: "Invalidations", note: "No recent invalidations." });
  return { key: r.key, sections };
}

// ---- actions ----

type InvalidateInput = { paths: string[] };
const invalidate: ProviderAction<InvalidateInput> = {
  id: "invalidate",
  kind: "cloudfront",
  title: "Invalidate cached paths",
  summary: "Removes cached copies of up to 30 paths from every edge location, so the next requests fetch them from the origins.",
  description: 'Removes up to 30 paths from the distribution\'s edge caches so the next request goes to the origin. Each path starts with "/"; "*" may only end a path ("/static/*", "/*"). Returns the invalidation id.',
  risk: "change",
  perm: "act",
  iam: ["cloudfront:CreateInvalidation"],
  undo: "Nothing to undo — the caches refill from the origins as requests come in",
  verifies: "The invalidation's status reaches Completed (usually within minutes; see the panel's Invalidations)",
  retrySafe: true, // a second invalidation of the same paths leaves the caches the same
  input: {
    type: "object",
    additionalProperties: false,
    required: ["paths"],
    properties: {
      paths: field({ type: "array", title: "Paths to invalidate", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 4000 }, description: 'Paths, e.g. ["/index.html", "/static/*"].' }),
    },
  },
  async plan(r, i) {
    const err = invalidationPathsError(i.paths);
    if (err) throw new Error(err);
    const paths = cleanPaths(i.paths);
    const warnings = ["The first 1,000 invalidation paths each month are free; a wildcard path counts as one."];
    if (paths.includes("/*")) warnings.unshift("/* empties the whole cache: expect a burst of requests to the origins.");
    return { summary: `Invalidate ${paths.length} path${paths.length === 1 ? "" : "s"} on ${r.name} (${idOf(r.key)})`, changes: paths, warnings };
  },
  async run(r, i, ctx) {
    const err = invalidationPathsError(i.paths);
    if (err) throw new Error(err);
    const paths = cleanPaths(i.paths);
    const out = await api(ctx.mock).invalidate(idOf(r.key), paths, `console-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    return { distributionId: idOf(r.key), invalidationId: out.id, status: out.status, paths };
  },
};

export const cloudfront: Provider = {
  id: "cloudfront",
  label: "CloudFront",
  global: true,
  scope: "global",
  kinds: ["cloudfront"],
  covers: ["cloudfront:distribution"],
  read: ["cloudfront:ListDistributions", "cloudfront:ListTagsForResource", "cloudfront:GetDistributionConfig", "cloudfront:ListInvalidations", "cloudfront:GetInvalidation"],
  write: ["cloudfront:CreateInvalidation"],

  async discover(ctx) {
    const a = api(ctx.mock), io = ioOf(ctx);
    const { items, truncated } = await a.distributions(io, ctx.cap);
    if (truncated) ctx.note(`cloudfront: showing the first ${ctx.cap.toLocaleString("en-US")} distributions`);
    const build = (state?: (i: number) => Record<string, EnrichState>) => {
      const resources: Resource[] = [], links: Link[] = [];
      items.forEach((d, i) => {
        const out = distributionResource(d, state?.(i));
        resources.push(out.resource);
        links.push(...out.links);
      });
      return { resources, links, mentions: [] };
    };
    // R18: the list first (tags unread until the reads below fill them in).
    ctx.checkpoint?.(build());
    // Tags and the logging bucket aren't in the summary: one call each per distribution, within the time budget.
    const until = budget();
    const [tags, logging] = await Promise.all([
      enrich(ctx, items, { label: "cloudfront: tags", max: EXTRA_CAP, until }, (d) => a.tags(d.arn, io)),
      enrich(ctx, items, { label: "cloudfront: logging settings", max: EXTRA_CAP, until }, (d) => a.logging(d.id, io)),
    ]);
    items.forEach((d, i) => {
      if (tags.state[i] === "ok") d.tags = tags.results[i] ?? {};
      else d.unread.push("tags");
      if (logging.state[i] === "ok") d.logging = logging.results[i] ?? undefined;
      else d.unread.push("logging");
    });
    return build((i) => ({ tags: tags.state[i], logging: logging.state[i] }));
  },

  // R01: the distribution's tags, read live right before a write.
  async authoritative(r, ctx) {
    return { tags: await api(ctx.mock).tags(r.key) };
  },

  // R20: requests show it is used.
  activity: (r) => [{ namespace: "AWS/CloudFront", metric: "Requests", dims: { DistributionId: idOf(r.key), Region: "Global" }, stat: "Sum", label: "Requests", region: "us-east-1", required: true }],
  detail,
  actions: [invalidate] as ProviderAction[],
};
