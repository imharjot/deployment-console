// Simulated API Gateway of the Acme account (names from ../mock-names.ts): the public HTTP API — product and cart routes
// on the public-api Lambda, a legacy path through a VPC link to the production ALB, cart routes behind a JWT authorizer
// on the Acme customers user pool, access logs, custom domain api-public.acme.example with its certificate (the Route 53
// simulation aliases it to the domain's regional name) — and the staging partners REST API on the partners Lambda, with
// a mock health check. Only us-east-1 has APIs. redeploy-stage gives the REST stage a new deployment id.
import type { RawApis, RawApi } from "../../../inventory/serverless-apigw.ts";
import { ACCT, APIGW, COGNITO, EXISTING, LAMBDA, LOG_GROUPS, REGION } from "../mock-names.ts";
import { DAY, HOUR, simState } from "./serverless-sim.ts";

// The regional domain name API Gateway gives the custom domain (what the Route 53 alias record targets).
export const PUBLIC_DOMAIN_TARGET = "d-9x8w7v6u5t.execute-api.us-east-1.amazonaws.com";
// Not in mock-names (frozen in wave B): the custom domain's certificate and the API's access-log group, exported for
// the ACM and logs simulations to list.
export const PUBLIC_DOMAIN_CERT = { arn: `arn:aws:acm:${REGION}:${ACCT}:certificate/0acme0c1-aaaa-4bbb-8ccc-000000000005`, domain: APIGW.publicHttp.customDomain };
export const PUBLIC_API_ACCESS_LOG = "/aws/apigateway/acme-production-public-api";
const LISTENER = `${EXISTING.alb.arn.replace(":loadbalancer/", ":listener/")}/9b8a7c6d5e4f3a21`;
const restLambda = (fnArn: string) => `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${fnArn}/invocations`;

function build(): { apis: RawApi[]; domains: RawApis["domains"]; activeAgo: Record<string, number> } {
  const now = Date.now();
  const lambda = { type: "AWS_PROXY", uri: LAMBDA.apiHandler.arn };
  const partners = { type: "AWS_PROXY", uri: restLambda(LAMBDA.partnersStaging.arn) };
  return {
    apis: [
      {
        id: APIGW.publicHttp.id, name: APIGW.publicHttp.name, protocol: "HTTP", endpoint: `https://${APIGW.publicHttp.domain}`, description: "Public storefront API",
        createdAt: now - 260 * DAY, tags: { Environment: "production", Team: "shop" },
        routes: [
          { key: "GET /products", integration: lambda },
          { key: "GET /products/{id}", integration: lambda },
          { key: "POST /cart", integration: lambda },
          { key: "ANY /legacy/{proxy+}", integration: { type: "HTTP_PROXY", uri: LISTENER, connectionType: "VPC_LINK" } },
        ],
        stages: [{ name: "$default", autoDeploy: true, deploymentId: "dep4k2", lastUpdated: now - 3 * DAY, accessLog: LOG_GROUPS.arn(PUBLIC_API_ACCESS_LOG) }],
        authorizers: [{ name: "customers", type: "JWT", issuer: `https://cognito-idp.${REGION}.amazonaws.com/${COGNITO.customers.id}` }],
      },
      {
        id: APIGW.partnersRest.id, name: APIGW.partnersRest.name, protocol: "REST", endpointType: "REGIONAL", description: "Partner integrations (staging)",
        createdAt: now - 150 * DAY, tags: { Environment: "staging", Team: "partners" },
        routes: [
          { key: "GET /partners", integration: partners },
          { key: "POST /partners", integration: partners },
          { key: "GET /partners/{id}", integration: partners },
          { key: "GET /health", integration: { type: "MOCK" } },
        ],
        stages: [{ name: "staging", deploymentId: "x7y8z9", lastUpdated: now - 9 * DAY, variables: { lambdaAlias: "live" } }],
      },
    ],
    domains: [{ name: APIGW.publicHttp.customDomain, targets: [PUBLIC_DOMAIN_TARGET], mappings: [{ apiId: APIGW.publicHttp.id, stage: "$default", basePath: "" }], certificates: [PUBLIC_DOMAIN_CERT.arn] }],
    activeAgo: { [APIGW.publicHttp.id]: 15_000, [APIGW.partnersRest.id]: 3 * HOUR },
  };
}

const state = () => simState("__dcSimApigw", build);

export const simApi = (id: string) => state().apis.find((a) => a.id === id);

export function simApigw(region: string = REGION): RawApis {
  if (region !== REGION) return { region, account: ACCT, apis: [], domains: [] };
  const now = Date.now();
  const s = state();
  return {
    region: REGION,
    account: ACCT,
    apis: s.apis.map((a) => ({
      ...a, tags: { ...(a.tags ?? {}) }, routes: a.routes.map((r) => ({ ...r })), stages: a.stages.map((x) => ({ ...x, variables: x.variables ? { ...x.variables } : undefined })),
      authorizers: a.authorizers?.map((z) => ({ ...z })), lastActivityAt: now - (s.activeAgo[a.id] ?? DAY),
    })),
    domains: s.domains.map((d) => ({ ...d, targets: [...d.targets], certificates: d.certificates ? [...d.certificates] : undefined, mappings: d.mappings.map((m) => ({ ...m })) })),
  };
}

// Like CreateDeployment with a stageName: a new deployment, and the stage points at it.
export function simRedeploy(id: string, stage: string): { deploymentId: string; previous?: string } {
  const a = simApi(id);
  const st = a?.stages.find((x) => x.name === stage);
  if (!a || !st) throw Object.assign(new Error("Invalid stage identifier specified"), { name: "NotFoundException" });
  const previous = st.deploymentId;
  st.deploymentId = Math.random().toString(36).slice(2, 8);
  st.lastUpdated = Date.now();
  return { deploymentId: st.deploymentId, previous };
}
