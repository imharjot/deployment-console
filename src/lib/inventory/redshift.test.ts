import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterDetail, clusterHealth, clusterResource, namespaceRoles, redshiftResult, workgroupDetail, workgroupHealth, type RawNamespace, type RawRedshiftCluster, type RawWorkgroup } from "./redshift.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const SENTINEL = "SECRET_SENTINEL_rs01";

const dw: RawRedshiftCluster = {
  ClusterIdentifier: "dw", NodeType: "ra3.xlplus", NumberOfNodes: 2, ClusterStatus: "available", ClusterAvailabilityStatus: "Available", DBName: "analytics",
  Endpoint: { Address: "dw.c1.us-east-1.redshift.amazonaws.com", Port: 5439 }, ClusterCreateTime: "2025-03-04T05:06:07.000Z", AutomatedSnapshotRetentionPeriod: 7,
  VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-dw", Status: "active" }], ClusterSubnetGroupName: "dw-subnets", VpcId: "vpc-prod", PubliclyAccessible: true, Encrypted: true,
  KmsKeyId: `arn:aws:kms:${R}:${ACCT}:key/k1`, Tags: [{ Key: "Environment", Value: "production" }],
  IamRoles: [{ IamRoleArn: `arn:aws:iam::${ACCT}:role/dw-copy`, ApplyStatus: "in-sync" }], DefaultIamRoleArn: `arn:aws:iam::${ACCT}:role/dw-copy`,
  MasterPasswordSecretArn: `arn:aws:secretsmanager:${R}:${ACCT}:secret:redshift!dw-admin-AbCdEf`, CustomDomainName: "dw.acme.example", CustomDomainCertificateArn: `arn:aws:acm:${R}:${ACCT}:certificate/c1`,
  ...({ MasterUsername: SENTINEL, ClusterPublicKey: SENTINEL } as object),
};

test("golden: a provisioned cluster — public fact, KMS / role / secret / TLS links; the admin user never leaks", () => {
  const { resource, links } = clusterResource(dw, { region: R, account: ACCT, now: NOW });
  assert.deepEqual(resource, {
    key: `arn:aws:redshift:${R}:${ACCT}:cluster:dw`, kind: "redshift-cluster", provider: "redshift", name: "dw", region: R, tags: { Environment: "production" }, health: "ok",
    props: [
      { label: "Engine", value: "redshift" }, { label: "Nodes", value: "2 × ra3.xlplus" }, { label: "Database", value: "analytics" }, { label: "Endpoint", value: "dw.c1.us-east-1.redshift.amazonaws.com", mono: true },
      { label: "Port", value: "5439" }, { label: "Custom domain", value: "dw.acme.example", mono: true }, { label: "Publicly accessible", value: "yes" },
      { label: "Encryption", value: "KMS key/k1" }, { label: "Snapshots", value: "automated, 7 days" }, { label: "Subnet group", value: "dw-subnets" },
      { label: "Created", value: "2025-03-04 05:06 UTC" },
    ],
    endpoints: ["dw.c1.us-east-1.redshift.amazonaws.com", "dw.acme.example"], aliases: ["dw"], vpcId: "vpc-prod", securityGroups: ["sg-dw"], facts: { public: true },
    consoleUrl: `https://${R}.console.aws.amazon.com/redshiftv2/home?region=${R}#cluster-details?cluster=dw`, createdAt: Date.parse("2025-03-04T05:06:07.000Z"), observedAt: NOW,
  });
  assert.deepEqual(links.map((l) => [l.from, l.to, l.kind]), [
    [`arn:aws:kms:${R}:${ACCT}:key/k1`, resource.key, "encrypts"],
    [resource.key, `arn:aws:iam::${ACCT}:role/dw-copy`, "assumes"],
    [resource.key, `arn:aws:secretsmanager:${R}:${ACCT}:secret:redshift!dw-admin-AbCdEf`, "reads"],
    [`arn:aws:acm:${R}:${ACCT}:certificate/c1`, resource.key, "tls"],
  ]);
  const detail = clusterDetail(resource.key, dw);
  assert.deepEqual(detail.sections.map((s) => s.title), ["Cluster", "Network and security", "IAM roles"]);
  assert.deepEqual(detail.sections[2].table?.rows, [[`arn:aws:iam::${ACCT}:role/dw-copy`, "in-sync", "yes"]]);
  assert.ok(!JSON.stringify({ resource, links, detail }).includes(SENTINEL));
});

test("cluster health: paused is stopped; transitions warn; failures error", () => {
  const h = (ClusterStatus: string, ClusterAvailabilityStatus?: string) => clusterHealth({ ClusterStatus, ClusterAvailabilityStatus });
  assert.deepEqual(h("paused"), { health: "stopped", healthReason: "paused — compute isn't billed, storage is" });
  for (const s of ["resizing", "modifying", "rebooting", "resuming"]) assert.equal(h(s).health, "warning", s);
  for (const s of ["hardware-failure", "storage-full", "incompatible-network", "incompatible-hsm"]) assert.equal(h(s).health, "error", s);
  assert.equal(h("available", "Failed").health, "error");
  assert.equal(h("available", "Unavailable").health, "warning");
  assert.deepEqual(h("available", "Maintenance"), { health: "ok", healthReason: "maintenance" });
  assert.equal(h("deleting").health, "stopped");
  assert.deepEqual(clusterHealth({}), { health: "unknown", healthReason: "status not reported" });
});

const wg: RawWorkgroup = {
  workgroupId: "wg-1", workgroupArn: `arn:aws:redshift-serverless:${R}:${ACCT}:workgroup/wg-1`, workgroupName: "adhoc", namespaceName: "adhoc-ns", baseCapacity: 8, maxCapacity: 64,
  securityGroupIds: ["sg-dw"], subnetIds: ["subnet-a", "subnet-b"], status: "AVAILABLE", publiclyAccessible: false,
  endpoint: { address: "adhoc.123456789012.us-east-1.redshift-serverless.amazonaws.com", port: 5439, vpcEndpoints: [{ vpcEndpointId: "vpce-1", vpcId: "vpc-prod" }] },
  ...({ configParameters: [{ parameterKey: "search_path", parameterValue: SENTINEL }] } as object),
};
const ns: RawNamespace = {
  namespaceName: "adhoc-ns", dbName: "dev", kmsKeyId: "AWS_OWNED_KMS_KEY", logExports: ["userlog"],
  iamRoles: [`IamRole(applyStatus=in-sync, iamRoleArn=arn:aws:iam::${ACCT}:role/adhoc-s3)`], adminPasswordSecretArn: `arn:aws:secretsmanager:${R}:${ACCT}:secret:rs-admin-XyZ`,
  ...({ adminUsername: SENTINEL } as object),
};

test("Serverless workgroups join their namespace; tags fail closed; an AWS-owned key draws no link; an unread namespace says so", () => {
  const out = redshiftResult({ clusters: [], workgroups: [wg], namespaces: [ns], namespacesState: "ok" }, { region: R, account: ACCT });
  const [w] = out.resources;
  assert.deepEqual([w.key, w.kind, w.health, w.tagsUnread, w.vpcId, w.subnetIds, w.facts, w.aliases], [
    wg.workgroupArn, "redshift-workgroup", "ok", true, "vpc-prod", ["subnet-a", "subnet-b"], { public: false }, ["adhoc", "wg-1"],
  ]);
  assert.equal(w.props.find((p) => p.label === "Encryption")?.value, "AWS-owned key");
  assert.deepEqual(out.links.map((l) => [l.to, l.kind]), [[`arn:aws:iam::${ACCT}:role/adhoc-s3`, "assumes"], [`arn:aws:secretsmanager:${R}:${ACCT}:secret:rs-admin-XyZ`, "reads"]]);
  assert.deepEqual(workgroupDetail(w.key, wg, ns).sections.map((s) => s.title), ["Workgroup", "Namespace adhoc-ns"]);
  assert.ok(!JSON.stringify({ out, d: workgroupDetail(w.key, wg, ns) }).includes(SENTINEL));

  const denied = redshiftResult({ clusters: [], workgroups: [wg], namespacesState: "denied" }, { region: R, account: ACCT }).resources[0];
  assert.deepEqual(denied.enrichment, { namespace: "denied" });
  assert.equal(denied.props.find((p) => p.label === "Namespace")?.value, "adhoc-ns (details not read (denied))");
  assert.deepEqual(namespaceRoles({ iamRoles: [`arn:aws:iam::${ACCT}:role/plain`], defaultIamRoleArn: `arn:aws:iam::${ACCT}:role/plain` }), [`arn:aws:iam::${ACCT}:role/plain`]);
  assert.deepEqual(["AVAILABLE", "CREATING", "MODIFYING", "DELETING", undefined].map((status) => workgroupHealth({ status }).health), ["ok", "warning", "warning", "stopped", "unknown"]);
  // Serverless not read (denied or not offered here): the provisioned clusters stand alone.
  assert.equal(redshiftResult({ clusters: [dw] }, { region: R, account: ACCT }).resources.length, 1);
});
