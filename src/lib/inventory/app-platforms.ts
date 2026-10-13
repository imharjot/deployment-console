// Application platforms, pure part: what the transfer, appsync, amplify and lightsail providers read, real or simulated,
// → Resources, Links and Mentions (audit §6 A.2, the P2 rows; master plan C11).
//
// Transfer Family (ListServers + DescribeServer + ListUsers):
// - Key: the server ARN. Aliases: the server id. Endpoints: "<id>.server.transfer.<region>.amazonaws.com" and the custom
//   hostname tag (transfer:customHostname). Network: the VPC endpoint's VPC, subnets and security groups; facts.public
//   for a public endpoint or a VPC endpoint with Elastic IPs.
// - Links: identity Lambda or API Gateway (invoke); invocation, logging and user roles (assumes); users' home buckets
//   and EFS file systems (uses); its log group(s) (logs); the FTPS certificate (tls); Elastic IPs (route).
// - Health: ONLINE ok; STARTING / STOPPING warning; OFFLINE stopped; START_FAILED / STOP_FAILED error.
// - Activity: AWS/Transfer BytesIn and BytesOut {ServerId} (both show use: required, R20).
//
// AppSync (ListGraphqlApis + ListDataSources; ListApiKeys is never called):
// - Key: the API ARN. Aliases: the API id. Endpoints: the GRAPHQL and REALTIME hosts. facts.public unless PRIVATE.
// - Links per the P2 table: Lambda data sources and authorizers (invoke); DynamoDB tables and OpenSearch domains
//   (uses); RDS clusters (sql) and the secret holding their credentials (reads); HTTP data sources as their host
//   (http — never the path); EventBridge buses (event); data-source, logging and merged-API roles (assumes); the Cognito
//   user pool that signs callers in (uses); its log group (logs); its WAF ACL (protects). Health: ok. No activity.
//
// Amplify Hosting (ListApps + ListBranches + ListDomainAssociations + ListJobs (latest job per branch)):
// - Key: the app ARN. Aliases: the app id. Endpoints: "<branch>.<defaultDomain>" for every branch, and every custom
//   (sub)domain. environmentVariables of the app, of its auto-branch settings and of every branch become Mention refs
//   only; basicAuthCredentials (from ListApps AND ListBranches) and build specs are never copied anywhere — a
//   user:password pair names no resource, so not even a mention carries it.
// - Links: service and compute roles (assumes); the WAF ACL (protects); a custom domain's own certificate (tls); a
//   branch's backend stack (uses).
// - Health: the production branch's latest job FAILED error (another branch's: warning); a domain FAILED, waiting for
//   verification or for its CNAME: warning. lastActivityAt = the newest job (else the last production deploy).
//
// Lightsail (GetInstances + GetContainerServices + GetRelationalDatabases; Resource Explorer doesn't index them):
// - Keys: the ARNs. Instances: public, private and IPv6 addresses as endpoints, facts.public from a public IP; open
//   firewall ports as a prop. Container services: the service URL host, public and private domains as endpoints, the
//   containers' environment as Mention refs only, ECR images (pulls). Databases: the endpoint host, facts.public.
// - Health: instance running ok, pending / starting / stopping / rebooting warning, stopped stopped; container service
//   RUNNING ok, DEPLOYING / UPDATING / PENDING warning, READY (nothing deployed) and DISABLED stopped; database available
//   ok, failed / storage-full / incompatible-* error, stopped stopped, anything else (backing-up, modifying…) warning.
//   A region without Lightsail is skipped by the inventory (its endpoint doesn't resolve). No activity series.
// No AWS calls and no `server-only`, so node:test runs it (app-platforms.test.ts).
import { arnBase, arnOf, parseArn } from "./arn.ts";
import { ecrRepoRef } from "./compute-common.ts";
import {
  assumesLink, awsTime, clip, enrichmentOf, envMentions, fmtTime, hostOf, logGroupRef, logsLink, plural, props, tagMap, tagsOf, unread,
} from "./serverless-common.ts";
import type { EnrichState, Facts, Health, Link, Mention, ProviderResult, Resource, ResourceDetail } from "./types.ts";

type Ctx = { region: string; account?: string; now?: number };
const accountOf = (key: string, fallback?: string) => parseArn(key)?.account || fallback;
const regionOfKey = (key: string, fallback: string) => parseArn(key)?.region || fallback;
const word = (s: string) => s.toLowerCase().replace(/_/g, " ");
const uniqStr = (a: (string | undefined)[]): string[] => [...new Set(a.filter((x): x is string => !!x))];
const short = (arn: string | undefined) => (arn ? arn.split(/[:/]/).filter(Boolean).pop() ?? arn : undefined);
const consoleUrl = (region: string, path: string) => `https://${region}.console.aws.amazon.com/${path}`;

// ======================================================================================================================
// Transfer Family
// ======================================================================================================================

export const TRANSFER_HOSTNAME_TAGS = ["transfer:customHostname", "aws:transfer:customHostname"];

export interface RawTransferUser {
  UserName?: string;
  Arn?: string;
  HomeDirectory?: string; // "/bucket/prefix" (S3) or "/fs-…/path" (EFS)
  HomeDirectoryType?: string; // PATH | LOGICAL
  Role?: string;
  SshPublicKeyCount?: number;
}

// ListServers' ListedServer, plus DescribeServer's fields and the users when they were read.
export interface RawTransferServer {
  Arn?: string;
  ServerId?: string;
  State?: string; // OFFLINE | ONLINE | STARTING | STOPPING | START_FAILED | STOP_FAILED
  Domain?: string; // S3 | EFS
  EndpointType?: string; // PUBLIC | VPC | VPC_ENDPOINT
  IdentityProviderType?: string; // SERVICE_MANAGED | API_GATEWAY | AWS_DIRECTORY_SERVICE | AWS_LAMBDA
  LoggingRole?: string;
  UserCount?: number;
  // DescribeServer
  Certificate?: string;
  EndpointDetails?: { AddressAllocationIds?: string[]; SubnetIds?: string[]; VpcEndpointId?: string; VpcId?: string; SecurityGroupIds?: string[] };
  IdentityProviderDetails?: { Url?: string; InvocationRole?: string; DirectoryId?: string; Function?: string; SftpAuthenticationMethods?: string };
  Protocols?: string[];
  SecurityPolicyName?: string;
  StructuredLogDestinations?: string[];
  Tags?: { Key?: string; Value?: string }[];
  described?: boolean; // DescribeServer answered
  users?: RawTransferUser[];
  usersMore?: boolean; // ListUsers had more pages than were read
  enrichment?: Record<string, EnrichState>; // describe, users
}

export const transferHost = (id: string, region: string) => `${id}.server.transfer.${region}.amazonaws.com`;

function transferHealth(s: RawTransferServer): { health: Health; reason?: string } {
  switch (s.State) {
    case "ONLINE": return { health: "ok" };
    case "OFFLINE": return { health: "stopped", reason: "offline" };
    case "STARTING": case "STOPPING": return { health: "warning", reason: word(s.State) };
    case "START_FAILED": case "STOP_FAILED": return { health: "error", reason: word(s.State) };
    default: return { health: "unknown", reason: s.State ? `state ${s.State}` : "state not reported" };
  }
}

// A user's home directory → the bucket or EFS file system it lives in.
export function homeTarget(home: string | undefined, domain: string | undefined, region: string, account: string | undefined): string | undefined {
  const first = home?.split("/").filter(Boolean)[0];
  if (!first) return undefined;
  if (domain === "EFS" || /^fs-[0-9a-f]+$/.test(first)) return account ? arnOf.efs(region, account, first) : undefined;
  return `arn:aws:s3:::${first}`;
}

const IDP_WORD: Record<string, string> = { SERVICE_MANAGED: "service managed", API_GATEWAY: "API Gateway", AWS_DIRECTORY_SERVICE: "Directory Service", AWS_LAMBDA: "Lambda" };
const ENDPOINT_WORD: Record<string, string> = { PUBLIC: "public", VPC: "VPC", VPC_ENDPOINT: "VPC endpoint (legacy)" };

export function transferResult(servers: RawTransferServer[], o: Ctx): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const s of servers) {
    const key = s.Arn ?? (s.ServerId && o.account ? arnOf.transferServer(o.region, o.account, s.ServerId) : undefined);
    if (!key || !s.ServerId) continue;
    const region = regionOfKey(key, o.region);
    const account = accountOf(key, o.account);
    const tags = s.described ? tagMap(s.Tags ?? []) : undefined;
    const custom = TRANSFER_HOSTNAME_TAGS.map((t) => tags?.[t]).find(Boolean);
    const { health, reason } = transferHealth(s);
    const ep = s.EndpointDetails;
    const facts: Facts = {};
    if (s.State) facts.state = s.State;
    if (s.EndpointType === "PUBLIC") facts.public = true;
    else if (s.EndpointType === "VPC_ENDPOINT") facts.public = false;
    else if (s.EndpointType === "VPC" && s.described) facts.public = !!ep?.AddressAllocationIds?.length;
    const users = s.users ?? [];
    const usersRead = s.enrichment?.users === undefined || s.enrichment.users === "ok";
    const enrichment = enrichmentOf(s.enrichment);
    resources.push({
      key,
      kind: "transfer-server",
      provider: "transfer",
      name: tags?.Name || s.ServerId,
      region,
      ...tagsOf(tags), // DescribeServer returns them; a server it didn't answer for is tagsUnread (R01)
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      ...(enrichment ? { enrichment } : {}),
      ...(ep?.VpcId ? { vpcId: ep.VpcId } : {}),
      ...(ep?.SubnetIds?.length ? { subnetIds: [...ep.SubnetIds] } : {}),
      ...(ep?.SecurityGroupIds?.length ? { securityGroups: [...ep.SecurityGroupIds] } : {}),
      endpoints: uniqStr([transferHost(s.ServerId, region), custom?.toLowerCase()]),
      aliases: [s.ServerId],
      props: props([
        { label: "Protocols", value: s.Protocols?.length ? s.Protocols.join(", ") : s.described ? undefined : unread("protocols", s.enrichment?.describe) },
        { label: "Endpoint", value: s.EndpointType ? `${ENDPOINT_WORD[s.EndpointType] ?? s.EndpointType}${s.EndpointType === "VPC" && ep?.AddressAllocationIds?.length ? " · internet-facing" : ""}` : undefined },
        { label: "Custom hostname", value: custom, mono: true },
        { label: "Storage", value: s.Domain === "EFS" ? "EFS" : s.Domain === "S3" ? "S3" : s.Domain },
        { label: "Identity provider", value: s.IdentityProviderType ? IDP_WORD[s.IdentityProviderType] ?? s.IdentityProviderType : undefined },
        { label: "Users", value: s.UserCount !== undefined ? plural(s.UserCount, "user") : usersRead && s.users ? `${plural(users.length, "user")}${s.usersMore ? "+" : ""}` : undefined },
        { label: "Security policy", value: s.SecurityPolicyName },
        { label: "State", value: s.State ? word(s.State) : undefined },
      ]),
      consoleUrl: consoleUrl(region, `transfer/home?region=${region}#/servers/${s.ServerId}`),
    });
    const idp = s.IdentityProviderDetails;
    if (idp?.Function) links.push({ from: key, to: idp.Function, kind: "invoke", label: "identity provider", evidence: "server IdentityProviderDetails.Function" });
    const apigw = hostOf(idp?.Url);
    if (apigw) links.push({ from: key, to: apigw, kind: "invoke", label: "identity provider (API Gateway)", evidence: "server IdentityProviderDetails.Url" });
    links.push(...assumesLink(key, idp?.InvocationRole, "identity invocation role", "server IdentityProviderDetails.InvocationRole"));
    links.push(...assumesLink(key, s.LoggingRole, "logging role", "server LoggingRole"));
    // With a logging role, Transfer writes to /aws/transfer/<server id>; structured logging names its groups.
    const groups = s.StructuredLogDestinations?.length ? s.StructuredLogDestinations.map(arnBase) : s.LoggingRole ? [logGroupRef(`/aws/transfer/${s.ServerId}`, region, account)] : [];
    for (const g of uniqStr(groups)) links.push(...logsLink(key, g, "server logs", s.StructuredLogDestinations?.length ? "server StructuredLogDestinations" : "server LoggingRole (/aws/transfer/<id>)"));
    if (s.Certificate?.startsWith("arn:")) links.push({ from: s.Certificate, to: key, kind: "tls", label: "FTPS", evidence: "server Certificate" });
    for (const id of ep?.AddressAllocationIds ?? []) if (account) links.push({ from: arnOf.eip(region, account, id), to: key, kind: "route", label: "Elastic IP", evidence: "server EndpointDetails.AddressAllocationIds" });
    // Users: home buckets / file systems and the roles they act as — one link each, counted.
    const homes = new Map<string, string[]>();
    const roles = new Map<string, string[]>();
    for (const u of users) {
      const h = homeTarget(u.HomeDirectory, s.Domain, region, account);
      if (h) homes.set(h, [...(homes.get(h) ?? []), u.UserName ?? "?"]);
      if (u.Role) roles.set(u.Role, [...(roles.get(u.Role) ?? []), u.UserName ?? "?"]);
    }
    for (const [to, names] of homes) links.push({ from: key, to, kind: "uses", label: `home directory (${plural(names.length, "user")})`, evidence: `ListUsers HomeDirectory (${clip(names.join(", "), 120)})` });
    for (const [r, names] of roles) links.push(...assumesLink(key, r, `user role (${plural(names.length, "user")})`, `ListUsers Role (${clip(names.join(", "), 120)})`));
  }
  return { resources, links, mentions: [] };
}

export function transferDetail(key: string, s: RawTransferServer | undefined): ResourceDetail {
  if (!s) return { key, sections: [{ title: "Server", note: "This server no longer exists." }] };
  const ep = s.EndpointDetails;
  const users = s.users ?? [];
  return {
    key,
    sections: [
      {
        title: "Server",
        rows: props([
          { label: "Server id", value: s.ServerId, mono: true },
          { label: "State", value: s.State },
          { label: "Protocols", value: s.Protocols?.join(", ") },
          { label: "Endpoint type", value: s.EndpointType },
          { label: "Host", value: s.ServerId ? transferHost(s.ServerId, regionOfKey(key, "")) : undefined, mono: true },
          { label: "VPC endpoint", value: ep?.VpcEndpointId, mono: true },
          { label: "Elastic IPs", value: ep?.AddressAllocationIds?.join(", "), mono: true },
          { label: "Identity provider", value: s.IdentityProviderType },
          { label: "Identity function", value: s.IdentityProviderDetails?.Function, mono: true },
          { label: "Identity API", value: hostOf(s.IdentityProviderDetails?.Url), mono: true },
          { label: "Logging role", value: s.LoggingRole, mono: true },
          { label: "Certificate", value: s.Certificate, mono: true },
          { label: "Security policy", value: s.SecurityPolicyName },
        ]),
      },
      users.length
        ? {
          title: "Users",
          // Names, home directories and roles only: SSH key bodies and session policies are never read.
          table: { columns: ["User", "Home directory", "Role", "SSH keys"], rows: users.map((u) => [u.UserName ?? "—", u.HomeDirectoryType === "LOGICAL" ? "logical mappings" : u.HomeDirectory ?? "—", short(u.Role) ?? "—", String(u.SshPublicKeyCount ?? 0)]) },
          ...(s.usersMore ? { note: "Showing the first users only." } : {}),
        }
        : { title: "Users", note: s.users ? "No users (the identity provider may manage them)." : "Not read." },
    ],
  };
}

// ======================================================================================================================
// AppSync
// ======================================================================================================================

type AuthProvider = { authenticationType?: string; userPoolConfig?: { userPoolId?: string; awsRegion?: string }; lambdaAuthorizerConfig?: { authorizerUri?: string } };
export interface RawDataSource {
  dataSourceArn?: string;
  name?: string;
  type?: string; // AWS_LAMBDA | AMAZON_DYNAMODB | AMAZON_ELASTICSEARCH | AMAZON_OPENSEARCH_SERVICE | HTTP | RELATIONAL_DATABASE | AMAZON_EVENTBRIDGE | AMAZON_BEDROCK_RUNTIME | NONE
  serviceRoleArn?: string;
  dynamodbConfig?: { tableName?: string; awsRegion?: string };
  lambdaConfig?: { lambdaFunctionArn?: string };
  elasticsearchConfig?: { endpoint?: string; awsRegion?: string };
  openSearchServiceConfig?: { endpoint?: string; awsRegion?: string };
  httpConfig?: { endpoint?: string };
  relationalDatabaseConfig?: { relationalDatabaseSourceType?: string; rdsHttpEndpointConfig?: { awsRegion?: string; dbClusterIdentifier?: string; databaseName?: string; awsSecretStoreArn?: string } };
  eventBridgeConfig?: { eventBusArn?: string };
}

// ListGraphqlApis' GraphqlApi (it carries the tags), plus the data sources when they were read.
export interface RawGraphqlApi extends AuthProvider {
  name?: string;
  apiId?: string;
  arn?: string;
  apiType?: string; // GRAPHQL | MERGED
  visibility?: string; // GLOBAL | PRIVATE
  uris?: Record<string, string>; // GRAPHQL, REALTIME
  dns?: Record<string, string>;
  tags?: Record<string, string>;
  additionalAuthenticationProviders?: AuthProvider[];
  logConfig?: { fieldLogLevel?: string; cloudWatchLogsRoleArn?: string };
  xrayEnabled?: boolean;
  wafWebAclArn?: string;
  mergedApiExecutionRoleArn?: string;
  dataSources?: RawDataSource[];
  dataSourcesMore?: boolean;
  enrichment?: Record<string, EnrichState>; // dataSources
}

const DS_WORD: Record<string, string> = {
  AWS_LAMBDA: "Lambda", AMAZON_DYNAMODB: "DynamoDB", AMAZON_ELASTICSEARCH: "OpenSearch", AMAZON_OPENSEARCH_SERVICE: "OpenSearch", HTTP: "HTTP",
  RELATIONAL_DATABASE: "RDS", AMAZON_EVENTBRIDGE: "EventBridge", AMAZON_BEDROCK_RUNTIME: "Bedrock", NONE: "none (local)",
};
const AUTH_WORD: Record<string, string> = { API_KEY: "API key", AWS_IAM: "IAM", AMAZON_COGNITO_USER_POOLS: "Cognito user pool", OPENID_CONNECT: "OpenID Connect", AWS_LAMBDA: "Lambda authorizer" };

// What a data source points at (a key or reference the map resolves) and how.
export function dataSourceTarget(d: RawDataSource, region: string, account: string | undefined): { to: string; kind: Link["kind"] } | undefined {
  switch (d.type) {
    case "AWS_LAMBDA": return d.lambdaConfig?.lambdaFunctionArn ? { to: d.lambdaConfig.lambdaFunctionArn, kind: "invoke" } : undefined;
    case "AMAZON_DYNAMODB": {
      const t = d.dynamodbConfig?.tableName;
      return t && account ? { to: `arn:aws:dynamodb:${d.dynamodbConfig?.awsRegion || region}:${account}:table/${t}`, kind: "uses" } : undefined;
    }
    case "AMAZON_ELASTICSEARCH": case "AMAZON_OPENSEARCH_SERVICE": {
      const h = hostOf((d.openSearchServiceConfig ?? d.elasticsearchConfig)?.endpoint);
      return h ? { to: h, kind: "uses" } : undefined;
    }
    case "RELATIONAL_DATABASE": {
      const c = d.relationalDatabaseConfig?.rdsHttpEndpointConfig?.dbClusterIdentifier;
      if (!c) return undefined;
      if (c.startsWith("arn:")) return { to: c, kind: "sql" };
      return account ? { to: arnOf.rdsCluster(d.relationalDatabaseConfig?.rdsHttpEndpointConfig?.awsRegion || region, account, c), kind: "sql" } : undefined;
    }
    case "HTTP": { const h = hostOf(d.httpConfig?.endpoint); return h ? { to: h, kind: "http" } : undefined; }
    case "AMAZON_EVENTBRIDGE": return d.eventBridgeConfig?.eventBusArn ? { to: d.eventBridgeConfig.eventBusArn, kind: "event" } : undefined;
    default: return undefined;
  }
}

export const appsyncHosts = (a: RawGraphqlApi): string[] => uniqStr([...Object.values(a.uris ?? {}).map(hostOf), ...Object.values(a.dns ?? {}).map((h) => hostOf(h))]);

export function appsyncResult(apis: RawGraphqlApi[], o: Ctx): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const a of apis) {
    const key = a.arn ?? (a.apiId && o.account ? arnOf.appsyncApi(o.region, o.account, a.apiId) : undefined);
    if (!key) continue;
    const region = regionOfKey(key, o.region);
    const account = accountOf(key, o.account);
    const sources = a.dataSources ?? [];
    const sourcesRead = a.enrichment?.dataSources === undefined || a.enrichment.dataSources === "ok";
    const byType = new Map<string, number>();
    for (const d of sources) byType.set(DS_WORD[d.type ?? ""] ?? d.type ?? "?", (byType.get(DS_WORD[d.type ?? ""] ?? d.type ?? "?") ?? 0) + 1);
    const auths = [a, ...(a.additionalAuthenticationProviders ?? [])];
    const facts: Facts = {};
    if (a.visibility) facts.public = a.visibility !== "PRIVATE";
    const enrichment = enrichmentOf(a.enrichment);
    resources.push({
      key,
      kind: "appsync-api",
      provider: "appsync",
      name: a.name ?? a.apiId ?? short(key)!,
      region,
      ...tagsOf(a.tags ?? {}), // ListGraphqlApis returns them
      health: "ok",
      facts,
      ...(enrichment ? { enrichment } : {}),
      endpoints: appsyncHosts(a),
      aliases: uniqStr([a.apiId]),
      props: props([
        { label: "Type", value: a.apiType === "MERGED" ? "merged API" : "GraphQL API" },
        { label: "Authentication", value: uniqStr(auths.map((x) => (x.authenticationType ? AUTH_WORD[x.authenticationType] ?? x.authenticationType : undefined))).join(", ") || undefined },
        { label: "Visibility", value: a.visibility ? word(a.visibility) : undefined },
        {
          label: "Data sources",
          value: !sourcesRead ? unread("data sources", a.enrichment?.dataSources) : sources.length ? `${[...byType].map(([t, n]) => `${n} ${t}`).join(", ")}${a.dataSourcesMore ? " (first only)" : ""}` : "none",
        },
        { label: "Logging", value: a.logConfig?.fieldLogLevel ? word(a.logConfig.fieldLogLevel) : "off" },
        { label: "X-Ray", value: a.xrayEnabled ? "on" : undefined },
      ]),
      consoleUrl: consoleUrl(region, `appsync/home?region=${region}#/${a.apiId ?? ""}/v1/home`),
    });
    for (const d of sources) {
      const t = dataSourceTarget(d, region, account);
      if (t) links.push({ from: key, to: t.to, kind: t.kind, label: `data source ${d.name ?? "?"}`, evidence: `data source ${d.name ?? "?"} (${d.type})` });
      if (d.type === "RELATIONAL_DATABASE") {
        const secret = d.relationalDatabaseConfig?.rdsHttpEndpointConfig?.awsSecretStoreArn;
        if (secret?.startsWith("arn:")) links.push({ from: key, to: secret.split(":").slice(0, 7).join(":"), kind: "reads", label: "database credentials", evidence: `data source ${d.name ?? "?"} awsSecretStoreArn` });
      }
      links.push(...assumesLink(key, d.serviceRoleArn, `data source ${d.name ?? "?"} role`, `data source ${d.name ?? "?"} serviceRoleArn`));
    }
    for (const x of auths) {
      if (x.lambdaAuthorizerConfig?.authorizerUri) links.push({ from: key, to: x.lambdaAuthorizerConfig.authorizerUri, kind: "invoke", label: "authorizer", evidence: "lambdaAuthorizerConfig.authorizerUri" });
      const pool = x.userPoolConfig?.userPoolId;
      if (pool && account) links.push({ from: key, to: arnOf.cognitoUserPool(x.userPoolConfig?.awsRegion || region, account, pool), kind: "uses", label: "sign-in", evidence: "userPoolConfig.userPoolId" });
    }
    links.push(...assumesLink(key, a.logConfig?.cloudWatchLogsRoleArn, "logging role", "logConfig.cloudWatchLogsRoleArn"));
    links.push(...assumesLink(key, a.mergedApiExecutionRoleArn, "merged API role", "mergedApiExecutionRoleArn"));
    if (a.logConfig?.fieldLogLevel && a.apiId) links.push(...logsLink(key, logGroupRef(`/aws/appsync/apis/${a.apiId}`, region, account), "resolver logs", "logConfig (/aws/appsync/apis/<id>)"));
    if (a.wafWebAclArn) links.push({ from: a.wafWebAclArn, to: key, kind: "protects", label: "WAF", evidence: "wafWebAclArn" });
  }
  return { resources, links, mentions: [] };
}

export function appsyncDetail(key: string, a: RawGraphqlApi | undefined): ResourceDetail {
  if (!a) return { key, sections: [{ title: "API", note: "This API no longer exists." }] };
  const region = regionOfKey(key, "");
  const target = (d: RawDataSource) => {
    const t = dataSourceTarget(d, region, accountOf(key));
    return t ? (t.to.startsWith("arn:") ? short(t.to) ?? t.to : t.to) : "—";
  };
  const sources = a.dataSources ?? [];
  return {
    key,
    sections: [
      {
        title: "API",
        rows: props([
          { label: "API id", value: a.apiId, mono: true },
          { label: "GraphQL", value: hostOf(a.uris?.GRAPHQL), mono: true },
          { label: "Real-time", value: hostOf(a.uris?.REALTIME), mono: true },
          { label: "WAF", value: a.wafWebAclArn ? short(a.wafWebAclArn) : undefined },
        ]),
        note: "API keys are never read.",
      },
      sources.length
        ? { title: "Data sources", table: { columns: ["Name", "Type", "Target", "Role"], rows: sources.map((d) => [d.name ?? "—", DS_WORD[d.type ?? ""] ?? d.type ?? "—", target(d), short(d.serviceRoleArn) ?? "—"]) } }
        : { title: "Data sources", note: a.dataSources ? "No data sources." : "Not read." },
    ],
  };
}

// ======================================================================================================================
// Amplify Hosting
// ======================================================================================================================

type EnvVars = Record<string, string>;
export interface RawAmplifyBranch {
  branchArn?: string;
  branchName?: string;
  displayName?: string; // the default-domain prefix ("feature-x" for "feature/x")
  stage?: string; // PRODUCTION | BETA | DEVELOPMENT | EXPERIMENTAL | PULL_REQUEST
  framework?: string;
  updateTime?: Date | string | number;
  customDomains?: string[];
  enableAutoBuild?: boolean;
  enableBasicAuth?: boolean;
  environmentVariables?: EnvVars; // secret-bearing: mentions only
  backend?: { stackArn?: string };
  computeRoleArn?: string;
}
export interface RawAmplifyJob {
  jobId?: string;
  status?: string; // CREATED | PENDING | PROVISIONING | RUNNING | FAILED | SUCCEED | CANCELLING | CANCELLED
  jobType?: string;
  commitId?: string;
  startTime?: Date | string | number;
  endTime?: Date | string | number;
}
export interface RawAmplifyDomain {
  domainName?: string;
  domainStatus?: string; // PENDING_VERIFICATION | IN_PROGRESS | AVAILABLE | PENDING_DEPLOYMENT | AWAITING_APP_CNAME | FAILED | …
  statusReason?: string;
  subDomains?: { subDomainSetting?: { prefix?: string; branchName?: string }; verified?: boolean }[];
  certificate?: { type?: string; customCertificateArn?: string };
}
// ListApps' App (tags included), plus branches, domains and each branch's latest job when they were read.
export interface RawAmplifyApp {
  appId?: string;
  appArn?: string;
  name?: string;
  platform?: string; // WEB | WEB_DYNAMIC | WEB_COMPUTE
  repository?: string;
  defaultDomain?: string;
  tags?: Record<string, string>;
  iamServiceRoleArn?: string;
  computeRoleArn?: string;
  environmentVariables?: EnvVars; // secret-bearing: mentions only
  enableBasicAuth?: boolean;
  enableBranchAutoBuild?: boolean;
  autoBranchCreationConfig?: { environmentVariables?: EnvVars };
  productionBranch?: { branchName?: string; status?: string; lastDeployTime?: Date | string | number };
  wafConfiguration?: { webAclArn?: string; wafStatus?: string };
  branches?: RawAmplifyBranch[];
  branchesMore?: boolean;
  domains?: RawAmplifyDomain[];
  jobs?: Record<string, RawAmplifyJob | undefined>; // branch name → latest job
  enrichment?: Record<string, EnrichState>; // branches, domains, jobs
}

const PLATFORM_WORD: Record<string, string> = { WEB: "static", WEB_DYNAMIC: "SSR (legacy)", WEB_COMPUTE: "SSR (compute)" };
const time = (v: Date | string | number | undefined) => (typeof v === "number" ? (v < 1e11 ? v * 1000 : v) : awsTime(v));
export const branchHost = (b: { branchName?: string; displayName?: string }, defaultDomain: string) =>
  `${(b.displayName || (b.branchName ?? "").replace(/[^a-zA-Z0-9-]/g, "-")).toLowerCase()}.${defaultDomain.toLowerCase()}`;

// Every custom host a domain association serves: "<prefix>.<domain>", or the apex for an empty prefix.
export const domainHosts = (d: RawAmplifyDomain): string[] =>
  d.domainName ? (d.subDomains ?? []).map((s) => (s.subDomainSetting?.prefix ? `${s.subDomainSetting.prefix}.${d.domainName}` : d.domainName!).toLowerCase()) : [];

// "https://user:token@github.com/acme/site.git" → "github.com/acme/site.git": never user info, query or fragment.
export const repoLabel = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return undefined;
  }
};

// The branch production traffic comes from: ListApps' productionBranch, else the PRODUCTION-stage branch, else the
// only branch.
export function productionBranchOf(a: RawAmplifyApp): string | undefined {
  if (a.productionBranch?.branchName) return a.productionBranch.branchName;
  const branches = a.branches ?? [];
  return branches.find((b) => b.stage === "PRODUCTION")?.branchName ?? (branches.length === 1 ? branches[0].branchName : undefined);
}

function amplifyHealth(a: RawAmplifyApp): { health: Health; reason?: string } {
  const prod = productionBranchOf(a);
  const jobs = a.jobs ?? {};
  const prodJob = prod ? jobs[prod] : undefined;
  if (prodJob?.status === "FAILED") return { health: "error", reason: `last build of ${prod} failed${prodJob.endTime || prodJob.startTime ? ` (${fmtTime(time(prodJob.endTime ?? prodJob.startTime))})` : ""}` };
  if (!prodJob && a.productionBranch?.status === "FAILED") return { health: "error", reason: `last deploy of ${prod ?? "the production branch"} failed` };
  const reasons: string[] = [];
  const failed = Object.entries(jobs).filter(([b, j]) => b !== prod && j?.status === "FAILED").map(([b]) => b);
  if (failed.length) reasons.push(`last build failed on ${failed.length === 1 ? `branch ${failed[0]}` : `${failed.length} branches (${clip(failed.join(", "), 80)})`}`);
  for (const d of a.domains ?? []) {
    if (d.domainStatus === "FAILED") reasons.push(`domain ${d.domainName} failed${d.statusReason ? `: ${clip(d.statusReason, 120)}` : ""}`);
    else if (d.domainStatus === "PENDING_VERIFICATION") reasons.push(`domain ${d.domainName} waits for verification`);
    else if (d.domainStatus === "AWAITING_APP_CNAME") reasons.push(`domain ${d.domainName} waits for its CNAME records`);
  }
  if (reasons.length) return { health: "warning", reason: reasons.join("; ") };
  if (a.enrichment?.branches === "ok" && a.branches && !a.branches.length) return { health: "stopped", reason: "no branches connected" };
  return { health: "ok" };
}

export function newestAmplifyJobAt(a: RawAmplifyApp): number | undefined {
  let best: number | undefined;
  for (const j of Object.values(a.jobs ?? {})) for (const t of [time(j?.endTime), time(j?.startTime)]) if (t !== undefined && (best === undefined || t > best)) best = t;
  return best ?? time(a.productionBranch?.lastDeployTime);
}

export function amplifyResult(apps: RawAmplifyApp[], o: Ctx): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const mentions: Mention[] = [];
  for (const a of apps) {
    const key = a.appArn ?? (a.appId && o.account ? arnOf.amplifyApp(o.region, o.account, a.appId) : undefined);
    if (!key) continue;
    const region = regionOfKey(key, o.region);
    const branches = a.branches ?? [];
    const domains = a.domains ?? [];
    const prod = productionBranchOf(a);
    const hosts = a.defaultDomain
      ? branches.length ? branches.map((b) => branchHost(b, a.defaultDomain!)) : prod ? [branchHost({ branchName: prod }, a.defaultDomain)] : []
      : [];
    const custom = uniqStr([...domains.flatMap(domainHosts), ...branches.flatMap((b) => b.customDomains ?? []).map((h) => hostOf(h))]);
    const { health, reason } = amplifyHealth(a);
    const last = newestAmplifyJobAt(a);
    const prodJob = prod ? a.jobs?.[prod] : undefined;
    const enrichment = enrichmentOf(a.enrichment);
    resources.push({
      key,
      kind: "amplify-app",
      provider: "amplify",
      name: a.name ?? a.appId ?? short(key)!,
      region,
      ...tagsOf(a.tags ?? {}), // ListApps returns them
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts: {},
      ...(enrichment ? { enrichment } : {}),
      endpoints: uniqStr([...hosts, ...custom]),
      aliases: uniqStr([a.appId]),
      ...(last !== undefined ? { lastActivityAt: last } : {}),
      props: props([
        { label: "Platform", value: a.platform ? PLATFORM_WORD[a.platform] ?? a.platform : undefined },
        { label: "Repository", value: repoLabel(a.repository), mono: true },
        { label: "Production branch", value: prod },
        { label: "Branches", value: a.branches ? `${branches.length}${a.branchesMore ? "+" : ""}` : unread("branches", a.enrichment?.branches) },
        {
          label: "Last build",
          value: prodJob?.status ? `${word(prodJob.status === "SUCCEED" ? "SUCCEEDED" : prodJob.status)}${prodJob.endTime || prodJob.startTime ? ` · ${fmtTime(time(prodJob.endTime ?? prodJob.startTime))}` : ""}`
            : a.productionBranch?.status ? `${word(a.productionBranch.status)}${a.productionBranch.lastDeployTime ? ` · ${fmtTime(time(a.productionBranch.lastDeployTime))}` : ""}` : undefined,
        },
        { label: "Custom domains", value: custom.length ? clip(custom.join(", "), 200) : undefined, mono: true },
        // Only whether it is on: the credentials themselves are never read into anything.
        { label: "Basic auth", value: a.enableBasicAuth || branches.some((b) => b.enableBasicAuth) ? "on" : undefined },
        { label: "Variables", value: a.environmentVariables && Object.keys(a.environmentVariables).length ? plural(Object.keys(a.environmentVariables).length, "variable") : undefined },
      ]),
      consoleUrl: consoleUrl(region, `amplify/apps/${a.appId ?? ""}/overview`),
    });
    links.push(...assumesLink(key, a.iamServiceRoleArn, "service role", "app iamServiceRoleArn"));
    for (const r of uniqStr([a.computeRoleArn, ...branches.map((b) => b.computeRoleArn)])) links.push(...assumesLink(key, r, "compute role", "computeRoleArn"));
    if (a.wafConfiguration?.webAclArn) links.push({ from: a.wafConfiguration.webAclArn, to: key, kind: "protects", label: "WAF", evidence: "app wafConfiguration" });
    for (const d of domains) if (d.certificate?.customCertificateArn) links.push({ from: d.certificate.customCertificateArn, to: key, kind: "tls", label: d.domainName, evidence: `domain ${d.domainName} certificate` });
    for (const b of branches) if (b.backend?.stackArn) links.push({ from: key, to: b.backend.stackArn, kind: "uses", label: `backend (${b.branchName})`, evidence: `branch ${b.branchName} backend.stackArn` });
    // Variables of the app, its auto-branch template and every branch: Mention refs only (they may hold secrets).
    mentions.push(...envMentions(key, a.environmentVariables, "app env"));
    mentions.push(...envMentions(key, a.autoBranchCreationConfig?.environmentVariables, "auto-branch env"));
    for (const b of branches) mentions.push(...envMentions(key, b.environmentVariables, `branch ${b.branchName ?? "?"} env`));
  }
  return { resources, links, mentions };
}

export function amplifyDetail(key: string, a: RawAmplifyApp | undefined): ResourceDetail {
  if (!a) return { key, sections: [{ title: "App", note: "This app no longer exists." }] };
  const branches = a.branches ?? [];
  const domains = a.domains ?? [];
  const jobCell = (b: string | undefined) => {
    const j = b ? a.jobs?.[b] : undefined;
    return j?.status ? `${word(j.status === "SUCCEED" ? "SUCCEEDED" : j.status)}${j.endTime || j.startTime ? ` · ${fmtTime(time(j.endTime ?? j.startTime))}` : ""}` : "—";
  };
  return {
    key,
    sections: [
      branches.length
        ? {
          title: "Branches",
          // Branch names, stages and builds only: environment variables and basic-auth credentials are never shown.
          table: {
            columns: ["Branch", "Stage", "Last build", "URL"],
            rows: branches.map((b) => [b.branchName ?? "—", b.stage ? word(b.stage) : "—", jobCell(b.branchName), a.defaultDomain ? branchHost(b, a.defaultDomain) : "—"]),
          },
          ...(a.branchesMore ? { note: "Showing the first branches only." } : {}),
        }
        : { title: "Branches", note: a.branches ? "No branches." : "Not read." },
      domains.length
        ? { title: "Custom domains", table: { columns: ["Domain", "Status", "Hosts"], rows: domains.map((d) => [d.domainName ?? "—", d.domainStatus ? word(d.domainStatus) : "—", domainHosts(d).join(", ") || "—"]) } }
        : { title: "Custom domains", note: a.domains ? "None." : "Not read." },
    ],
  };
}

// ======================================================================================================================
// Lightsail
// ======================================================================================================================

type LsTag = { key?: string; value?: string };
type LsLocation = { availabilityZone?: string; regionName?: string };
export interface RawLightsailInstance {
  name?: string;
  arn?: string;
  createdAt?: Date | string | number;
  location?: LsLocation;
  tags?: LsTag[];
  blueprintName?: string;
  bundleId?: string;
  isStaticIp?: boolean;
  privateIpAddress?: string;
  publicIpAddress?: string;
  ipv6Addresses?: string[];
  state?: { code?: number; name?: string };
  networking?: { ports?: { fromPort?: number; toPort?: number; protocol?: string; cidrs?: string[]; ipv6Cidrs?: string[] }[] };
}
export interface RawContainer {
  image?: string;
  environment?: Record<string, string>; // secret-bearing: mentions only
  ports?: Record<string, string>;
}
export interface RawContainerService {
  containerServiceName?: string;
  arn?: string;
  createdAt?: Date | string | number;
  location?: LsLocation;
  tags?: LsTag[];
  power?: string;
  scale?: number;
  state?: string; // PENDING | READY | RUNNING | UPDATING | DELETING | DISABLED | DEPLOYING
  stateDetail?: { code?: string; message?: string };
  isDisabled?: boolean;
  currentDeployment?: { version?: number; state?: string; containers?: Record<string, RawContainer>; publicEndpoint?: { containerName?: string; containerPort?: number } };
  url?: string;
  privateDomainName?: string;
  publicDomainNames?: Record<string, string[]>;
}
export interface RawLightsailDatabase {
  name?: string;
  arn?: string;
  createdAt?: Date | string | number;
  location?: LsLocation;
  tags?: LsTag[];
  engine?: string;
  engineVersion?: string;
  relationalDatabaseBundleId?: string;
  state?: string;
  backupRetentionEnabled?: boolean;
  publiclyAccessible?: boolean;
  masterEndpoint?: { port?: number; address?: string };
}
export interface LightsailInput {
  instances: RawLightsailInstance[];
  containers: RawContainerService[];
  databases: RawLightsailDatabase[];
}

const ANYWHERE = new Set(["0.0.0.0/0", "::/0"]);
// "22/tcp, 80/tcp, 443/tcp" — the instance firewall's ports open to anyone.
export function openPorts(i: RawLightsailInstance): string[] {
  const out: string[] = [];
  for (const p of i.networking?.ports ?? []) {
    if (![...(p.cidrs ?? []), ...(p.ipv6Cidrs ?? [])].some((c) => ANYWHERE.has(c))) continue;
    const range = p.protocol === "all" ? "all" : p.fromPort === p.toPort ? `${p.fromPort}` : `${p.fromPort}-${p.toPort}`;
    const label = p.protocol === "all" ? "all" : `${range}/${p.protocol ?? "tcp"}`;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

function instanceHealth(i: RawLightsailInstance): { health: Health; reason?: string } {
  const s = i.state?.name;
  if (s === "running") return { health: "ok" };
  if (s === "stopped" || s === "terminated" || s === "shutting-down") return { health: "stopped", reason: s };
  if (s) return { health: "warning", reason: s };
  return { health: "unknown", reason: "state not reported" };
}
function containerHealth(c: RawContainerService): { health: Health; reason?: string } {
  const detail = c.stateDetail?.message ? `: ${clip(c.stateDetail.message, 160)}` : c.stateDetail?.code ? `: ${word(c.stateDetail.code)}` : "";
  if (c.isDisabled || c.state === "DISABLED") return { health: "stopped", reason: "disabled" };
  switch (c.state) {
    case "RUNNING": return { health: "ok" };
    case "READY": return { health: "stopped", reason: "nothing deployed" };
    case "DEPLOYING": case "UPDATING": case "PENDING": return { health: "warning", reason: `${word(c.state)}${detail}` };
    case "DELETING": return { health: "stopped", reason: "deleting" };
    default: return { health: "unknown", reason: c.state ? `state ${c.state}` : "state not reported" };
  }
}
function databaseHealth(d: RawLightsailDatabase): { health: Health; reason?: string } {
  const s = d.state;
  if (s === "available") return { health: "ok" };
  if (s === "stopped") return { health: "stopped", reason: "stopped" };
  if (!s) return { health: "unknown", reason: "state not reported" };
  if (s === "failed" || s === "storage-full" || s.startsWith("incompatible")) return { health: "error", reason: s };
  return { health: "warning", reason: s };
}

const lsTags = (t: LsTag[] | undefined) => tagsOf((t ?? []).map((x) => ({ key: x.key, value: x.value ?? "" })));
const lsUrl = (region: string, path: string) => `https://lightsail.aws.amazon.com/ls/webapp/${region}/${path}`;

export function lightsailResult(input: LightsailInput, o: Ctx): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const mentions: Mention[] = [];
  for (const i of input.instances) {
    if (!i.arn || !i.name) continue;
    const region = regionOfKey(i.arn, o.region);
    const { health, reason } = instanceHealth(i);
    const open = openPorts(i);
    const facts: Facts = {};
    if (i.state?.name) facts.state = i.state.name;
    facts.public = !!i.publicIpAddress || !!i.ipv6Addresses?.length;
    resources.push({
      key: i.arn,
      kind: "lightsail-instance",
      provider: "lightsail",
      name: i.name,
      region,
      ...lsTags(i.tags),
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      endpoints: uniqStr([i.publicIpAddress, i.privateIpAddress, ...(i.ipv6Addresses ?? [])]),
      aliases: [i.name],
      ...(time(i.createdAt) ? { createdAt: time(i.createdAt) } : {}),
      props: props([
        { label: "Blueprint", value: i.blueprintName },
        { label: "Bundle", value: i.bundleId },
        { label: "State", value: i.state?.name },
        { label: "Public IP", value: i.publicIpAddress ? `${i.publicIpAddress}${i.isStaticIp ? " (static)" : ""}` : undefined, mono: true },
        { label: "Private IP", value: i.privateIpAddress, mono: true },
        { label: "Open to anyone", value: open.length ? open.join(", ") : undefined },
      ]),
      consoleUrl: lsUrl(region, `instances/${encodeURIComponent(i.name)}/connect`),
    });
  }
  for (const c of input.containers) {
    if (!c.arn || !c.containerServiceName) continue;
    const region = regionOfKey(c.arn, o.region);
    const { health, reason } = containerHealth(c);
    const containers = Object.entries(c.currentDeployment?.containers ?? {});
    const pub = c.currentDeployment?.publicEndpoint;
    resources.push({
      key: c.arn,
      kind: "lightsail-container",
      provider: "lightsail",
      name: c.containerServiceName,
      region,
      ...lsTags(c.tags),
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts: { ...(c.state ? { state: c.state } : {}), public: !!pub },
      endpoints: uniqStr([hostOf(c.url), ...Object.values(c.publicDomainNames ?? {}).flat().map((h) => hostOf(h)), hostOf(c.privateDomainName)]),
      aliases: [c.containerServiceName],
      ...(time(c.createdAt) ? { createdAt: time(c.createdAt) } : {}),
      props: props([
        { label: "Power", value: c.power ? `${c.power}${c.scale ? ` × ${c.scale}` : ""}` : undefined },
        { label: "State", value: c.state ? word(c.state) : undefined },
        { label: "Deployment", value: c.currentDeployment?.version !== undefined ? `version ${c.currentDeployment.version}${c.currentDeployment.state ? ` · ${word(c.currentDeployment.state)}` : ""}` : undefined },
        // Names and images only: environment values and commands are never shown.
        { label: "Containers", value: containers.length ? clip(containers.map(([n, x]) => `${n} (${x.image ?? "?"})`).join(", "), 200) : undefined },
        { label: "Public endpoint", value: pub?.containerName ? `${pub.containerName}:${pub.containerPort ?? "?"}` : undefined },
        { label: "URL", value: hostOf(c.url), mono: true },
      ]),
      consoleUrl: lsUrl(region, `container-services/${encodeURIComponent(c.containerServiceName)}/deployments`),
    });
    for (const [n, x] of containers) {
      const repo = ecrRepoRef(x.image);
      if (repo) links.push({ from: c.arn, to: repo, kind: "pulls", label: `image (${n})`, evidence: `container ${n} image` });
      mentions.push(...envMentions(c.arn, x.environment, `container ${n} env`));
    }
  }
  for (const d of input.databases) {
    if (!d.arn || !d.name) continue;
    const region = regionOfKey(d.arn, o.region);
    const { health, reason } = databaseHealth(d);
    const facts: Facts = {};
    if (d.state) facts.state = d.state;
    if (d.publiclyAccessible !== undefined) facts.public = d.publiclyAccessible;
    resources.push({
      key: d.arn,
      kind: "lightsail-database",
      provider: "lightsail",
      name: d.name,
      region,
      ...lsTags(d.tags),
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      endpoints: uniqStr([d.masterEndpoint?.address?.toLowerCase()]),
      aliases: [d.name],
      ...(time(d.createdAt) ? { createdAt: time(d.createdAt) } : {}),
      props: props([
        { label: "Engine", value: d.engine ? `${d.engine} ${d.engineVersion ?? ""}`.trim() : undefined },
        { label: "Bundle", value: d.relationalDatabaseBundleId },
        { label: "State", value: d.state },
        { label: "Endpoint", value: d.masterEndpoint?.address ? `${d.masterEndpoint.address}:${d.masterEndpoint.port ?? "?"}` : undefined, mono: true },
        { label: "Public", value: d.publiclyAccessible === undefined ? undefined : d.publiclyAccessible ? "yes" : "no" },
        { label: "Backups", value: d.backupRetentionEnabled === undefined ? undefined : d.backupRetentionEnabled ? "automatic" : "off" },
      ]),
      consoleUrl: lsUrl(region, `databases/${encodeURIComponent(d.name)}/connect`),
    });
  }
  return { resources, links, mentions };
}

export function lightsailDetail(key: string, kind: string, input: LightsailInput | undefined): ResourceDetail {
  const gone = (what: string) => ({ key, sections: [{ title: what, note: `This ${what.toLowerCase()} no longer exists.` }] });
  if (kind === "lightsail-instance") {
    const i = input?.instances.find((x) => x.arn === key);
    if (!i) return gone("Instance");
    return {
      key,
      sections: [
        { title: "Instance", rows: props([{ label: "Name", value: i.name }, { label: "Zone", value: i.location?.availabilityZone }, { label: "Blueprint", value: i.blueprintName }, { label: "Bundle", value: i.bundleId }, { label: "IPv6", value: i.ipv6Addresses?.join(", "), mono: true }]) },
        (i.networking?.ports ?? []).length
          ? {
            title: "Firewall",
            table: { columns: ["Ports", "Protocol", "From"], rows: (i.networking?.ports ?? []).map((p) => [p.fromPort === p.toPort ? String(p.fromPort ?? "—") : `${p.fromPort}-${p.toPort}`, p.protocol ?? "—", [...(p.cidrs ?? []), ...(p.ipv6Cidrs ?? [])].join(", ") || "—"]) },
          }
          : { title: "Firewall", note: "No open ports." },
      ],
    };
  }
  if (kind === "lightsail-container") {
    const c = input?.containers.find((x) => x.arn === key);
    if (!c) return gone("Container service");
    const containers = Object.entries(c.currentDeployment?.containers ?? {});
    return {
      key,
      sections: [
        { title: "Container service", rows: props([{ label: "Name", value: c.containerServiceName }, { label: "State", value: c.state }, { label: "Power", value: c.power }, { label: "Scale", value: c.scale !== undefined ? String(c.scale) : undefined }, { label: "URL", value: c.url, mono: true }]) },
        containers.length
          // Images and ports only: environment values and commands are never shown.
          ? { title: "Containers", table: { columns: ["Container", "Image", "Ports", "Variables"], rows: containers.map(([n, x]) => [n, x.image ?? "—", Object.entries(x.ports ?? {}).map(([p, proto]) => `${p}/${proto.toLowerCase()}`).join(", ") || "—", String(Object.keys(x.environment ?? {}).length)]) } }
          : { title: "Containers", note: "Nothing deployed." },
      ],
    };
  }
  const d = input?.databases.find((x) => x.arn === key);
  if (!d) return gone("Database");
  return {
    key,
    sections: [{
      title: "Database",
      rows: props([
        { label: "Name", value: d.name }, { label: "Engine", value: d.engine ? `${d.engine} ${d.engineVersion ?? ""}`.trim() : undefined }, { label: "State", value: d.state },
        { label: "Zone", value: d.location?.availabilityZone }, { label: "Endpoint", value: d.masterEndpoint?.address, mono: true }, { label: "Port", value: d.masterEndpoint?.port !== undefined ? String(d.masterEndpoint.port) : undefined },
      ]),
      note: "Master credentials are never read.",
    }],
  };
}
