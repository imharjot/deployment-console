// API Gateway provider: REST APIs (resources × methods and their integrations) and HTTP / WebSocket APIs (routes →
// integrations), stages, authorizers and custom domains. Endpoints are the default invoke domain plus custom domains
// and the regional / CloudFront names DNS points at, so Route 53 records land on the API. Edges: routes → Lambda
// (invoke), → HTTP backends (route; VPC-link listeners → their load balancer), → SQS / EventBridge / Step Functions /
// Kinesis for first-class integrations; and the support links: a custom domain's certificate (tls), Cognito
// authorizers (uses), Lambda authorizers (invoke), stage access logs (logs). Stage variable values stay on the server
// (mentions). Discovery lists (tags come with the list), hands the list to ctx.checkpoint, then reads routes, stages and
// authorizers per API through enrich() (R18). Action: redeploy a REST stage.
import "server-only";
import {
  APIGatewayClient, CreateDeploymentCommand, GetAuthorizersCommand, GetBasePathMappingsCommand, GetDomainNamesCommand, GetResourcesCommand, GetRestApisCommand,
  GetStagesCommand, GetTagsCommand, type Resource as RestResource,
} from "@aws-sdk/client-api-gateway";
import {
  ApiGatewayV2Client, GetApiMappingsCommand, GetApisCommand, GetAuthorizersCommand as GetV2AuthorizersCommand, GetDomainNamesCommand as GetV2DomainNamesCommand,
  GetIntegrationsCommand, GetRoutesCommand, GetStagesCommand as GetV2StagesCommand, GetTagsCommand as GetV2TagsCommand, type Integration as V2Integration,
  type Route as V2Route,
} from "@aws-sdk/client-apigatewayv2";
import { arnName, field, fmtTime, parseArn, propOf } from "../../inventory/serverless-common.ts";
import { APIGW_P, apiIdOf, apigwResult, isRestKey, routeRows, type RawApi, type RawApis, type RawAuthorizer, type RawDomain } from "../../inventory/serverless-apigw.ts";
import type { Resource, ResourceDetail } from "../../inventory/types.ts";
import { simApi, simApigw, simRedeploy } from "./mock/apigateway.ts";
import { budget, conflict, enrich, invalid, paged, perRegion, sdkConfig, simDelay, softly, t } from "./serverless-util.ts";
import type { ActionContext, Provider, ProviderAction, ProviderContext } from "./types.ts";

const rest = perRegion((region) => new APIGatewayClient(sdkConfig(region)), "apigateway");
const v2 = perRegion((region) => new ApiGatewayV2Client(sdkConfig(region)), "apigateway");
const DETAILS_MAX = 300; // APIs whose routes / integrations / stages / authorizers are read (4+ calls each)
const PAGE = 500;
const AUTHORITATIVE_MS = 5_000; // the live tag read before a change (R01)

// An API's region: its key is "arn:aws:apigateway:<region>::/restapis/<id>".
const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || r.region || fallback;

// Pages of an API Gateway sub-list inside one API (routes, integrations, resources), bounded.
async function all<T>(page: (token: string | undefined) => Promise<{ items?: T[]; next?: string }>, max = 2000): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const r = await page(token);
    out.push(...(r.items ?? []));
    token = r.next || undefined;
  } while (token && out.length < max);
  return out;
}

type ApiDetail = Pick<RawApi, "routes" | "stages" | "authorizers">;

// Authorizers only add links: a failed read leaves them out without losing the routes.
const optional = <T>(p: Promise<T>) => p.catch(() => undefined);

async function restApi(c: APIGatewayClient, id: string, ctx: ProviderContext): Promise<ApiDetail> {
  const [resources, stagesOut, authorizers] = await Promise.all([
    all<RestResource>(async (position) => {
      const r = await c.send(new GetResourcesCommand({ restApiId: id, embed: ["methods"], limit: PAGE, position }), t(ctx));
      return { items: r.items, next: r.position };
    }),
    c.send(new GetStagesCommand({ restApiId: id }), t(ctx)),
    optional(c.send(new GetAuthorizersCommand({ restApiId: id, limit: PAGE }), t(ctx))),
  ]);
  return {
    routes: resources.flatMap((res) => Object.entries(res.resourceMethods ?? {}).map(([method, m]) => ({
      key: `${method} ${res.path ?? "/"}`,
      integration: m.methodIntegration ? { type: m.methodIntegration.type, uri: m.methodIntegration.uri, connectionType: m.methodIntegration.connectionType } : undefined,
    }))),
    stages: (stagesOut.item ?? []).map((s) => ({ name: s.stageName ?? "?", deploymentId: s.deploymentId, lastUpdated: s.lastUpdatedDate?.getTime(), variables: s.variables, accessLog: s.accessLogSettings?.destinationArn })),
    authorizers: authorizers?.items?.map((z): RawAuthorizer => ({ name: z.name ?? z.id ?? "?", type: z.type, providerArns: z.providerARNs, uri: z.authorizerUri })),
  };
}

async function httpApi(c: ApiGatewayV2Client, ApiId: string, ctx: ProviderContext): Promise<ApiDetail> {
  const [routes, integrations, stages, authorizers] = await Promise.all([
    all<V2Route>(async (NextToken) => {
      const r = await c.send(new GetRoutesCommand({ ApiId, NextToken, MaxResults: String(PAGE) }), t(ctx));
      return { items: r.Items, next: r.NextToken };
    }),
    all<V2Integration>(async (NextToken) => {
      const r = await c.send(new GetIntegrationsCommand({ ApiId, NextToken, MaxResults: String(PAGE) }), t(ctx));
      return { items: r.Items, next: r.NextToken };
    }),
    c.send(new GetV2StagesCommand({ ApiId, MaxResults: String(PAGE) }), t(ctx)),
    optional(c.send(new GetV2AuthorizersCommand({ ApiId, MaxResults: String(PAGE) }), t(ctx))),
  ]);
  const byId = new Map(integrations.map((i) => [i.IntegrationId, i]));
  return {
    routes: routes.map((r) => {
      const i = byId.get(r.Target?.replace(/^integrations\//, ""));
      return {
        key: r.RouteKey ?? "?",
        integration: i ? { type: i.IntegrationType, uri: i.IntegrationUri, subtype: i.IntegrationSubtype, connectionType: i.ConnectionType, requestParameters: i.RequestParameters } : undefined,
      };
    }),
    stages: (stages.Items ?? []).map((s) => ({
      name: s.StageName ?? "?", deploymentId: s.DeploymentId, autoDeploy: s.AutoDeploy, lastUpdated: s.LastUpdatedDate?.getTime(), variables: s.StageVariables,
      accessLog: s.AccessLogSettings?.DestinationArn,
    })),
    authorizers: authorizers?.Items?.map((z): RawAuthorizer => ({ name: z.Name ?? z.AuthorizerId ?? "?", type: z.AuthorizerType, issuer: z.JwtConfiguration?.Issuer, uri: z.AuthorizerUri })),
  };
}

async function domains(ctx: ProviderContext, until = budget()): Promise<RawDomain[]> {
  const c1 = rest(ctx.region);
  const c2 = v2(ctx.region);
  const byName = new Map<string, RawDomain>();
  const get = (name: string) => byName.get(name) ?? (byName.set(name, { name, targets: [], mappings: [], certificates: [] }), byName.get(name)!);
  const addCert = (d: RawDomain, arn: string | undefined) => {
    if (arn && !d.certificates!.includes(arn)) d.certificates!.push(arn);
  };
  const addMapping = (d: RawDomain, m: RawDomain["mappings"][number]) => {
    if (!d.mappings.some((x) => x.apiId === m.apiId && x.stage === m.stage && x.basePath === m.basePath)) d.mappings.push(m);
  };
  const list1 = softly(ctx, "api gateway custom domains (REST)", { limited: false, service: "apigateway" });
  const list2 = softly(ctx, "api gateway custom domains", { limited: false, service: "apigateway" });
  const maps1 = softly(ctx, "api gateway base path mappings", { until, service: "apigateway" });
  const maps2 = softly(ctx, "api gateway API mappings", { until, service: "apigateway" });
  const [d1, d2] = await Promise.all([
    list1(() => all(async (position) => {
      const r = await ctx.limit(() => c1.send(new GetDomainNamesCommand({ limit: PAGE, position }), t(ctx)));
      return { items: r.items, next: r.position };
    })),
    list2(() => all(async (NextToken) => {
      const r = await ctx.limit(() => c2.send(new GetV2DomainNamesCommand({ NextToken, MaxResults: String(PAGE) }), t(ctx)));
      return { items: r.Items, next: r.NextToken };
    })),
  ]);
  await Promise.all([
    ...(d1 ?? []).filter((d) => d.domainName).map(async (d) => {
      const dom = get(d.domainName!);
      for (const x of [d.regionalDomainName, d.distributionDomainName]) if (x && !dom.targets.includes(x)) dom.targets.push(x);
      addCert(dom, d.regionalCertificateArn);
      addCert(dom, d.certificateArn);
      const m = await maps1(() => c1.send(new GetBasePathMappingsCommand({ domainName: d.domainName, limit: PAGE }), t(ctx)));
      for (const x of m?.items ?? []) if (x.restApiId) addMapping(dom, { apiId: x.restApiId, stage: x.stage, basePath: x.basePath === "(none)" ? "" : x.basePath });
    }),
    ...(d2 ?? []).filter((d) => d.DomainName).map(async (d) => {
      const dom = get(d.DomainName!);
      for (const cfg of d.DomainNameConfigurations ?? []) {
        if (cfg.ApiGatewayDomainName && !dom.targets.includes(cfg.ApiGatewayDomainName)) dom.targets.push(cfg.ApiGatewayDomainName);
        addCert(dom, cfg.CertificateArn);
      }
      const m = await maps2(() => c2.send(new GetApiMappingsCommand({ DomainName: d.DomainName, MaxResults: String(PAGE) }), t(ctx)));
      for (const x of m?.Items ?? []) if (x.ApiId) addMapping(dom, { apiId: x.ApiId, stage: x.Stage, basePath: x.ApiMappingKey ?? "" });
    }),
  ]);
  return [...byName.values()];
}

async function fetchApis(ctx: ProviderContext): Promise<RawApis> {
  const c1 = rest(ctx.region);
  const c2 = v2(ctx.region);
  // REST and HTTP/WebSocket APIs are two lists; either may be denied without losing the other.
  const [restList, httpList] = await Promise.all([
    paged(ctx, "api gateway REST APIs", async (position) => {
      const r = await c1.send(new GetRestApisCommand({ limit: PAGE, position }), t(ctx));
      return { items: r.items, next: r.position };
    }, { service: "apigateway" }),
    softly(ctx, "api gateway HTTP/WebSocket APIs", { limited: false, service: "apigateway" })(() => paged(ctx, "api gateway HTTP/WebSocket APIs", async (NextToken) => {
      const r = await c2.send(new GetApisCommand({ NextToken, MaxResults: String(PAGE) }), t(ctx));
      return { items: r.Items, next: r.NextToken };
    }, { service: "apigateway" })),
  ]);
  // The lists carry each API's tags: read, even when there are none ({}), so nothing here is tagsUnread.
  const apis: RawApi[] = [
    ...restList.filter((a) => a.id).map((a): RawApi => ({
      id: a.id!, name: a.name ?? a.id!, protocol: "REST", endpointType: a.endpointConfiguration?.types?.[0], description: a.description, createdAt: a.createdDate?.getTime(),
      disableDefaultEndpoint: a.disableExecuteApiEndpoint, tags: a.tags ?? {}, routes: [], stages: [],
    })),
    ...(httpList ?? []).filter((a) => a.ApiId).map((a): RawApi => ({
      id: a.ApiId!, name: a.Name ?? a.ApiId!, protocol: a.ProtocolType === "WEBSOCKET" ? "WEBSOCKET" : "HTTP", endpoint: a.ApiEndpoint, description: a.Description,
      createdAt: a.CreatedDate?.getTime(), disableDefaultEndpoint: a.DisableExecuteApiEndpoint, tags: a.Tags ?? {}, routes: [], stages: [],
    })),
  ];
  ctx.checkpoint?.(apigwResult({ region: ctx.region, account: ctx.accountId, apis: apis.map((a) => ({ ...a, enrichment: { routes: "skipped" } })), domains: [] }));
  const until = budget();
  const [inner, doms] = await Promise.all([
    enrich(ctx, apis, { label: "api gateway routes and stages", max: DETAILS_MAX, until }, (a) => (a.protocol === "REST" ? restApi(c1, a.id, ctx) : httpApi(c2, a.id, ctx))),
    domains(ctx, until),
  ]);
  apis.forEach((a, i) => {
    if (inner.results[i]) Object.assign(a, inner.results[i]);
    a.enrichment = { routes: inner.state[i] };
  });
  return { region: ctx.region, account: ctx.accountId, apis, domains: doms };
}

// ---------- detail ----------

function buildDetail(r: Resource, a: RawApi | undefined, doms: RawDomain[]): ResourceDetail {
  if (!a) return { key: r.key, sections: [{ title: "Not found", note: "This API no longer exists." }] };
  const mine = doms.filter((d) => d.mappings.some((m) => m.apiId === a.id));
  return {
    key: r.key,
    sections: [
      {
        title: a.protocol === "REST" ? "Methods" : "Routes",
        table: a.routes.length ? { columns: [a.protocol === "REST" ? "Method" : "Route", "Integration", "Reaches"], rows: routeRows(a) } : undefined,
        note: a.routes.length ? undefined : "No routes.",
      },
      {
        title: "Stages",
        table: a.stages.length ? {
          columns: ["Stage", "Deployment", "Auto-deploy", "Last updated", "Variables", "Access logs"],
          rows: a.stages.map((s) => [s.name, s.deploymentId ?? "", a.protocol === "REST" ? "—" : s.autoDeploy ? "yes" : "no", fmtTime(s.lastUpdated), s.variables ? Object.keys(s.variables).sort().join(", ") : "", s.accessLog ? arnName(s.accessLog.replace(/:\*$/, "")) : "off"]),
        } : undefined,
        note: a.stages.length ? "Stage variable names only — values are never shown." : "No stages — the API isn't deployed.",
      },
      {
        title: "Custom domains",
        table: mine.length ? {
          columns: ["Domain", "Path", "Stage", "DNS target", "Certificate"],
          rows: mine.flatMap((d) => d.mappings.filter((m) => m.apiId === a.id).map((m) => [d.name, `/${m.basePath ?? ""}`, m.stage ?? "", d.targets.join(", "), (d.certificates ?? []).map(arnName).join(", ")])),
        } : undefined,
        note: mine.length ? undefined : "No custom domain maps to this API.",
      },
      ...(a.authorizers?.length ? [{
        title: "Authorizers",
        table: { columns: ["Authorizer", "Type", "Checks with"], rows: a.authorizers.map((z) => [z.name, z.type ?? "?", z.providerArns?.map(arnName).join(", ") || z.issuer || arnName(/functions\/(arn:[^/]+)\/invocations/.exec(z.uri ?? "")?.[1]) || ""]) },
      }] : []),
    ],
  };
}

async function detail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  const id = apiIdOf(r.key) ?? "";
  const region = regionOf(r, ctx.region);
  if (ctx.mock) {
    const s = simApigw(region);
    return buildDetail(r, s.apis.find((a) => a.id === id), s.domains);
  }
  const scoped = { ...ctx, region };
  const base: RawApi = { id, name: r.name, protocol: isRestKey(r.key) ? "REST" : propOf(r, APIGW_P.type) === "WebSocket API" ? "WEBSOCKET" : "HTTP", routes: [], stages: [] };
  const [inner, doms] = await Promise.all([
    softly(ctx, "api gateway routes and stages")(() => (base.protocol === "REST" ? restApi(rest(region), id, scoped) : httpApi(v2(region), id, scoped))),
    domains(scoped),
  ]);
  return buildDetail(r, { ...base, ...(inner ?? {}) }, doms);
}

// ---------- action ----------

type RedeployInput = { stage: string; description?: string };

// The REST API's stages and the deployment each serves now (the undo of a redeploy points the stage back at it).
async function stagesOf(r: Resource, ctx: ActionContext): Promise<{ name: string; deploymentId?: string }[]> {
  const id = apiIdOf(r.key) ?? "";
  if (ctx.mock) return simApi(id)?.stages.map((s) => ({ name: s.name, deploymentId: s.deploymentId })) ?? [];
  const out = await rest(regionOf(r, ctx.region)).send(new GetStagesCommand({ restApiId: id }), t());
  return (out.item ?? []).filter((s) => s.stageName).map((s) => ({ name: s.stageName!, deploymentId: s.deploymentId }));
}

const redeployStage: ProviderAction<RedeployInput> = {
  id: "redeploy-stage",
  kind: "apigateway",
  title: "Redeploy a stage",
  description:
    "REST APIs only: creates a new deployment of the API's current configuration and points `stage` at it — every change made to resources, methods or integrations since the last deployment goes live on that stage. HTTP and WebSocket APIs are refused (they deploy through their stages' auto-deploy). Returns the new deployment id and the one the stage served before.",
  risk: "change",
  perm: "act",
  summary: "Deploys the REST API's current configuration to a stage.",
  iam: ["apigateway:POST"],
  undo: "Point the stage back at its previous deployment (the result names it) in the API Gateway console",
  verifies: "The stage's deployment id changes to the new one",
  retrySafe: true, // a second deployment of the same configuration serves the same API
  input: {
    type: "object",
    additionalProperties: false,
    required: ["stage"],
    properties: {
      stage: field("Stage", { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$", description: "Stage name (see the API's Stages)." }),
      description: field("Deployment description (optional)", { type: "string", maxLength: 256, description: "Deployment description." }),
    },
  },
  when: (r) => (!isRestKey(r.key) ? "only REST APIs have deployments — HTTP and WebSocket APIs use auto-deploy" : propOf(r, APIGW_P.stages) === "none" ? "the API has no stage yet" : undefined),
  async plan(r, i, ctx) {
    if (!isRestKey(r.key)) throw invalid("only REST APIs have deployments");
    const stages = await stagesOf(r, ctx);
    const stage = stages.find((s) => s.name === i.stage);
    if (!stage) throw invalid(`stage "${i.stage}" doesn't exist (stages: ${stages.map((s) => s.name).join(", ") || "none"})`);
    return {
      summary: `Deploy the current configuration of ${r.name} to stage ${i.stage}`,
      changes: [`new deployment → stage ${i.stage}${i.description ? ` ("${i.description}")` : ""}`, `replaces deployment ${stage.deploymentId ?? "(none)"} on that stage`],
      warnings: ["every change made to the API since its last deployment goes live on this stage"],
    };
  },
  async run(r, i, ctx) {
    if (!isRestKey(r.key)) throw invalid("only REST APIs have deployments");
    const id = apiIdOf(r.key) ?? "";
    if (ctx.mock) {
      await simDelay(500);
      try {
        return { api: r.name, stage: i.stage, ...simRedeploy(id, i.stage) };
      } catch (e) {
        throw conflict((e as Error).message);
      }
    }
    const previous = (await stagesOf(r, ctx)).find((s) => s.name === i.stage)?.deploymentId;
    const out = await rest(regionOf(r, ctx.region)).send(new CreateDeploymentCommand({ restApiId: id, stageName: i.stage, description: i.description }), t(undefined, 15_000));
    return { api: r.name, stage: i.stage, deploymentId: out.id, previous };
  },
};

export const apigatewayProvider: Provider = {
  id: "apigateway",
  label: "API Gateway",
  scope: "regional",
  kinds: ["apigateway"],
  covers: ["apigateway:restapis", "apigateway:apis"],
  multiRegionMock: true,
  // API Gateway's control plane is authorised by HTTP verb: every Get* call is apigateway:GET, CreateDeployment is POST.
  read: ["apigateway:GET"],
  write: ["apigateway:POST"],
  async discover(ctx) {
    return apigwResult(ctx.mock ? simApigw(ctx.region) : await fetchApis(ctx));
  },
  activity: (r) => {
    const region = regionOf(r, r.region);
    if (isRestKey(r.key)) return [{ namespace: "AWS/ApiGateway", metric: "Count", dims: { ApiName: r.name }, stat: "Sum", label: "Requests", region, required: true }];
    const id = apiIdOf(r.key) ?? "";
    return propOf(r, APIGW_P.type) === "WebSocket API"
      ? [{ namespace: "AWS/ApiGateway", metric: "MessageCount", dims: { ApiId: id }, stat: "Sum", label: "Messages", region, required: true }]
      : [{ namespace: "AWS/ApiGateway", metric: "Count", dims: { ApiId: id }, stat: "Sum", label: "Requests", region, required: true }];
  },
  detail,
  // R01: the API's tags, read live right before a change (5 s; throws when they can't be read).
  async authoritative(r, ctx) {
    if (ctx.mock) {
      const a = simApi(apiIdOf(r.key) ?? "");
      if (!a) throw invalid(`API ${r.name} not found`);
      return { tags: { ...(a.tags ?? {}) } };
    }
    const region = regionOf(r, ctx.region);
    const tags = isRestKey(r.key)
      ? (await rest(region).send(new GetTagsCommand({ resourceArn: r.key }), t(undefined, AUTHORITATIVE_MS))).tags
      : (await v2(region).send(new GetV2TagsCommand({ ResourceArn: r.key }), t(undefined, AUTHORITATIVE_MS))).Tags;
    return { tags: { ...(tags ?? {}) } };
  },
  actions: [redeployStage] as ProviderAction[],
};
