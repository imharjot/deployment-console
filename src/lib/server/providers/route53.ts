// Route 53 provider (global): hosted zones (public / private, record count, VPCs, Cloud Map-managed) and, for every
// alias / CNAME / A / AAAA record, a link from the zone to what the record points at — resolved by the inventory against
// endpoints (ALB, CloudFront, API Gateway custom domain, S3 website, Elastic Beanstalk CNAME, App Runner URL, EC2 public
// IP) and carrying the record's routing policy (weighted, failover, latency…, R15) — and NS delegations to other zones in
// the account. Health checks (CC-20) are resources of their own: health from what their checkers report (the first 50
// endpoint checks), → the hostname or IP they watch. The zone and health-check lists are handed over first; records,
// private-zone VPCs, tags and checker status follow within the time budget (R18). Activity: DNSQueries (public zones,
// us-east-1). Read only: DNS edits are out of scope for now.
import "server-only";
import {
  GetHealthCheckStatusCommand, GetHostedZoneCommand, ListHealthChecksCommand, ListHostedZonesCommand, ListResourceRecordSetsCommand, ListTagsForResourcesCommand,
  Route53Client, type HealthCheck, type ResourceRecordSet,
} from "@aws-sdk/client-route-53";
import { decodeDnsName, normHost } from "../../inventory/edge-hosts.ts";
import {
  healthCheckResource, isEndpointCheck, recordLinks, routingText, zoneIdOf, zoneKey, zoneResource, type RawHealthCheck, type RawRecord, type RawZone, type Route53Api,
} from "../../inventory/edge-dns.ts";
import type { EnrichState, Link, Resource, ResourceDetail } from "../../inventory/types.ts";
import { limitedClient } from "../aws-limiter.ts";
import { abortOf, errMsg, errName, idOf, ioOf, propOf } from "./edge-util.ts";
import { mockRoute53 } from "./mock/route53.ts";
import { budget, enrich } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const PRIVATE_CAP = 200; // private zones whose VPC associations discovery reads (1 call each)
const STATUS_CAP = 50; // endpoint health checks whose checker status discovery reads (1 call each; the route53 slot is 1)
const TAG_BATCH = 10; // ListTagsForResources takes 10 ids per call
const RECORD_BUDGET = 50_000; // records read across all zones per discovery pass (Route 53 allows 5 requests/s)
const PANEL_RECORDS = 300;

// ---- real source ----

const r53 = limitedClient(new Route53Client({ region: "us-east-1", retryMode: "adaptive", maxAttempts: 6 }), "route53", "us-east-1");

const toRecord = (r: ResourceRecordSet): RawRecord => ({
  name: decodeDnsName(r.Name ?? ""),
  type: r.Type ?? "",
  ttl: r.TTL,
  values: (r.ResourceRecords ?? []).flatMap((x) => (x.Value ? [x.Value] : [])),
  alias: r.AliasTarget?.DNSName ? { target: r.AliasTarget.DNSName, zoneId: r.AliasTarget.HostedZoneId, evaluateHealth: r.AliasTarget.EvaluateTargetHealth } : undefined,
  setId: r.SetIdentifier,
  weight: r.Weight,
  failover: r.Failover,
  latencyRegion: r.Region,
  geolocation: r.GeoLocation ? (r.GeoLocation.SubdivisionCode ? `${r.GeoLocation.CountryCode}-${r.GeoLocation.SubdivisionCode}` : r.GeoLocation.CountryCode ?? r.GeoLocation.ContinentCode ?? "*") : undefined,
  geoproximity: r.GeoProximityLocation ? (r.GeoProximityLocation.AWSRegion ?? r.GeoProximityLocation.LocalZoneGroup ?? "coordinates") : undefined,
  cidr: r.CidrRoutingConfig ? `${r.CidrRoutingConfig.CollectionId}/${r.CidrRoutingConfig.LocationName}` : undefined,
  multivalue: r.MultiValueAnswer || undefined,
  healthCheckId: r.HealthCheckId,
});

const toCheck = (h: HealthCheck): RawHealthCheck => {
  const c = h.HealthCheckConfig;
  return {
    id: h.Id ?? "", type: c?.Type ?? "UNKNOWN", fqdn: c?.FullyQualifiedDomainName, ip: c?.IPAddress, port: c?.Port, path: c?.ResourcePath,
    interval: c?.RequestInterval, failureThreshold: c?.FailureThreshold, checkerRegions: c?.Regions ?? [], inverted: c?.Inverted, disabled: c?.Disabled,
    children: c?.ChildHealthChecks, healthThreshold: c?.HealthThreshold,
    alarm: c?.AlarmIdentifier?.Name ? { name: c.AlarmIdentifier.Name, region: c.AlarmIdentifier.Region ?? "us-east-1" } : undefined,
    linkedService: h.LinkedService?.ServicePrincipal,
  };
};

const realRoute53: Route53Api = {
  async zones(io, cap) {
    const zones: RawZone[] = [];
    let marker: string | undefined, truncated = false;
    do {
      const r = await io.limit(() => r53.send(new ListHostedZonesCommand({ Marker: marker, MaxItems: 100 }), abortOf(io)));
      for (const z of r.HostedZones ?? []) {
        if (zones.length >= cap) {
          truncated = true;
          break;
        }
        if (z.Id && z.Name) {
          zones.push({
            id: zoneIdOf(z.Id), name: decodeDnsName(z.Name), private: z.Config?.PrivateZone === true, recordCount: z.ResourceRecordSetCount,
            comment: z.Config?.Comment || undefined, linkedService: z.LinkedService?.ServicePrincipal,
          });
        }
      }
      marker = r.IsTruncated ? r.NextMarker : undefined;
    } while (marker && !truncated);
    return { zones, truncated };
  },

  async zoneVpcs(zoneId, io) {
    const r = await r53.send(new GetHostedZoneCommand({ Id: zoneId }), abortOf(io));
    return (r.VPCs ?? []).flatMap((v) => (v.VPCId ? [{ id: v.VPCId, region: v.VPCRegion ?? "" }] : []));
  },

  async tags(type, ids, io) {
    const r = await r53.send(new ListTagsForResourcesCommand({ ResourceType: type, ResourceIds: ids }), abortOf(io));
    const out: Record<string, Record<string, string>> = {};
    for (const set of r.ResourceTagSets ?? []) {
      if (set.ResourceId) out[set.ResourceId] = Object.fromEntries((set.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""]).filter(([k]) => k));
    }
    return out;
  },

  async records(zoneId, io, cap) {
    const records: RawRecord[] = [];
    let start: { name?: string; type?: string; id?: string } | undefined = {};
    while (start && records.length < cap) {
      const s: { name?: string; type?: string; id?: string } = start;
      const r = await io.limit(() =>
        r53.send(new ListResourceRecordSetsCommand({
          HostedZoneId: zoneId, StartRecordName: s.name, StartRecordType: s.type as ResourceRecordSet["Type"], StartRecordIdentifier: s.id, MaxItems: 300,
        }), abortOf(io)));
      records.push(...(r.ResourceRecordSets ?? []).map(toRecord));
      start = r.IsTruncated ? { name: r.NextRecordName, type: r.NextRecordType, id: r.NextRecordIdentifier } : undefined;
    }
    return { records: records.slice(0, cap), truncated: !!start || records.length > cap };
  },

  async nameServers(zoneId, io) {
    const r = await io.limit(() => r53.send(new GetHostedZoneCommand({ Id: zoneId }), abortOf(io)));
    return r.DelegationSet?.NameServers ?? [];
  },

  async healthChecks(io, cap) {
    const checks: RawHealthCheck[] = [];
    let marker: string | undefined, truncated = false;
    do {
      const r = await io.limit(() => r53.send(new ListHealthChecksCommand({ Marker: marker, MaxItems: 1000 }), abortOf(io)));
      for (const h of r.HealthChecks ?? []) {
        if (checks.length >= cap) {
          truncated = true;
          break;
        }
        if (h.Id) checks.push(toCheck(h));
      }
      marker = r.IsTruncated ? r.NextMarker : undefined;
    } while (marker && !truncated);
    return { checks, truncated };
  },

  async healthStatus(id, io) {
    const r = await r53.send(new GetHealthCheckStatusCommand({ HealthCheckId: id }), abortOf(io));
    return (r.HealthCheckObservations ?? []).flatMap((o) => (o.StatusReport?.Status ? [o.StatusReport.Status] : []));
  },
};

const api = (mock: boolean): Route53Api => (mock ? mockRoute53 : realRoute53);
const chunks = <T,>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// Tags of zones or health checks, ten per call within the time budget; what wasn't read stays undefined (tags unread).
async function readTags(ctx: ProviderContext, a: Route53Api, type: "hostedzone" | "healthcheck", ids: string[], until: number) {
  const batches = chunks(ids, TAG_BATCH);
  const { results, state } = await enrich(ctx, batches, { label: `route53: ${type === "hostedzone" ? "zone" : "health check"} tags`, max: batches.length, until, concurrency: 1 }, (b) => a.tags(type, b, ioOf(ctx)));
  const tags = new Map<string, Record<string, string>>(), states = new Map<string, EnrichState>();
  batches.forEach((b, i) => b.forEach((id) => {
    states.set(id, state[i]);
    if (state[i] === "ok") tags.set(id, results[i]?.[id] ?? {});
  }));
  return { tags, states };
}

export const route53: Provider = {
  id: "route53",
  label: "Route 53",
  global: true,
  scope: "global",
  kinds: ["route53-zone", "health-check"],
  covers: ["route53:hostedzone", "route53:healthcheck"],
  read: [
    "route53:ListHostedZones", "route53:ListResourceRecordSets", "route53:GetHostedZone", "route53:ListTagsForResources", "route53:ListHealthChecks",
    "route53:GetHealthCheckStatus",
  ],

  async discover(ctx) {
    const a = api(ctx.mock), io = ioOf(ctx);
    const [{ zones, truncated }, hc] = await Promise.all([
      a.zones(io, ctx.cap),
      a.healthChecks(io, ctx.cap).catch((e: unknown) => {
        // Health checks are a second list: losing them must not lose the zones.
        if (ctx.signal.aborted) throw e;
        ctx.note(/AccessDenied|NotAuthorized/i.test(errName(e)) ? "route53: permission route53:ListHealthChecks is missing — health checks aren't shown" : `route53: health checks not listed: ${errMsg(e)}`);
        return { checks: [] as RawHealthCheck[], truncated: false };
      }),
    ]);
    if (truncated) ctx.note(`route53: showing the first ${ctx.cap.toLocaleString("en-US")} hosted zones`);
    if (hc.truncated) ctx.note(`route53: showing the first ${ctx.cap.toLocaleString("en-US")} health checks`);
    const checks = hc.checks;
    const links: Link[] = [];
    let zoneState = new Map<string, Record<string, EnrichState>>();
    let statuses: (string[] | undefined)[] = [];
    let statusState: (EnrichState | undefined)[] = [];
    let checkTagState = new Map<string, EnrichState>();
    const build = (): { resources: Resource[]; links: Link[]; mentions: [] } => {
      const resources: Resource[] = zones.map((z) => zoneResource(z, ctx.region, zoneState.get(z.id)));
      const hcLinks: Link[] = [];
      checks.forEach((h, i) => {
        const st: Record<string, EnrichState> = {};
        const s = statusState[i];
        if (s) st.status = s;
        if (checkTagState.has(h.id)) st.tags = checkTagState.get(h.id)!;
        const out = healthCheckResource(h, { statuses: statuses[i], state: Object.keys(st).length ? st : undefined, account: ctx.accountId });
        resources.push(out.resource);
        hcLinks.push(...out.links);
      });
      return { resources, links: [...links, ...hcLinks], mentions: [] };
    };
    // R18: both lists first.
    ctx.checkpoint?.(build());

    // Records → links. NS delegation targets: public zones only (a private zone can't be delegated to).
    const byName = new Map(zones.filter((z) => !z.private).map((z) => [normHost(z.name), zoneKey(z.id)]));
    let left = RECORD_BUDGET;
    const skipped: string[] = [];
    await Promise.all(zones.map(async (z) => {
      if (ctx.signal.aborted || left <= 0) {
        skipped.push(z.name);
        return;
      }
      const cap = Math.min(ctx.cap, left);
      left -= Math.min(cap, z.recordCount ?? cap);
      try {
        const { records, truncated: more } = await a.records(z.id, io, cap);
        if (more) ctx.note(`route53: ${z.name}: links from the first ${cap.toLocaleString("en-US")} records only`);
        links.push(...recordLinks(zoneKey(z.id), z.name, records, byName));
      } catch (e) {
        ctx.note(/AccessDenied|NotAuthorized/i.test(errName(e)) ? "route53: permission route53:ListResourceRecordSets is missing — no record links" : `route53: couldn't read records of ${z.name}: ${errMsg(e)}`);
      }
    }));
    if (skipped.length) ctx.note(`route53: records not read for ${skipped.length} zone${skipped.length === 1 ? "" : "s"} (record budget or deadline)`);
    ctx.checkpoint?.(build());

    // Enrichment within the time budget: private zones' VPCs, tags, and the first endpoint checks' checker status.
    const until = budget();
    const priv = zones.filter((z) => z.private);
    const endpointChecks = checks.filter(isEndpointCheck);
    const [vpcs, zoneTags, checkTags, status] = await Promise.all([
      enrich(ctx, priv, { label: "route53: private zone VPCs", max: PRIVATE_CAP, until, concurrency: 1 }, (z) => a.zoneVpcs(z.id, io)),
      readTags(ctx, a, "hostedzone", zones.map((z) => z.id), until),
      readTags(ctx, a, "healthcheck", checks.map((h) => h.id), until),
      enrich(ctx, endpointChecks, { label: "route53: health check status", max: STATUS_CAP, until, concurrency: 1 }, (h) => a.healthStatus(h.id, io)),
    ]);
    priv.forEach((z, i) => {
      if (vpcs.state[i] === "ok") z.vpcs = vpcs.results[i] ?? [];
    });
    zoneState = new Map(zones.map((z) => {
      const st: Record<string, EnrichState> = { tags: zoneTags.states.get(z.id) ?? "skipped" };
      const p = priv.indexOf(z);
      if (p >= 0) st.vpcs = vpcs.state[p];
      if (zoneTags.tags.has(z.id)) z.tags = zoneTags.tags.get(z.id);
      return [z.id, st];
    }));
    for (const h of checks) if (checkTags.tags.has(h.id)) h.tags = checkTags.tags.get(h.id);
    checkTagState = checkTags.states;
    statuses = checks.map((h) => {
      const i = endpointChecks.indexOf(h);
      return i >= 0 && status.state[i] === "ok" ? (status.results[i] ?? []) : undefined;
    });
    statusState = checks.map((h) => {
      const i = endpointChecks.indexOf(h);
      return i >= 0 ? status.state[i] : undefined;
    });
    return build();
  },

  // R20: public zones answer queries — DNSQueries is the usage signal.
  activity: (r) =>
    r.kind === "route53-zone" && propOf(r, "Type") === "Public"
      ? [{ namespace: "AWS/Route53", metric: "DNSQueries", dims: { HostedZoneId: idOf(r.key) }, stat: "Sum", label: "DNS queries", region: "us-east-1", required: true }]
      : [],

  async detail(r, ctx): Promise<ResourceDetail> {
    const a = api(ctx.mock), io = ioOf(ctx), id = idOf(r.key);
    if (r.kind === "health-check") {
      const statuses = await a.healthStatus(id, io).catch((e: unknown) => new Error(errMsg(e)));
      return {
        key: r.key,
        sections: [statuses instanceof Error
          ? { title: "Checkers", note: `Couldn't read the checkers' status: ${statuses.message}` }
          : { title: "Checkers", table: { columns: ["Last report"], rows: statuses.map((s) => [s.slice(0, 200)]) }, note: statuses.length ? undefined : "No checker has reported (calculated and metric checks have none)." }],
      };
    }
    const pub = propOf(r, "Type") === "Public";
    const [recs, ns] = await Promise.all([
      a.records(id, io, PANEL_RECORDS).catch((e: unknown) => new Error(errMsg(e))),
      pub ? a.nameServers(id, io).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    ]);
    const sections: ResourceDetail["sections"] = [];
    if (ns.length) sections.push({ title: "Delegation", rows: [{ label: "Name servers", value: ns.join(", "), mono: true }] });
    if (recs instanceof Error) sections.push({ title: "Records", note: `Couldn't list records: ${recs.message}` });
    else {
      sections.push({
        title: "Records",
        table: {
          columns: ["Name", "Type", "Value", "TTL", "Routing"],
          rows: recs.records.map((x) => [
            x.name, x.alias ? `${x.type} (alias)` : x.type, x.alias ? normHost(x.alias.target) : x.values.join(", ").slice(0, 300), x.ttl !== undefined ? String(x.ttl) : "",
            [routingText(x), x.setId ? `set ${x.setId}` : "", x.healthCheckId ? `health check ${x.healthCheckId.slice(0, 8)}` : ""].filter(Boolean).join(" · "),
          ]),
        },
        note: recs.truncated ? `First ${PANEL_RECORDS} records — the console shows the rest in Route 53.` : undefined,
      });
    }
    return { key: r.key, sections };
  },
};
