import { test } from "node:test";
import assert from "node:assert/strict";
import { apiIdOf, apiKey, apigwResult, integrationTarget, isRestKey, routeRows, userPoolFromIssuer, type RawApi } from "./serverless-apigw.ts";

const FN = "arn:aws:lambda:us-east-1:123456789012:function:api";

test("integration targets", () => {
  assert.deepEqual(integrationTarget({ type: "AWS_PROXY", uri: FN }), { to: FN, kind: "invoke", how: "Lambda proxy" });
  assert.equal(integrationTarget({ type: "AWS_PROXY", uri: `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${FN}:live/invocations` })?.to, FN);
  assert.equal(integrationTarget({ type: "AWS_PROXY", uri: "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:1:function:${stageVariables.fn}/invocations" }), undefined);
  assert.deepEqual(integrationTarget({ type: "HTTP_PROXY", uri: "https://legacy.example.com/{proxy}" }), { to: "legacy.example.com", kind: "route", how: "HTTP proxy" });
  assert.deepEqual(integrationTarget({ type: "HTTP_PROXY", connectionType: "VPC_LINK", uri: "arn:aws:elasticloadbalancing:us-east-1:1:listener/app/shop-prod/abc/def" }), { to: "elb:shop-prod", kind: "route", how: "HTTP via VPC link (load balancer listener)" });
  assert.equal(integrationTarget({ type: "HTTP", connectionType: "VPC_LINK", uri: "http://internal-nlb-123.elb.us-east-1.amazonaws.com/x" })?.how, "HTTP integration via VPC link");
  assert.deepEqual(integrationTarget({ type: "AWS_PROXY", subtype: "SQS-SendMessage", requestParameters: { QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/jobs", MessageBody: "$request.body" } }), { to: "arn:aws:sqs:us-east-1:123456789012:jobs", kind: "writes", how: "SQS SendMessage" });
  assert.equal(integrationTarget({ type: "AWS_PROXY", subtype: "SQS-SendMessage", requestParameters: { QueueUrl: "$request.header.q" } }), undefined);
  assert.equal(integrationTarget({ type: "AWS", uri: "arn:aws:apigateway:us-east-1:sqs:path/123456789012/jobs" })?.to, "arn:aws:sqs:us-east-1:123456789012:jobs");
  assert.deepEqual(integrationTarget({ type: "AWS", uri: "arn:aws:apigateway:us-east-1:s3:path/my-bucket/{key}" }, "GET"), { to: "arn:aws:s3:::my-bucket", kind: "reads", how: "S3 integration" });
  assert.equal(integrationTarget({ type: "MOCK" }), undefined);
  assert.equal(integrationTarget(undefined), undefined);
});

test("apigwResult: endpoints (default, custom domain, its DNS target), grouped route edges, stage variables as mentions", () => {
  const http: RawApi = {
    id: "a1", name: "public", protocol: "HTTP", endpoint: "https://a1.execute-api.us-east-1.amazonaws.com",
    routes: [
      { key: "GET /a", integration: { type: "AWS_PROXY", uri: FN } },
      { key: "GET /b", integration: { type: "AWS_PROXY", uri: FN } },
      { key: "POST /c", integration: { type: "AWS_PROXY", uri: FN } },
      { key: "PUT /d", integration: { type: "AWS_PROXY", uri: FN } },
      { key: "ANY /legacy/{proxy+}", integration: { type: "HTTP_PROXY", uri: "https://old.example.com" } },
    ],
    stages: [{ name: "$default", autoDeploy: true }],
  };
  const rest: RawApi = { id: "r1", name: "partners", protocol: "REST", endpointType: "REGIONAL", routes: [{ key: "GET /health", integration: { type: "MOCK" } }], stages: [{ name: "prod", variables: { fnAlias: "partners-live" } }] };
  const r = apigwResult({ region: "us-east-1", apis: [http, rest], domains: [{ name: "api.example.com", targets: ["d-xyz.execute-api.us-east-1.amazonaws.com"], mappings: [{ apiId: "a1", stage: "$default", basePath: "" }] }] });
  const [h, p] = r.resources;
  assert.equal(h.key, "arn:aws:apigateway:us-east-1::/apis/a1");
  assert.deepEqual(h.endpoints, ["a1.execute-api.us-east-1.amazonaws.com", "api.example.com", "d-xyz.execute-api.us-east-1.amazonaws.com"]);
  assert.equal(p.endpoints![0], "r1.execute-api.us-east-1.amazonaws.com");
  assert.equal(p.props.find((x) => x.label === "Invoke URL")?.value, "https://r1.execute-api.us-east-1.amazonaws.com/prod");
  const toFn = r.links.find((l) => l.to === FN)!;
  assert.equal(toFn.label, "GET /a, GET /b, POST /c +1 more");
  assert.equal(r.links.find((l) => l.to === "old.example.com")?.kind, "route");
  assert.deepEqual(r.mentions, [{ from: "arn:aws:apigateway:us-east-1::/restapis/r1", refs: ["partners-live"], via: "stage prod variable fnAlias" }]);
  assert.ok(!JSON.stringify(r.resources).includes("partners-live"));
  assert.deepEqual(routeRows(rest), [["GET /health", "MOCK", "mock response"]]);
});

test("API keys", () => {
  assert.equal(apiKey("us-east-1", { id: "x", protocol: "REST" }), "arn:aws:apigateway:us-east-1::/restapis/x");
  assert.equal(apiIdOf("arn:aws:apigateway:us-east-1::/apis/a1"), "a1");
  assert.ok(isRestKey("arn:aws:apigateway:us-east-1::/restapis/x"));
  assert.ok(!isRestKey("arn:aws:apigateway:us-east-1::/apis/x"));
  assert.equal(apiKey("cn-north-1", { id: "x", protocol: "HTTP" }), "arn:aws-cn:apigateway:cn-north-1::/apis/x", "the region's partition");
});

test("support links (A.3): domain certificate → mapped API (tls), Cognito and Lambda authorizers, stage access logs; tags from the list", () => {
  const cert = "arn:aws:acm:us-east-1:123456789012:certificate/c-1";
  const pool = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_AbC123";
  const group = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/apigateway/public";
  const http: RawApi = {
    id: "a1", name: "public", protocol: "HTTP", tags: {}, routes: [],
    stages: [{ name: "$default", accessLog: group }],
    authorizers: [{ name: "customers", type: "JWT", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbC123" }],
  };
  const rest: RawApi = {
    id: "r1", name: "partners", protocol: "REST", routes: [], stages: [],
    authorizers: [
      { name: "pool", type: "COGNITO_USER_POOLS", providerArns: [pool] },
      { name: "token", type: "TOKEN", uri: `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${FN}:live/invocations` },
    ],
  };
  const r = apigwResult({ region: "us-east-1", account: "123456789012", apis: [http, rest], domains: [{ name: "api.example.com", targets: [], mappings: [{ apiId: "a1" }], certificates: [cert] }] });
  const h = "arn:aws:apigateway:us-east-1::/apis/a1", p = "arn:aws:apigateway:us-east-1::/restapis/r1";
  assert.deepEqual(r.links.map((l) => [l.kind, l.from, l.to, l.label]), [
    ["uses", h, pool, "authorizer customers"],
    ["logs", h, group, "access logs (stage $default)"],
    ["tls", cert, h, "api.example.com"],
    ["uses", p, pool, "authorizer pool"],
    ["invoke", p, FN, "authorizer token"],
  ]);
  assert.equal(r.resources[0].props.find((x) => x.label === "Authorizers")?.value, "customers");
  // Tags come with the list: an API listed without any is read and untagged, not unread.
  assert.deepEqual([r.resources[0].tagsUnread, r.resources[1].tagsUnread], [undefined, true]);
  assert.equal(userPoolFromIssuer("https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Xy9", undefined), undefined, "no account: no ARN");
  assert.equal(userPoolFromIssuer("https://login.example.com/oauth", "123456789012"), undefined, "not Cognito");
});

test("routes not read: the stages prop says so (never \"none\", which blocks redeploy as undeployed)", () => {
  const r = apigwResult({ region: "us-east-1", apis: [{ id: "r1", name: "partners", protocol: "REST", routes: [], stages: [], tags: {}, enrichment: { routes: "capped" } }], domains: [] });
  assert.equal(r.resources[0].props.find((x) => x.label === "Stages")?.value, "not read (capped)");
  assert.deepEqual(r.resources[0].enrichment, { routes: "capped" });
});
