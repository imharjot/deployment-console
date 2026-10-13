// API Gateway, pure part: REST APIs (resources × methods with their integrations) and HTTP / WebSocket APIs (routes →
// integrations), their stages, authorizers and custom domains → Resources and Links. Lambda proxies become `invoke`
// edges; HTTP integrations become `route` edges to the backend's host (resolved by the inventory — an ALB, CloudFront,
// or an external system); VPC-link integrations that name an ALB/NLB listener link straight to that load balancer.
// Support links (A.3): a custom domain's certificate → every API mapped to it (tls: no node carries the domain-name
// ARN), Cognito user-pool authorizers (uses) and Lambda authorizers (invoke), stage access logs (logs).
// Integration URIs built from stage variables are run-time values and are skipped (their values become mentions).
import { partitionOf } from "./arn.ts";
import {
  arnName, clip, enrichmentOf, envMentions, fmtTime, hostOf, lambdaBase, lbNameFromListener, logsLink, parseArn, props, queueArnFromUrl, tagsOf, unread,
} from "./serverless-common.ts";
import { keys, type EdgeKind, type EnrichState, type Link, type Mention, type ProviderResult, type Resource } from "./types.ts";

export interface RawIntegration {
  type?: string; // AWS_PROXY, AWS, HTTP, HTTP_PROXY, MOCK
  uri?: string;
  subtype?: string; // HTTP APIs: "SQS-SendMessage", "EventBridge-PutEvents", "StepFunctions-StartExecution"…
  connectionType?: string; // INTERNET | VPC_LINK
  requestParameters?: Record<string, string>;
}

export interface RawRoute {
  key: string; // "GET /orders", "$default", "$connect"
  integration?: RawIntegration;
}

// An authorizer as the map needs it: Cognito user pools (REST COGNITO_USER_POOLS providerARNs, or an HTTP API JWT
// issuer "https://cognito-idp.<region>.amazonaws.com/<pool id>") and Lambda authorizers (their function).
export interface RawAuthorizer {
  name: string;
  type?: string; // REST: TOKEN | REQUEST | COGNITO_USER_POOLS; HTTP: JWT | REQUEST
  providerArns?: string[];
  issuer?: string;
  uri?: string; // Lambda authorizers: "arn:aws:apigateway:r:lambda:path/2015-03-31/functions/<fn>/invocations"
}

export interface RawApi {
  id: string;
  name: string;
  protocol: "REST" | "HTTP" | "WEBSOCKET";
  endpoint?: string; // HTTP/WebSocket ApiEndpoint ("https://id.execute-api.r.amazonaws.com", "wss://…")
  endpointType?: string; // REST: REGIONAL | EDGE | PRIVATE
  description?: string;
  createdAt?: number;
  disableDefaultEndpoint?: boolean;
  tags?: Record<string, string>; // the list returns them: {} when it has none; undefined = not read
  routes: RawRoute[];
  stages: { name: string; deploymentId?: string; autoDeploy?: boolean; lastUpdated?: number; variables?: Record<string, string>; accessLog?: string }[];
  authorizers?: RawAuthorizer[];
  enrichment?: Record<string, EnrichState>; // routes (routes, stages and authorizers)
  lastActivityAt?: number;
}

export interface RawDomain {
  name: string; // "api.example.com"
  targets: string[]; // the regional / distribution domain names DNS points at ("d-abc.execute-api.r.amazonaws.com")
  mappings: { apiId: string; stage?: string; basePath?: string }[];
  certificates?: string[]; // ACM certificate ARNs (REST: certificateArn / regionalCertificateArn; HTTP: per configuration)
}

export interface RawApis {
  region: string;
  account?: string; // for user-pool ARNs from a JWT issuer URL
  apis: RawApi[];
  domains: RawDomain[];
}

export const APIGW_P = { type: "Type", stages: "Stages" } as const;

export const apiKey = (region: string, a: Pick<RawApi, "id" | "protocol">) => `arn:${partitionOf(region)}:apigateway:${region}::/${a.protocol === "REST" ? "restapis" : "apis"}/${a.id}`;
export const apiIdOf = (key: string) => /::\/(?:restapis|apis)\/([^/]+)$/.exec(key)?.[1];
export const isRestKey = (key: string) => key.includes("::/restapis/");

export function apiConsoleUrl(a: Pick<RawApi, "id" | "protocol">, region: string) {
  return a.protocol === "REST"
    ? `https://${region}.console.aws.amazon.com/apigateway/main/apis/${a.id}/resources?api=${a.id}&region=${region}`
    : `https://${region}.console.aws.amazon.com/apigateway/main/api-detail?api=${a.id}&region=${region}`;
}

const dynamic = (s: string | undefined) => !s || s.includes("${") || s.startsWith("$request") || s.startsWith("$context");

// What an integration reaches: { to, kind, how } or undefined (MOCK, dynamic, or not a resource).
export function integrationTarget(i: RawIntegration | undefined, method = ""): { to: string; kind: EdgeKind; how: string } | undefined {
  if (!i?.type || i.type === "MOCK" || (dynamic(i.uri) && !i.subtype)) return undefined;
  const uri = i.uri ?? "";
  // Lambda: a function ARN (HTTP APIs), or the REST form "arn:aws:apigateway:r:lambda:path/2015-03-31/functions/<fn>/invocations".
  const fn = /functions\/(arn:aws[\w-]*:lambda:[^/]+)\/invocations/.exec(uri)?.[1] ?? (parseArn(uri)?.service === "lambda" ? uri : undefined);
  if (fn) return { to: lambdaBase(fn), kind: "invoke", how: `Lambda ${i.type === "AWS_PROXY" ? "proxy" : "integration"}` };
  if (i.type === "HTTP" || i.type === "HTTP_PROXY") {
    const lb = lbNameFromListener(uri);
    if (lb) return { to: keys.loadBalancer(lb), kind: "route", how: "HTTP via VPC link (load balancer listener)" };
    const host = hostOf(uri);
    if (host && /^https?:\/\//.test(uri)) return { to: host, kind: "route", how: `HTTP ${i.type === "HTTP_PROXY" ? "proxy" : "integration"}${i.connectionType === "VPC_LINK" ? " via VPC link" : ""}` };
    return undefined;
  }
  // HTTP API first-class AWS integrations.
  const p = i.requestParameters ?? {};
  const fixed = (k: string) => (dynamic(p[k]) ? undefined : p[k]);
  switch (i.subtype) {
    case "SQS-SendMessage": {
      const q = fixed("QueueUrl");
      return q ? { to: queueArnFromUrl(q) ?? q, kind: "writes", how: "SQS SendMessage" } : undefined;
    }
    case "EventBridge-PutEvents": {
      const bus = fixed("EventBusName");
      return bus ? { to: bus, kind: "writes", how: "EventBridge PutEvents" } : undefined;
    }
    case "StepFunctions-StartExecution":
    case "StepFunctions-StartSyncExecution": {
      const sm = fixed("StateMachineArn");
      return sm ? { to: sm, kind: "invoke", how: i.subtype.replace("-", " ") } : undefined;
    }
    case "Kinesis-PutRecord": {
      const s = fixed("StreamName");
      return s ? { to: s, kind: "writes", how: "Kinesis PutRecord" } : undefined;
    }
  }
  // REST "AWS" service integrations with the target in the path.
  const sqs = /:apigateway:([a-z0-9-]+):sqs:path\/(\d{12})\/([\w.-]+)$/.exec(uri);
  if (sqs) return { to: `arn:aws:sqs:${sqs[1]}:${sqs[2]}:${sqs[3]}`, kind: "writes", how: "SQS integration" };
  const s3 = /:apigateway:[a-z0-9-]+:s3:path\/([a-z0-9][a-z0-9.-]+)/.exec(uri);
  if (s3) return { to: `arn:aws:s3:::${s3[1]}`, kind: /^(GET|HEAD)$/i.test(method) ? "reads" : "writes", how: "S3 integration" };
  return undefined;
}

const routeList = (routes: string[]) => (routes.length <= 3 ? routes.join(", ") : `${routes.slice(0, 3).join(", ")} +${routes.length - 3} more`);

export function invokeUrl(a: RawApi, region: string): string | undefined {
  const base = a.endpoint ?? `https://${a.id}.execute-api.${region}.amazonaws.com`;
  const stage = a.stages.find((s) => s.name === "$default") ? undefined : a.stages[0]?.name;
  return stage ? `${base}/${stage}` : base;
}

// A Cognito user pool from an HTTP API JWT issuer ("https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbC"), in
// the API's account (an issuer names no account; a pool elsewhere wouldn't resolve anyway).
export function userPoolFromIssuer(issuer: string | undefined, account: string | undefined): string | undefined {
  const m = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/([a-z0-9-]+_[A-Za-z0-9]+)\/?$/.exec(issuer ?? "");
  return m && account ? `arn:${partitionOf(m[1])}:cognito-idp:${m[1]}:${account}:userpool/${m[2]}` : undefined;
}

// A.3 links of one API: authorizers (Cognito → uses, Lambda → invoke), stage access logs, and the certificates of the
// custom domains mapped to it.
export function apiSupport(key: string, a: RawApi, domains: RawDomain[], account: string | undefined): Link[] {
  const out: Link[] = [];
  for (const z of a.authorizers ?? []) {
    const pools = [...(z.providerArns ?? []), userPoolFromIssuer(z.issuer, account)].filter((x): x is string => !!x && x.includes(":cognito-idp:"));
    for (const pool of pools) out.push({ from: key, to: pool, kind: "uses", label: `authorizer ${z.name}`, evidence: `${z.type === "JWT" ? "JWT" : "Cognito user pool"} authorizer ${z.name}` });
    const fn = /functions\/(arn:aws[\w-]*:lambda:[^/]+)\/invocations/.exec(z.uri ?? "")?.[1];
    if (fn && !fn.includes("${")) out.push({ from: key, to: lambdaBase(fn), kind: "invoke", label: `authorizer ${z.name}`, evidence: `Lambda authorizer ${z.name} (${z.type ?? "REQUEST"})` });
  }
  for (const s of a.stages) out.push(...logsLink(key, s.accessLog, `access logs (stage ${s.name})`, `stage ${s.name} access log settings (destinationArn)`));
  for (const d of domains)
    for (const cert of d.certificates ?? []) if (cert.startsWith("arn:")) out.push({ from: cert, to: key, kind: "tls", label: d.name, evidence: `custom domain ${d.name} (certificate)` });
  return out;
}

export function apigwResult(raw: RawApis): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const mentions: Mention[] = [];
  const region = raw.region;
  for (const a of raw.apis) {
    const key = apiKey(region, a);
    const domains = raw.domains.filter((d) => d.mappings.some((m) => m.apiId === a.id));
    const routesRead = (a.enrichment?.routes ?? "ok") === "ok";
    const enrichment = enrichmentOf(a.enrichment);
    const defaultHost = hostOf(a.endpoint) ?? `${a.id}.execute-api.${region}.amazonaws.com`;
    // Group routes by what they reach so one edge carries every route that goes there.
    const byTarget = new Map<string, { to: string; kind: EdgeKind; how: string; routes: string[] }>();
    for (const r of a.routes) {
      const t = integrationTarget(r.integration, r.key.split(" ")[0]);
      if (!t) continue;
      const id = `${t.to}|${t.kind}`;
      const g = byTarget.get(id) ?? { ...t, routes: [] };
      g.routes.push(r.key);
      byTarget.set(id, g);
    }
    for (const g of byTarget.values()) links.push({ from: key, to: g.to, kind: g.kind, label: clip(routeList(g.routes), 80), evidence: `${a.protocol === "REST" ? "REST" : a.protocol} API integration: ${g.how} (${clip(routeList(g.routes), 120)})` });
    links.push(...apiSupport(key, a, domains, raw.account));
    for (const s of a.stages) mentions.push(...envMentions(key, s.variables, `stage ${s.name} variable`));
    const authorizers = (a.authorizers ?? []).map((z) => z.name);
    resources.push({
      key,
      kind: "apigateway",
      provider: "apigateway",
      name: a.name,
      region,
      ...tagsOf(a.tags),
      health: "ok", // an API reports no state of its own
      healthReason: a.disableDefaultEndpoint && !domains.length ? "default endpoint disabled and no custom domain — unreachable" : undefined,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: APIGW_P.type, value: a.protocol === "REST" ? `REST API${a.endpointType ? ` (${a.endpointType.toLowerCase()})` : ""}` : a.protocol === "HTTP" ? "HTTP API" : "WebSocket API" },
        { label: "Invoke URL", value: a.disableDefaultEndpoint ? "default endpoint disabled" : invokeUrl(a, region), mono: !a.disableDefaultEndpoint },
        { label: "Custom domains", value: domains.length ? domains.map((d) => d.name).join(", ") : undefined, mono: true },
        // "none" only when the stages were read: when-conditions treat it as "nothing deployed".
        { label: APIGW_P.stages, value: !routesRead ? unread("", a.enrichment?.routes).trim() : a.stages.length ? a.stages.map((s) => s.name).join(", ") : "none" },
        { label: a.protocol === "REST" ? "Methods" : "Routes", value: routesRead ? String(a.routes.length) : undefined },
        { label: "Authorizers", value: authorizers.length ? clip(authorizers.join(", "), 120) : undefined },
        { label: "Description", value: a.description ? clip(a.description, 120) : undefined },
        { label: "Created", value: a.createdAt ? fmtTime(a.createdAt) : undefined },
      ]),
      endpoints: [...new Set([defaultHost, ...domains.flatMap((d) => [d.name, ...d.targets])])],
      aliases: [a.name, a.id],
      lastActivityAt: a.lastActivityAt,
      consoleUrl: apiConsoleUrl(a, region),
      createdAt: a.createdAt,
    });
  }
  return { resources, links, mentions };
}

// The routes table for the detail panel: route → what it reaches.
export function routeRows(a: RawApi): string[][] {
  return a.routes.map((r) => {
    const t = integrationTarget(r.integration, r.key.split(" ")[0]);
    const what = t ? (t.to.startsWith("arn:") ? `${parseArn(t.to)?.service ?? ""} ${arnName(t.to)}` : t.to) : r.integration?.type === "MOCK" ? "mock response" : r.integration ? `${r.integration.type ?? "?"} (dynamic)` : "no integration";
    return [r.key, r.integration?.type ?? "—", what];
  });
}
