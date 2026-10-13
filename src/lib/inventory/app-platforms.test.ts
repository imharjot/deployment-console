import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  amplifyDetail, amplifyResult, appsyncDetail, appsyncResult, branchHost, domainHosts, homeTarget, lightsailDetail, lightsailResult, openPorts, productionBranchOf, repoLabel,
  transferDetail, transferResult, type LightsailInput, type RawAmplifyApp, type RawGraphqlApi, type RawTransferServer,
} from "./app-platforms.ts";
import { classifyError } from "./schedule.ts";
import { simAmplify } from "../server/providers/mock/amplify.ts";
import { simAppsync } from "../server/providers/mock/appsync.ts";
import { simLightsail } from "../server/providers/mock/lightsail.ts";
import { simTransfer } from "../server/providers/mock/transfer.ts";

const R = "us-east-1";
const A = "123456789012";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const HOUR = 3_600_000;
const SENTINEL = "SENTINEL-apps-81d4c2";
const BASIC = "SENTINEL-basic-auth-5a0f"; // base64 user:password in real life
const SPEC = "SENTINEL-buildspec-77e1";
const ctx = { region: R, account: A, now: NOW };
const has = (v: unknown, s: string) => JSON.stringify(v).includes(s);

// ---------- Transfer Family ----------

const serverArn = (id: string) => `arn:aws:transfer:${R}:${A}:server/${id}`;
const server = (id: string, o: Partial<RawTransferServer> = {}): RawTransferServer => ({
  Arn: serverArn(id), ServerId: id, State: "ONLINE", Domain: "S3", EndpointType: "PUBLIC", IdentityProviderType: "SERVICE_MANAGED", described: true, Tags: [], users: [],
  enrichment: { describe: "ok", users: "ok" }, ...o,
});
// Golden: ListServers + DescribeServer + ListUsers. The sentinel sits in a login banner and a host key fingerprint (never
// read into anything) and in a user's session policy (not read by ListUsers, and never copied).
const SERVERS: RawTransferServer[] = [
  server("s-sftp", {
    Protocols: ["SFTP", "FTPS"], Certificate: `arn:aws:acm:${R}:${A}:certificate/c1`, SecurityPolicyName: "TransferSecurityPolicy-2024-01", LoggingRole: `arn:aws:iam::${A}:role/transfer-logs`,
    IdentityProviderType: "AWS_LAMBDA", IdentityProviderDetails: { Function: `arn:aws:lambda:${R}:${A}:function:sftp-auth`, InvocationRole: `arn:aws:iam::${A}:role/sftp-invoke` },
    Tags: [{ Key: "Name", Value: "partner-sftp" }, { Key: "transfer:customHostname", Value: "SFTP.acme.example" }, { Key: "Environment", Value: "production" }],
    UserCount: 3,
    users: [
      { UserName: "a", HomeDirectory: "/uploads/a", Role: `arn:aws:iam::${A}:role/sftp-user` },
      { UserName: "b", HomeDirectory: "/uploads/b", Role: `arn:aws:iam::${A}:role/sftp-user` },
      { UserName: "c", HomeDirectory: "/archive", Role: `arn:aws:iam::${A}:role/sftp-archive`, Policy: SENTINEL } as never,
    ],
    PreAuthenticationLoginBanner: SENTINEL, HostKeyFingerprint: SENTINEL,
  } as never),
  server("s-vpc", {
    Domain: "EFS", EndpointType: "VPC", IdentityProviderType: "API_GATEWAY", IdentityProviderDetails: { Url: `https://abc123.execute-api.${R}.amazonaws.com/prod/?token=${SENTINEL}` },
    EndpointDetails: { VpcId: "vpc-1", SubnetIds: ["subnet-1"], SecurityGroupIds: ["sg-1"], AddressAllocationIds: ["eipalloc-1"] },
    StructuredLogDestinations: [`arn:aws:logs:${R}:${A}:log-group:/sftp/structured:*`],
    users: [{ UserName: "efs-user", HomeDirectory: "/fs-0abc123/home/u" }, { UserName: "logical", HomeDirectoryType: "LOGICAL" }],
  }),
  server("s-private", { EndpointType: "VPC", EndpointDetails: { VpcId: "vpc-1" } }),
  server("s-offline", { State: "OFFLINE" }),
  server("s-starting", { State: "STARTING" }),
  server("s-failed", { State: "START_FAILED" }),
  server("s-unread", { described: false, Tags: undefined, users: undefined, EndpointType: "VPC", enrichment: { describe: "denied" } }),
];
const tr = () => transferResult(SERVERS, ctx);
const tBy = (id: string) => tr().resources.find((r) => r.key === serverArn(id))!;

test("Transfer: key is the ARN; endpoints are the server host and the custom hostname tag; the id is an alias", () => {
  const r = tBy("s-sftp");
  assert.equal(r.kind, "transfer-server");
  assert.equal(r.name, "partner-sftp");
  assert.deepEqual(r.endpoints, [`s-sftp.server.transfer.${R}.amazonaws.com`, "sftp.acme.example"]);
  assert.deepEqual(r.aliases, ["s-sftp"]);
  assert.equal(r.tags.Environment, "production");
  assert.equal(r.props.find((p) => p.label === "Protocols")?.value, "SFTP, FTPS");
  assert.equal(r.props.find((p) => p.label === "Users")?.value, "3 users");
  const v = tBy("s-vpc");
  assert.deepEqual([v.vpcId, v.subnetIds, v.securityGroups, v.name], ["vpc-1", ["subnet-1"], ["sg-1"], "s-vpc"]);
});

test("Transfer: facts.public — public endpoint, VPC with Elastic IPs; private VPC not; unread VPC unknown", () => {
  assert.deepEqual(["s-sftp", "s-vpc", "s-private", "s-unread"].map((id) => tBy(id).facts?.public), [true, true, false, undefined]);
  assert.deepEqual([tBy("s-unread").tagsUnread, tBy("s-unread").enrichment], [true, { describe: "denied" }]);
  assert.equal(tBy("s-unread").props.find((p) => p.label === "Protocols")?.value, "protocols not read (denied)");
});

test("Transfer: links — identity Lambda / API Gateway host (invoke), roles (assumes), home bucket and EFS (uses), logs, certificate (tls), EIP (route)", () => {
  const links = tr().links.map((l) => [l.from, l.to, l.kind, l.label]);
  assert.deepEqual(links.filter((l) => l[0] === serverArn("s-sftp") || l[1] === serverArn("s-sftp")), [
    [serverArn("s-sftp"), `arn:aws:lambda:${R}:${A}:function:sftp-auth`, "invoke", "identity provider"],
    [serverArn("s-sftp"), `arn:aws:iam::${A}:role/sftp-invoke`, "assumes", "identity invocation role"],
    [serverArn("s-sftp"), `arn:aws:iam::${A}:role/transfer-logs`, "assumes", "logging role"],
    [serverArn("s-sftp"), `arn:aws:logs:${R}:${A}:log-group:/aws/transfer/s-sftp`, "logs", "server logs"],
    [`arn:aws:acm:${R}:${A}:certificate/c1`, serverArn("s-sftp"), "tls", "FTPS"],
    [serverArn("s-sftp"), "arn:aws:s3:::uploads", "uses", "home directory (2 users)"],
    [serverArn("s-sftp"), "arn:aws:s3:::archive", "uses", "home directory (1 user)"],
    [serverArn("s-sftp"), `arn:aws:iam::${A}:role/sftp-user`, "assumes", "user role (2 users)"],
    [serverArn("s-sftp"), `arn:aws:iam::${A}:role/sftp-archive`, "assumes", "user role (1 user)"],
  ]);
  assert.deepEqual(links.filter((l) => l[0] === serverArn("s-vpc") || l[1] === serverArn("s-vpc")), [
    [serverArn("s-vpc"), `abc123.execute-api.${R}.amazonaws.com`, "invoke", "identity provider (API Gateway)"],
    [serverArn("s-vpc"), `arn:aws:logs:${R}:${A}:log-group:/sftp/structured`, "logs", "server logs"],
    [`arn:aws:ec2:${R}:${A}:elastic-ip/eipalloc-1`, serverArn("s-vpc"), "route", "Elastic IP"],
    [serverArn("s-vpc"), `arn:aws:elasticfilesystem:${R}:${A}:file-system/fs-0abc123`, "uses", "home directory (1 user)"],
  ]);
  assert.equal(homeTarget("/fs-0abc123/x", "S3", R, A), `arn:aws:elasticfilesystem:${R}:${A}:file-system/fs-0abc123`, "an fs- id is EFS whatever the domain says");
  assert.equal(homeTarget(undefined, "S3", R, A), undefined);
});

test("Transfer: health — ONLINE ok, STARTING warning, OFFLINE stopped, START_FAILED error", () => {
  assert.deepEqual(["s-sftp", "s-starting", "s-offline", "s-failed"].map((id) => [tBy(id).health, tBy(id).healthReason]), [
    ["ok", undefined], ["warning", "starting"], ["stopped", "offline"], ["error", "start failed"],
  ]);
});

test("Transfer: banners, fingerprints, session policies and identity-API query strings never leave the mapper", () => {
  const r = tr();
  assert.ok(!has(r, SENTINEL));
  const d = transferDetail(serverArn("s-sftp"), SERVERS[0]);
  assert.ok(!has(d, SENTINEL));
  assert.ok(!has(transferDetail(serverArn("s-vpc"), SERVERS[1]), SENTINEL));
  assert.deepEqual(d.sections[1].table?.rows[0], ["a", "/uploads/a", "sftp-user", "0"]);
  assert.equal(transferDetail(serverArn("x"), undefined).sections[0].note, "This server no longer exists.");
});

// ---------- AppSync ----------

const apiArn = (id: string) => `arn:aws:appsync:${R}:${A}:apis/${id}`;
// Golden: ListGraphqlApis + ListDataSources. The sentinel sits in an HTTP data source's authorization config, in a
// path/query of its endpoint and in an API-key-shaped field the mapper must not copy.
const APIS: RawGraphqlApi[] = [
  {
    name: "catalog", apiId: "gql1", arn: apiArn("gql1"), apiType: "GRAPHQL", visibility: "GLOBAL", authenticationType: "AMAZON_COGNITO_USER_POOLS",
    userPoolConfig: { userPoolId: `${R}_Pool1` }, additionalAuthenticationProviders: [{ authenticationType: "AWS_LAMBDA", lambdaAuthorizerConfig: { authorizerUri: `arn:aws:lambda:${R}:${A}:function:authz` } }, { authenticationType: "API_KEY" }],
    uris: { GRAPHQL: `https://gql1.appsync-api.${R}.amazonaws.com/graphql`, REALTIME: `wss://gql1.appsync-realtime-api.${R}.amazonaws.com/graphql` },
    tags: { Team: "web" }, logConfig: { fieldLogLevel: "ERROR", cloudWatchLogsRoleArn: `arn:aws:iam::${A}:role/appsync-logs` }, wafWebAclArn: `arn:aws:wafv2:${R}:${A}:regional/webacl/web/1`,
    apiKeys: [{ id: SENTINEL }],
    dataSources: [
      { name: "fn", type: "AWS_LAMBDA", lambdaConfig: { lambdaFunctionArn: `arn:aws:lambda:${R}:${A}:function:resolver` }, serviceRoleArn: `arn:aws:iam::${A}:role/ds` },
      { name: "carts", type: "AMAZON_DYNAMODB", dynamodbConfig: { tableName: "carts", awsRegion: "eu-west-1" }, serviceRoleArn: `arn:aws:iam::${A}:role/ds` },
      { name: "search", type: "AMAZON_OPENSEARCH_SERVICE", openSearchServiceConfig: { endpoint: `https://vpc-search-abc.${R}.es.amazonaws.com` } },
      { name: "db", type: "RELATIONAL_DATABASE", relationalDatabaseConfig: { rdsHttpEndpointConfig: { dbClusterIdentifier: "orders-aurora", awsSecretStoreArn: `arn:aws:secretsmanager:${R}:${A}:secret:orders-Ab12Cd` } } },
      { name: "hooks", type: "HTTP", httpConfig: { endpoint: `https://hooks.example.net/v1?key=${SENTINEL}`, authorizationConfig: { awsIamConfig: { signingServiceName: SENTINEL } } } as never },
      { name: "bus", type: "AMAZON_EVENTBRIDGE", eventBridgeConfig: { eventBusArn: `arn:aws:events:${R}:${A}:event-bus/shop` } },
      { name: "local", type: "NONE" },
    ],
    enrichment: { dataSources: "ok" },
  } as never,
  { name: "private", apiId: "gql2", arn: apiArn("gql2"), visibility: "PRIVATE", authenticationType: "AWS_IAM", tags: {}, enrichment: { dataSources: "denied" } },
];
const as = () => appsyncResult(APIS, ctx);

test("AppSync: key is the ARN; endpoints are the GRAPHQL and REALTIME hosts; public unless PRIVATE; API keys never touched", () => {
  const [a, p] = as().resources;
  assert.equal(a.kind, "appsync-api");
  assert.deepEqual(a.endpoints, [`gql1.appsync-api.${R}.amazonaws.com`, `gql1.appsync-realtime-api.${R}.amazonaws.com`]);
  assert.deepEqual([a.aliases, a.tags, a.health, a.facts?.public, p.facts?.public], [["gql1"], { Team: "web" }, "ok", true, false]);
  assert.equal(a.props.find((x) => x.label === "Authentication")?.value, "Cognito user pool, Lambda authorizer, API key");
  assert.equal(a.props.find((x) => x.label === "Data sources")?.value, "1 Lambda, 1 DynamoDB, 1 OpenSearch, 1 RDS, 1 HTTP, 1 EventBridge, 1 none (local)");
  assert.equal(p.props.find((x) => x.label === "Data sources")?.value, "data sources not read (denied)");
  assert.deepEqual(p.enrichment, { dataSources: "denied" });
});

test("AppSync: data-source links per the P2 table, plus authorizer, user pool, roles, logs and WAF", () => {
  assert.deepEqual(as().links.map((l) => [l.from === apiArn("gql1") ? "api" : l.from, l.to === apiArn("gql1") ? "api" : l.to, l.kind]), [
    ["api", `arn:aws:lambda:${R}:${A}:function:resolver`, "invoke"],
    ["api", `arn:aws:iam::${A}:role/ds`, "assumes"],
    ["api", `arn:aws:dynamodb:eu-west-1:${A}:table/carts`, "uses"],
    ["api", `arn:aws:iam::${A}:role/ds`, "assumes"],
    ["api", `vpc-search-abc.${R}.es.amazonaws.com`, "uses"],
    ["api", `arn:aws:rds:${R}:${A}:cluster:orders-aurora`, "sql"],
    ["api", `arn:aws:secretsmanager:${R}:${A}:secret:orders-Ab12Cd`, "reads"],
    ["api", "hooks.example.net", "http"],
    ["api", `arn:aws:events:${R}:${A}:event-bus/shop`, "event"],
    ["api", `arn:aws:cognito-idp:${R}:${A}:userpool/${R}_Pool1`, "uses"],
    ["api", `arn:aws:lambda:${R}:${A}:function:authz`, "invoke"],
    ["api", `arn:aws:iam::${A}:role/appsync-logs`, "assumes"],
    ["api", `arn:aws:logs:${R}:${A}:log-group:/aws/appsync/apis/gql1`, "logs"],
    [`arn:aws:wafv2:${R}:${A}:regional/webacl/web/1`, "api", "protects"],
  ]);
});

test("AppSync: secrets — HTTP auth config, endpoint query and API keys never appear; detail shows hosts only", () => {
  assert.ok(!has(as(), SENTINEL));
  const d = appsyncDetail(apiArn("gql1"), APIS[0]);
  assert.ok(!has(d, SENTINEL));
  assert.deepEqual(d.sections[1].table?.rows.find((r) => r[0] === "hooks"), ["hooks", "HTTP", "hooks.example.net", "—"]);
  assert.equal(d.sections[0].note, "API keys are never read.");
  assert.equal(appsyncDetail(apiArn("x"), undefined).sections[0].note, "This API no longer exists.");
});

// ---------- Amplify Hosting ----------

const appArn = (id: string) => `arn:aws:amplify:${R}:${A}:apps/${id}`;
const t = (ms: number) => new Date(NOW - ms);
// Golden: ListApps + ListBranches + ListDomainAssociations + ListJobs. Basic-auth credentials and build specs carry
// sentinels in the app, its auto-branch template and a branch; env values carry another (mentions only).
const site = (o: Partial<RawAmplifyApp> = {}): RawAmplifyApp => ({
  appId: "d1site", appArn: appArn("d1site"), name: "site", platform: "WEB", repository: `https://x-token:${SENTINEL}@github.com/acme/site.git?ref=${SENTINEL}`, defaultDomain: "d1site.amplifyapp.com",
  tags: { Team: "web" }, iamServiceRoleArn: `arn:aws:iam::${A}:role/amplify-svc`, environmentVariables: { API_URL: "https://api.acme.example", TOKEN: SENTINEL },
  autoBranchCreationConfig: { environmentVariables: { PREVIEW_DB: "acme-preview-db" }, basicAuthCredentials: BASIC, buildSpec: SPEC } as never,
  enableBasicAuth: true, basicAuthCredentials: BASIC, buildSpec: SPEC,
  productionBranch: { branchName: "main", status: "SUCCEED", lastDeployTime: t(5 * HOUR) },
  wafConfiguration: { webAclArn: `arn:aws:wafv2:${R}:${A}:regional/webacl/site/2` },
  branches: [
    { branchName: "main", displayName: "main", stage: "PRODUCTION", environmentVariables: { DB_HOST: `db.internal:${SENTINEL}` }, backend: { stackArn: `arn:aws:cloudformation:${R}:${A}:stack/amplify-site/1` } },
    { branchName: "feature/login", displayName: "feature-login", stage: "DEVELOPMENT", basicAuthCredentials: BASIC, buildSpec: SPEC, enableBasicAuth: true, customDomains: ["login.acme.example"] } as never,
  ],
  domains: [{ domainName: "acme.example", domainStatus: "AVAILABLE", subDomains: [{ subDomainSetting: { prefix: "www", branchName: "main" } }, { subDomainSetting: { prefix: "", branchName: "main" } }], certificate: { type: "CUSTOM", customCertificateArn: `arn:aws:acm:us-east-1:${A}:certificate/c9` } }],
  jobs: { main: { jobId: "9", status: "SUCCEED", startTime: t(5 * HOUR), endTime: t(4 * HOUR) }, "feature/login": { jobId: "3", status: "RUNNING", startTime: t(HOUR) } },
  enrichment: { branches: "ok", domains: "ok", jobs: "ok" },
  ...o,
} as RawAmplifyApp);
const am = (o: Partial<RawAmplifyApp> = {}) => amplifyResult([site(o)], ctx);

test("Amplify: key is the ARN; endpoints are <branch display name>.<default domain> and every custom host; repository without user info", () => {
  const r = am().resources[0];
  assert.equal(r.kind, "amplify-app");
  assert.deepEqual(r.endpoints, ["main.d1site.amplifyapp.com", "feature-login.d1site.amplifyapp.com", "www.acme.example", "acme.example", "login.acme.example"]);
  assert.deepEqual([r.aliases, r.tags, r.health], [["d1site"], { Team: "web" }, "ok"]);
  assert.equal(r.props.find((p) => p.label === "Repository")?.value, "github.com/acme/site.git");
  assert.equal(r.props.find((p) => p.label === "Basic auth")?.value, "on");
  assert.equal(r.lastActivityAt, NOW - HOUR, "the newest job: a running build on the feature branch");
  assert.equal(branchHost({ branchName: "feat/x_y" }, "D.amplifyapp.com"), "feat-x-y.d.amplifyapp.com");
  assert.deepEqual(domainHosts({ domainName: "a.example", subDomains: [{ subDomainSetting: { prefix: "" } }] }), ["a.example"]);
  assert.equal(repoLabel("not a url"), undefined);
});

test("Amplify: links — service role (assumes), WAF (protects), custom certificate (tls), backend stack (uses)", () => {
  assert.deepEqual(am().links.map((l) => [l.from, l.to, l.kind]), [
    [appArn("d1site"), `arn:aws:iam::${A}:role/amplify-svc`, "assumes"],
    [`arn:aws:wafv2:${R}:${A}:regional/webacl/site/2`, appArn("d1site"), "protects"],
    [`arn:aws:acm:us-east-1:${A}:certificate/c9`, appArn("d1site"), "tls"],
    [appArn("d1site"), `arn:aws:cloudformation:${R}:${A}:stack/amplify-site/1`, "uses"],
  ]);
});

test("Amplify: environment variables of the app, the auto-branch template and branches become mentions only", () => {
  const m = am().mentions;
  assert.deepEqual(m.map((x) => x.via), ["app env API_URL", "app env TOKEN", "auto-branch env PREVIEW_DB", "branch main env DB_HOST"]);
  const r = am().resources[0];
  assert.ok(!has({ r, links: am().links }, SENTINEL), "values only in mention refs");
  assert.ok(m.some((x) => x.refs.includes(SENTINEL)));
});

test("Amplify: basic-auth credentials and build specs from ListApps AND ListBranches appear nowhere — not even in mentions", () => {
  const out = am();
  assert.ok(!has(out, BASIC));
  assert.ok(!has(out, SPEC));
  const d = amplifyDetail(appArn("d1site"), site());
  assert.ok(!has(d, BASIC) && !has(d, SPEC) && !has(d, SENTINEL));
});

test("Amplify: health — production build failed error; another branch failed warning; domain failed / pending warning; no branches stopped", () => {
  const h = (o: Partial<RawAmplifyApp>) => { const r = am(o).resources[0]; return [r.health, r.healthReason]; };
  assert.deepEqual(h({ jobs: { main: { status: "FAILED", endTime: t(HOUR) } } }), ["error", "last build of main failed (2026-10-05 11:00 UTC)"]);
  assert.deepEqual(h({ jobs: { main: { status: "SUCCEED" }, "feature/login": { status: "FAILED" } } }), ["warning", "last build failed on branch feature/login"]);
  assert.deepEqual(h({ domains: [{ domainName: "acme.example", domainStatus: "PENDING_VERIFICATION" }, { domainName: "b.example", domainStatus: "FAILED", statusReason: "CNAME conflict" }] }),
    ["warning", "domain acme.example waits for verification; domain b.example failed: CNAME conflict"]);
  assert.deepEqual(h({ jobs: undefined, productionBranch: { branchName: "main", status: "FAILED" } }), ["error", "last deploy of main failed"]);
  assert.deepEqual(h({ branches: [], jobs: {}, productionBranch: undefined }), ["stopped", "no branches connected"]);
  assert.equal(productionBranchOf({ branches: [{ branchName: "dev" }, { branchName: "prod", stage: "PRODUCTION" }] }), "prod");
});

test("Amplify: nothing beyond ListApps read — endpoints from the production branch, states say what wasn't read", () => {
  const r = am({ branches: undefined, domains: undefined, jobs: undefined, enrichment: { branches: "skipped", domains: "skipped", jobs: "skipped" } }).resources[0];
  assert.deepEqual(r.endpoints, ["main.d1site.amplifyapp.com"]);
  assert.equal(r.props.find((p) => p.label === "Branches")?.value, "branches not read (skipped)");
  assert.equal(r.lastActivityAt, NOW - 5 * HOUR, "the last production deploy");
  assert.deepEqual(r.enrichment, { branches: "skipped", domains: "skipped", jobs: "skipped" });
});

// ---------- Lightsail ----------

const ls = (t: string, id: string) => `arn:aws:lightsail:${R}:${A}:${t}/${id}`;
// Golden: GetInstances + GetContainerServices + GetRelationalDatabases. Container env values hold a sentinel (mentions
// only); a command and a pending master password hold others the mapper must not copy.
const LS: LightsailInput = {
  instances: [
    { name: "blog", arn: ls("Instance", "i1"), tags: [{ key: "Team", value: "web" }], blueprintName: "WordPress", bundleId: "small_3_0", isStaticIp: true, publicIpAddress: "203.0.113.9", privateIpAddress: "172.26.0.9",
      state: { name: "running" }, networking: { ports: [{ fromPort: 22, toPort: 22, protocol: "tcp", cidrs: ["0.0.0.0/0"] }, { fromPort: 3306, toPort: 3306, protocol: "tcp", cidrs: ["10.0.0.0/8"] }, { fromPort: 8000, toPort: 8100, protocol: "tcp", ipv6Cidrs: ["::/0"] }] } },
    { name: "old", arn: ls("Instance", "i2"), privateIpAddress: "172.26.0.10", state: { name: "stopped" } },
    { name: "booting", arn: ls("Instance", "i3"), state: { name: "pending" } },
  ],
  containers: [
    {
      containerServiceName: "status", arn: ls("ContainerService", "c1"), state: "RUNNING", power: "nano", scale: 2, url: `https://status.abc.${R}.cs.amazonlightsail.com/`,
      publicDomainNames: { cert: ["status.acme.example"] }, privateDomainName: "status.service.local",
      currentDeployment: { version: 3, state: "ACTIVE", publicEndpoint: { containerName: "web", containerPort: 8080 },
        containers: { web: { image: `${A}.dkr.ecr.${R}.amazonaws.com/acme/status:1`, environment: { DB_URL: `mysql://u:${SENTINEL}@db`, LEVEL: "info" }, command: [SENTINEL], ports: { "8080": "HTTP" } } as never } },
    },
    { containerServiceName: "deploying", arn: ls("ContainerService", "c2"), state: "DEPLOYING", stateDetail: { code: "ACTIVATING_DEPLOYMENT" } },
    { containerServiceName: "empty", arn: ls("ContainerService", "c3"), state: "READY" },
    { containerServiceName: "off", arn: ls("ContainerService", "c4"), state: "DISABLED", isDisabled: true },
  ],
  databases: [
    { name: "wpdb", arn: ls("RelationalDatabase", "d1"), engine: "mysql", engineVersion: "8.0", state: "available", publiclyAccessible: false, backupRetentionEnabled: true,
      masterEndpoint: { address: `LS-ABC.c0.${R}.rds.amazonaws.com`, port: 3306 }, masterUsername: SENTINEL, pendingModifiedValues: { masterUserPassword: SENTINEL } } as never,
    { name: "full", arn: ls("RelationalDatabase", "d2"), state: "storage-full" },
    { name: "busy", arn: ls("RelationalDatabase", "d3"), state: "backing-up" },
    { name: "parked", arn: ls("RelationalDatabase", "d4"), state: "stopped" },
  ],
};
const lr = () => lightsailResult(LS, ctx);
const lBy = (key: string) => lr().resources.find((r) => r.key === key)!;

test("Lightsail: instances — IPs as endpoints, public from a public IP, ports open to anyone, health by state", () => {
  const b = lBy(ls("Instance", "i1"));
  assert.deepEqual([b.kind, b.name, b.endpoints, b.facts?.public, b.tags], ["lightsail-instance", "blog", ["203.0.113.9", "172.26.0.9"], true, { Team: "web" }]);
  assert.equal(b.props.find((p) => p.label === "Open to anyone")?.value, "22/tcp, 8000-8100/tcp");
  assert.deepEqual(openPorts({ networking: { ports: [{ protocol: "all", cidrs: ["0.0.0.0/0"] }] } }), ["all"]);
  assert.deepEqual([ls("Instance", "i1"), ls("Instance", "i2"), ls("Instance", "i3")].map((k) => lBy(k).health), ["ok", "stopped", "warning"]);
  assert.equal(lBy(ls("Instance", "i2")).facts?.public, false);
});

test("Lightsail: container services — URL and domains as endpoints, ECR image (pulls), env as mentions only; health by state", () => {
  const c = lBy(ls("ContainerService", "c1"));
  assert.deepEqual(c.endpoints, [`status.abc.${R}.cs.amazonlightsail.com`, "status.acme.example", "status.service.local"]);
  assert.equal(c.props.find((p) => p.label === "Containers")?.value, `web (${A}.dkr.ecr.${R}.amazonaws.com/acme/status:1)`);
  assert.deepEqual(lr().links.map((l) => [l.from, l.to, l.kind]), [[ls("ContainerService", "c1"), `arn:aws:ecr:${R}:${A}:repository/acme/status`, "pulls"]]);
  assert.deepEqual(lr().mentions.map((m) => m.via), ["container web env DB_URL", "container web env LEVEL"]);
  assert.deepEqual(["c1", "c2", "c3", "c4"].map((id) => [lBy(ls("ContainerService", id)).health, lBy(ls("ContainerService", id)).healthReason]), [
    ["ok", undefined], ["warning", "deploying: activating deployment"], ["stopped", "nothing deployed"], ["stopped", "disabled"],
  ]);
});

test("Lightsail: databases — endpoint host, public fact, health; never the master user or a pending password", () => {
  const d = lBy(ls("RelationalDatabase", "d1"));
  assert.deepEqual([d.kind, d.endpoints, d.facts?.public], ["lightsail-database", [`ls-abc.c0.${R}.rds.amazonaws.com`], false]);
  assert.deepEqual(["d1", "d2", "d3", "d4"].map((id) => lBy(ls("RelationalDatabase", id)).health), ["ok", "error", "warning", "stopped"]);
  const visible = { resources: lr().resources, links: lr().links, vias: lr().mentions.map((m) => m.via) };
  assert.ok(!has(visible, SENTINEL));
  for (const [key, kind] of [[ls("Instance", "i1"), "lightsail-instance"], [ls("ContainerService", "c1"), "lightsail-container"], [ls("RelationalDatabase", "d1"), "lightsail-database"]])
    assert.ok(!has(lightsailDetail(key, kind, LS), SENTINEL), kind);
  assert.equal(lightsailDetail(ls("Instance", "nope"), "lightsail-instance", LS).sections[0].note, "This instance no longer exists.");
});

// ---------- Acme mocks ----------

test("Acme mocks: SFTP into the uploads bucket, the catalog GraphQL API on the carts table, the marketing site, the blog; us-east-1 only", () => {
  const sftp = transferResult(simTransfer(R), ctx);
  assert.deepEqual(sftp.resources.map((r) => [r.name, r.health, r.endpoints]), [["acme-partner-sftp", "ok", [`s-0acme0sftp000000001.server.transfer.${R}.amazonaws.com`, "sftp.acme.example"]]]);
  assert.ok(sftp.links.some((l) => l.to === "arn:aws:s3:::acme-production-uploads" && l.kind === "uses"));
  const gql = appsyncResult(simAppsync(R), ctx);
  assert.equal(gql.resources[0].name, "acme-catalog-graphql");
  assert.ok(gql.links.some((l) => l.to === `arn:aws:dynamodb:${R}:${A}:table/acme-production-carts`));
  assert.ok(gql.links.some((l) => l.to.endsWith(":userpool/us-east-1_AcMe12345")));
  const site = amplifyResult(simAmplify(R, NOW), ctx);
  assert.deepEqual([site.resources[0].name, site.resources[0].health, site.resources[0].healthReason], ["acme-marketing-site", "warning", "last build failed on branch preview"]);
  assert.ok(site.resources[0].endpoints?.includes("main.d0acme0mkt0site.amplifyapp.com"));
  assert.ok(site.resources[0].endpoints?.includes("marketing.acme.example"));
  const blog = lightsailResult(simLightsail(R, NOW), ctx);
  assert.deepEqual(blog.resources.map((r) => [r.kind, r.name, r.health]), [["lightsail-instance", "acme-wordpress", "ok"], ["lightsail-container", "acme-status-page", "ok"], ["lightsail-database", "acme-wp-db", "ok"]]);
  for (const region of ["eu-west-1", "ap-south-1"]) {
    assert.deepEqual([simTransfer(region), simAppsync(region), simAmplify(region, NOW)], [[], [], []]);
    assert.deepEqual(simLightsail(region, NOW), { instances: [], containers: [], databases: [] });
  }
});

// ---------- the providers' real-account path, with the SDK faked (server modules: child process, react-server) ----------

// Runs `body` in a child process after replacing `send` on the named SDK clients' prototypes with `fakes` (a JS
// object literal: command name → async (input, n) => output, n = the call's index for that command). `provider(path)`
// imports a provider module; `ctx()` is a real-account ProviderContext that records notes and checkpoints.
function withFakeAws<T>(clients: Record<string, string>, fakes: string, body: string): T {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const base = new URL("../server/providers/", import.meta.url).href;
  const patch = Object.entries(clients).map(([pkg, cls]) => `(await import("@aws-sdk/${pkg}")).${cls}.prototype.send = send;`).join("\n");
  const code = `
    const calls = []; const counts = {}; const fakes = ${fakes};
    const send = async function (cmd) { const n = cmd.constructor.name; counts[n] = (counts[n] ?? 0) + 1; calls.push([n, cmd.input]);
      if (!Object.hasOwn(fakes, n)) throw new Error("unexpected " + n); return fakes[n](cmd.input, counts[n] - 1); };
    const denied = (action) => Object.assign(new Error("User: u is not authorized to perform: " + action + " on resource: x"), { name: "AccessDeniedException" });
    const gone = () => Object.assign(new Error("not found"), { name: "NotFoundException" });
    ${patch}
    const provider = (p) => import(new URL(p, ${JSON.stringify(base)}).href);
    const notes = [], checkpoints = [];
    const ctx = () => ({ region: "ap-south-1", accountId: "123456789012", mock: false, cap: 2000, signal: AbortSignal.timeout(20000), limit: (fn) => fn(), note: (m) => notes.push(m), checkpoint: (r) => checkpoints.push(r) });
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify({ ...out, calls, notes, checkpoints }), () => process.exit(0));`;
  const r = spawnSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", code], {
    cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:" },
  });
  assert.equal(r.status, 0, `child failed:\n${r.stderr?.slice(-3000)}`);
  return JSON.parse(r.stdout) as T;
}

interface Run {
  resources: { key: string; name: string; health: string; healthReason?: string; tags: Record<string, string>; tagsUnread?: boolean; enrichment?: Record<string, string>; endpoints?: string[]; props: { label: string; value: string }[] }[];
  links: { from: string; to: string; kind: string }[]; mentions: { via: string; refs: string[] }[]; calls: [string, Record<string, unknown>][]; notes: string[]; checkpoints: unknown[];
  activity?: unknown; detail?: { sections: { title: string; note?: string; table?: { rows: string[][] } }[] }; error?: { name: string; message: string; skipped?: string };
}

test("Transfer provider (faked AWS): ListServers, checkpoint, DescribeServer + ListUsers per server; BytesIn/BytesOut required activity", () => {
  const out = withFakeAws<Run>(
    { "client-transfer": "TransferClient" },
    `{
      ListServersCommand: async () => ({ Servers: [
        { Arn: "arn:aws:transfer:ap-south-1:123456789012:server/s-1", ServerId: "s-1", State: "ONLINE", EndpointType: "PUBLIC", Domain: "S3", UserCount: 1 },
        { Arn: "arn:aws:transfer:ap-south-1:123456789012:server/s-2", ServerId: "s-2", State: "ONLINE", EndpointType: "VPC", Domain: "S3" },
      ] }),
      DescribeServerCommand: async (input) => {
        if (input.ServerId === "s-2") throw denied("transfer:DescribeServer");
        return { Server: { Arn: "arn:aws:transfer:ap-south-1:123456789012:server/s-1", ServerId: "s-1", State: "ONLINE", EndpointType: "PUBLIC", Domain: "S3", Protocols: ["SFTP"],
          Tags: [{ Key: "transfer:customHostname", Value: "sftp.acme.example" }], PreAuthenticationLoginBanner: "${SENTINEL}", HostKeyFingerprint: "${SENTINEL}" } };
      },
      ListUsersCommand: async (input) => input.ServerId === "s-1" ? { ServerId: "s-1", Users: [{ Arn: "u", UserName: "p", HomeDirectory: "/drop/p", Role: "arn:aws:iam::123456789012:role/r" }] } : { Users: [] },
    }`,
    `const { transferProvider } = await provider("transfer.ts"); const r = await transferProvider.discover(ctx()); return { ...r, activity: transferProvider.activity(r.resources[0]) };`,
  );
  assert.deepEqual(out.calls.map((c) => c[0]).sort(), ["DescribeServerCommand", "DescribeServerCommand", "ListServersCommand", "ListUsersCommand", "ListUsersCommand"]);
  assert.equal(out.calls[0][1].MaxResults, 1000);
  assert.equal(out.checkpoints.length, 1);
  const [a, b] = out.resources;
  assert.deepEqual([a.endpoints, a.tagsUnread, a.enrichment], [["s-1.server.transfer.ap-south-1.amazonaws.com", "sftp.acme.example"], undefined, { describe: "ok", users: "ok" }]);
  assert.deepEqual([b.tagsUnread, b.enrichment], [true, { describe: "denied" }]);
  assert.ok(out.links.some((l) => l.to === "arn:aws:s3:::drop" && l.kind === "uses"));
  assert.deepEqual(out.notes, ["transfer server details skipped: transfer:DescribeServer denied"]);
  assert.deepEqual(out.activity, [
    { namespace: "AWS/Transfer", metric: "BytesIn", dims: { ServerId: "s-1" }, stat: "Sum", label: "Bytes in", region: "ap-south-1", required: true },
    { namespace: "AWS/Transfer", metric: "BytesOut", dims: { ServerId: "s-1" }, stat: "Sum", label: "Bytes out", region: "ap-south-1", required: true },
  ]);
  assert.ok(!has(out, SENTINEL));
});

test("AppSync provider (faked AWS): ListGraphqlApis (25), checkpoint, ListDataSources per API — and never ListApiKeys", () => {
  const out = withFakeAws<Run>(
    { "client-appsync": "AppSyncClient" },
    `{
      ListGraphqlApisCommand: async (input, n) => n === 0
        ? { graphqlApis: [{ name: "a", apiId: "g1", arn: "arn:aws:appsync:ap-south-1:123456789012:apis/g1", uris: { GRAPHQL: "https://g1.appsync-api.ap-south-1.amazonaws.com/graphql" }, tags: { Team: "x" }, ownerContact: "${SENTINEL}" }], nextToken: "t" }
        : { graphqlApis: [{ name: "b", apiId: "g2", arn: "arn:aws:appsync:ap-south-1:123456789012:apis/g2" }] },
      ListDataSourcesCommand: async (input, n) => {
        if (input.apiId === "g2") throw denied("appsync:ListDataSources");
        return n === 0 ? { dataSources: [{ name: "fn", type: "AWS_LAMBDA", lambdaConfig: { lambdaFunctionArn: "arn:aws:lambda:ap-south-1:123456789012:function:f" } }], nextToken: "more" }
          : { dataSources: [{ name: "h", type: "HTTP", httpConfig: { endpoint: "https://hooks.example.net/x?k=${SENTINEL}", authorizationConfig: { authorizationType: "AWS_IAM", awsIamConfig: { signingRegion: "${SENTINEL}" } } } }] };
      },
    }`,
    `const { appsyncProvider } = await provider("appsync.ts"); return await appsyncProvider.discover(ctx());`,
  );
  assert.ok(!out.calls.some((c) => c[0] === "ListApiKeysCommand"));
  assert.deepEqual(out.calls.filter((c) => c[0] === "ListGraphqlApisCommand").map((c) => [c[1].maxResults, c[1].nextToken]), [[25, undefined], [25, "t"]]);
  const sources = out.calls.filter((c) => c[0] === "ListDataSourcesCommand").map((c) => `${c[1].apiId} ${c[1].maxResults} ${c[1].nextToken ?? "-"}`).sort();
  assert.deepEqual(sources, ["g1 25 -", "g1 25 more", "g2 25 -"], "every page of every API, 25 at a time");
  assert.equal(out.checkpoints.length, 1);
  assert.deepEqual(out.resources.map((r) => [r.name, r.enrichment, r.tags]), [["a", { dataSources: "ok" }, { Team: "x" }], ["b", { dataSources: "denied" }, {}]]);
  assert.deepEqual(out.links.map((l) => [l.to, l.kind]), [["arn:aws:lambda:ap-south-1:123456789012:function:f", "invoke"], ["hooks.example.net", "http"]]);
  assert.ok(!has(out, SENTINEL));
});

test("Amplify provider (faked AWS): basic auth and build specs from ListApps AND ListBranches never leave the provider; latest job per branch", () => {
  const out = withFakeAws<Run>(
    { "client-amplify": "AmplifyClient" },
    `{
      ListAppsCommand: async () => ({ apps: [{ appId: "d1", appArn: "arn:aws:amplify:ap-south-1:123456789012:apps/d1", name: "site", defaultDomain: "d1.amplifyapp.com", platform: "WEB",
        repository: "https://github.com/acme/site", tags: {}, environmentVariables: { API: "https://api.acme.example" }, enableBasicAuth: true, basicAuthCredentials: "${BASIC}", buildSpec: "${SPEC}",
        autoBranchCreationConfig: { basicAuthCredentials: "${BASIC}", buildSpec: "${SPEC}", environmentVariables: { X: "acme-x" } }, productionBranch: { branchName: "main", status: "SUCCEED" } }] }),
      ListBranchesCommand: async () => ({ branches: [
        { branchName: "main", displayName: "main", stage: "PRODUCTION", basicAuthCredentials: "${BASIC}", buildSpec: "${SPEC}", environmentVariables: { DB: "acme-db" }, updateTime: new Date(1000) },
        { branchName: "dev", displayName: "dev", stage: "DEVELOPMENT", basicAuthCredentials: "${BASIC}", updateTime: new Date(2000) },
      ] }),
      ListDomainAssociationsCommand: async () => ({ domainAssociations: [{ domainName: "acme.example", domainStatus: "PENDING_VERIFICATION", subDomains: [{ subDomainSetting: { prefix: "www", branchName: "main" }, verified: false, dnsRecord: "www CNAME x" }],
        certificateVerificationDNSRecord: "_x.acme.example CNAME y" }] }),
      ListJobsCommand: async (input) => ({ jobSummaries: [{ jobId: "1", status: input.branchName === "dev" ? "FAILED" : "SUCCEED", startTime: new Date(5000), endTime: new Date(6000), commitMessage: "${SENTINEL}" }] }),
    }`,
    `const { amplifyProvider } = await provider("amplify.ts"); return await amplifyProvider.discover(ctx());`,
  );
  assert.equal(out.calls.find((c) => c[0] === "ListAppsCommand")![1].maxResults, 100);
  assert.equal(out.calls.find((c) => c[0] === "ListBranchesCommand")![1].maxResults, 50);
  assert.equal(out.calls.find((c) => c[0] === "ListDomainAssociationsCommand")![1].maxResults, 50);
  assert.deepEqual(out.calls.filter((c) => c[0] === "ListJobsCommand").map((c) => [c[1].branchName, c[1].maxResults]), [["main", 1], ["dev", 1]], "production branch first");
  assert.equal(out.checkpoints.length, 1);
  const r = out.resources[0];
  assert.deepEqual([r.health, r.healthReason], ["warning", "last build failed on branch dev; domain acme.example waits for verification"]);
  assert.deepEqual(r.endpoints, ["main.d1.amplifyapp.com", "dev.d1.amplifyapp.com", "www.acme.example"]);
  assert.deepEqual(out.mentions.map((m) => m.via), ["app env API", "auto-branch env X", "branch main env DB"]);
  assert.ok(!has(out, BASIC), "basic-auth credentials nowhere, not even in mentions or checkpoints");
  assert.ok(!has(out, SPEC));
  assert.ok(!has(out, SENTINEL));
});

test("Amplify and AppSync providers (faked AWS): a panel opened on an app or API deleted since discovery says so", () => {
  const out = withFakeAws<{ app: { sections: { note?: string }[] }; api: { sections: { note?: string }[] } }>(
    { "client-amplify": "AmplifyClient", "client-appsync": "AppSyncClient" },
    `{ ListBranchesCommand: async () => { throw gone(); }, ListDomainAssociationsCommand: async () => { throw gone(); }, ListDataSourcesCommand: async () => { throw gone(); } }`,
    `const { amplifyProvider } = await provider("amplify.ts"); const { appsyncProvider } = await provider("appsync.ts");
     const base = { region: "ap-south-1", tags: {}, health: "ok", props: [] };
     const app = await amplifyProvider.detail({ ...base, key: "arn:aws:amplify:ap-south-1:123456789012:apps/d1", kind: "amplify-app", provider: "amplify", name: "site", aliases: ["d1"] }, ctx());
     const api = await appsyncProvider.detail({ ...base, key: "arn:aws:appsync:ap-south-1:123456789012:apis/g1", kind: "appsync-api", provider: "appsync", name: "a", aliases: ["g1"] }, ctx());
     return { app, api };`,
  );
  assert.equal(out.app.sections[0].note, "This app no longer exists.");
  assert.equal(out.api.sections[0].note, "This API no longer exists.");
});

test("Lightsail provider (faked AWS): three list calls, checkpoint, pending passwords and commands dropped; a region without Lightsail is skipped", () => {
  const out = withFakeAws<Run>(
    { "client-lightsail": "LightsailClient" },
    `{
      GetInstancesCommand: async (input, n) => n === 0 ? { instances: [{ name: "i", arn: "arn:aws:lightsail:ap-south-1:123456789012:Instance/1", state: { name: "running" }, publicIpAddress: "203.0.113.1", username: "${SENTINEL}", sshKeyName: "${SENTINEL}" }], nextPageToken: "p" } : { instances: [] },
      GetContainerServicesCommand: async () => ({ containerServices: [{ containerServiceName: "c", arn: "arn:aws:lightsail:ap-south-1:123456789012:ContainerService/2", state: "RUNNING",
        currentDeployment: { containers: { web: { image: "nginx", command: ["${SENTINEL}"], environment: { K: "acme-k" } } } } }] }),
      GetRelationalDatabasesCommand: async () => ({ relationalDatabases: [{ name: "d", arn: "arn:aws:lightsail:ap-south-1:123456789012:RelationalDatabase/3", state: "available", masterUsername: "${SENTINEL}",
        pendingModifiedValues: { masterUserPassword: "${SENTINEL}" }, masterEndpoint: { address: "ls-d.ap-south-1.rds.amazonaws.com", port: 3306 } }] }),
    }`,
    `const { lightsailProvider } = await provider("lightsail.ts"); return await lightsailProvider.discover(ctx());`,
  );
  assert.deepEqual(out.calls.map((c) => c[0]), ["GetInstancesCommand", "GetInstancesCommand", "GetContainerServicesCommand", "GetRelationalDatabasesCommand"]);
  assert.equal(out.checkpoints.length, 1);
  assert.deepEqual(out.resources.map((r) => r.name), ["i", "c", "d"]);
  assert.deepEqual(out.mentions.map((m) => m.via), ["container web env K"]);
  assert.ok(!has(out, SENTINEL), "commands, user names and pending passwords never leave the provider");
  const off = withFakeAws<Run>(
    { "client-lightsail": "LightsailClient" },
    `{ GetInstancesCommand: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND lightsail.us-west-1.amazonaws.com"), { code: "ENOTFOUND" }); } }`,
    `const { lightsailProvider } = await provider("lightsail.ts");
     try { await lightsailProvider.discover({ ...ctx(), region: "us-west-1" }); return {}; } catch (e) { return { error: { name: e.name, message: e.message } }; }`,
  );
  assert.deepEqual(off.calls.map((c) => c[0]), ["GetInstancesCommand"], "the other calls aren't sent");
  assert.equal(off.error?.name, "UnknownEndpoint");
  assert.match(off.error?.message ?? "", /not offered in this region \(us-west-1: getaddrinfo ENOTFOUND/);
  assert.equal(classifyError(off.error), "skipped");
  assert.equal(classifyError(off.error, { listedBefore: true }), "error", "a region that listed before doesn't quietly empty");
});
