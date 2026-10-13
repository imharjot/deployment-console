import { test } from "node:test";
import assert from "node:assert/strict";
import { domainHealth, domainResource, opensearchDetail, opensearchResult, type RawDomain } from "./opensearch.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const SENTINEL = "SECRET_SENTINEL_os01";
const arn = (name: string) => `arn:aws:es:${R}:${ACCT}:domain/${name}`;

const vpcDomain: RawDomain = {
  DomainId: `${ACCT}/search`, DomainName: "search", ARN: arn("search"), Created: true, Deleted: false, Endpoints: { vpc: "vpc-search-abc.us-east-1.es.amazonaws.com" },
  DomainProcessingStatus: "Active", EngineVersion: "OpenSearch_2.17",
  ClusterConfig: { InstanceType: "r7g.large.search", InstanceCount: 3, DedicatedMasterEnabled: true, DedicatedMasterType: "m7g.large.search", DedicatedMasterCount: 3, ZoneAwarenessEnabled: true },
  EBSOptions: { EBSEnabled: true, VolumeType: "gp3", VolumeSize: 100 },
  VPCOptions: { VPCId: "vpc-prod", SubnetIds: ["subnet-a", "subnet-b"], SecurityGroupIds: ["sg-search"] },
  EncryptionAtRestOptions: { Enabled: true, KmsKeyId: `arn:aws:kms:${R}:${ACCT}:key/k1` }, NodeToNodeEncryptionOptions: { Enabled: true },
  DomainEndpointOptions: { EnforceHTTPS: true, CustomEndpointEnabled: true, CustomEndpoint: "search.acme.example", CustomEndpointCertificateArn: `arn:aws:acm:${R}:${ACCT}:certificate/c1` },
  AdvancedSecurityOptions: { Enabled: true, InternalUserDatabaseEnabled: true },
  LogPublishingOptions: {
    ES_APPLICATION_LOGS: { CloudWatchLogsLogGroupArn: `arn:aws:logs:${R}:${ACCT}:log-group:/aws/opensearch/search:*`, Enabled: true },
    AUDIT_LOGS: { CloudWatchLogsLogGroupArn: `arn:aws:logs:${R}:${ACCT}:log-group:/aws/opensearch/audit`, Enabled: false },
  },
  tags: [{ Key: "Environment", Value: "production" }], enrichment: { tags: "ok" },
  ...({ AccessPolicies: `{"Statement":[{"Principal":"${SENTINEL}"}]}`, AdvancedOptions: { secret: SENTINEL }, CognitoOptions: { IdentityPoolId: SENTINEL } } as object),
};

test("golden: a VPC domain — endpoints, network, facts.public false, KMS / logs / TLS links; the access policy never leaks", () => {
  const { resource, links } = domainResource(vpcDomain, { region: R, account: ACCT, now: NOW });
  assert.deepEqual(resource, {
    key: arn("search"), kind: "opensearch-domain", provider: "opensearch", name: "search", region: R, tags: { Environment: "production" }, health: "ok",
    props: [
      { label: "Engine", value: "OpenSearch 2.17" }, { label: "Nodes", value: "3 × r7g.large.search · 3 dedicated masters" }, { label: "Storage", value: "EBS gp3 100 GiB per node" },
      { label: "Zone awareness", value: "on" }, { label: "Network", value: "VPC vpc-prod" }, { label: "Endpoint", value: "vpc-search-abc.us-east-1.es.amazonaws.com", mono: true },
      { label: "Custom endpoint", value: "search.acme.example", mono: true }, { label: "Encryption", value: "at rest (KMS key/k1) · node to node · HTTPS only" },
      { label: "Fine-grained access control", value: "on" },
    ],
    endpoints: ["vpc-search-abc.us-east-1.es.amazonaws.com", "search.acme.example"], aliases: ["search", `${ACCT}/search`],
    vpcId: "vpc-prod", subnetIds: ["subnet-a", "subnet-b"], securityGroups: ["sg-search"], facts: { public: false }, enrichment: { tags: "ok" },
    consoleUrl: `https://${R}.console.aws.amazon.com/aos/home?region=${R}#opensearch/domains/search`, observedAt: NOW,
  });
  assert.deepEqual(links.map((l) => [l.from, l.to, l.kind, l.label]), [
    [`arn:aws:kms:${R}:${ACCT}:key/k1`, arn("search"), "encrypts", "at rest"],
    [arn("search"), `arn:aws:logs:${R}:${ACCT}:log-group:/aws/opensearch/search`, "logs", "application logs"],
    [`arn:aws:acm:${R}:${ACCT}:certificate/c1`, arn("search"), "tls", "search.acme.example"],
  ]);
  const detail = opensearchDetail(arn("search"), vpcDomain);
  assert.deepEqual(detail.sections.map((s) => s.title), ["Domain", "Endpoints", "Nodes and storage", "Network and security", "Log publishing"]);
  assert.deepEqual(detail.sections[1].table?.rows, [["vpc", "vpc-search-abc.us-east-1.es.amazonaws.com"], ["custom", "search.acme.example"]]);
  assert.ok(!JSON.stringify({ resource, links, detail }).includes(SENTINEL));
});

test("a public domain is facts.public; unread tags fail closed; processing states", () => {
  const out = opensearchResult([
    { DomainName: "logs", ARN: arn("logs"), Created: true, Endpoint: "search-logs-abc.us-east-1.es.amazonaws.com", EndpointV2: "search-logs-abc.aos.us-east-1.on.aws", Processing: true, enrichment: { tags: "denied" } },
    { DomainName: "no-arn" },
  ], { region: R, account: ACCT });
  assert.equal(out.resources.length, 1);
  const [pub] = out.resources;
  assert.deepEqual([pub.facts, pub.tagsUnread, pub.tags, pub.enrichment, pub.health, pub.endpoints], [
    { public: true }, true, {}, { tags: "denied" }, "warning", ["search-logs-abc.us-east-1.es.amazonaws.com", "search-logs-abc.aos.us-east-1.on.aws"],
  ]);
  assert.equal(pub.props.find((p) => p.label === "Network")?.value, "public endpoint (no VPC)");
  assert.deepEqual(domainHealth({ DomainProcessingStatus: "Isolated" }).health, "error");
  assert.deepEqual(domainHealth({ DomainProcessingStatus: "UpgradingEngineVersion" }), { health: "warning", healthReason: "engine upgrade in progress" });
  assert.deepEqual(domainHealth({ DomainProcessingStatus: "UpdatingServiceSoftware" }).health, "warning");
  assert.deepEqual(domainHealth({ DomainProcessingStatus: "Modifying" }).health, "warning");
  assert.deepEqual(domainHealth({ DomainProcessingStatus: "Creating" }).health, "warning");
  assert.deepEqual(domainHealth({ DomainProcessingStatus: "Deleting" }).health, "stopped");
  assert.deepEqual(domainHealth({ Deleted: true, DomainProcessingStatus: "Active" }).health, "stopped");
  assert.deepEqual(domainHealth({ Created: true, UpgradeProcessing: true }).health, "warning");
  assert.deepEqual(domainHealth({ Created: true }), { health: "ok" });
  assert.deepEqual(domainHealth({}), { health: "unknown", healthReason: "status not reported" });
  assert.equal(opensearchDetail("k", { DomainName: "x", enrichment: { tags: "denied" } }).sections[0].rows?.find((r) => r.label === "Tags")?.value, "tags not read (denied)");
  assert.equal(opensearchDetail("k", undefined).sections[0].note, "This domain no longer exists.");
});
