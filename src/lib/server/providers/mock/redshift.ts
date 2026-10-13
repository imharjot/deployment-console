// Simulated Redshift of the Acme account (mock-names REDSHIFT), per region (the provider sets multiRegionMock), in the
// SDK's shapes so the real mapping runs. us-east-1: the provisioned warehouse acme-analytics-dw, paused for weeks
// (stopped: compute isn't billed, storage is), and the Serverless workgroup acme-adhoc that analysts query ad hoc,
// whose namespace is encrypted with the application key. Both in production's private subnets. Other regions: none.
import type { RawNamespace, RawRedshiftCluster, RawWorkgroup } from "../../../inventory/redshift.ts";
import { ACCT, EXISTING, KMS_KEYS, NETWORK, REDSHIFT, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

const NAMESPACE_ID = "0acme0b2-4444-4555-8666-000000000002";

export function simClusters(region: string, now: number = Date.now()): RawRedshiftCluster[] {
  if (region !== REGION) return [];
  const c = REDSHIFT.cluster;
  return [{
    ClusterIdentifier: c.id, NodeType: "ra3.xlplus", NumberOfNodes: 2, ClusterStatus: c.state, ClusterAvailabilityStatus: "Unavailable", ModifyStatus: "", DBName: "analytics",
    Endpoint: { Address: `${c.id}.c0example.${REGION}.redshift.amazonaws.com`, Port: 5439 }, ClusterCreateTime: new Date(now - 500 * DAY), AutomatedSnapshotRetentionPeriod: 1,
    VpcSecurityGroups: [{ VpcSecurityGroupId: EXISTING.securityGroups.prodDb, Status: "active" }], ClusterSubnetGroupName: "acme-production-redshift", VpcId: NETWORK.production.vpc,
    AvailabilityZone: `${REGION}a`, PreferredMaintenanceWindow: "sun:07:00-sun:07:30", ClusterVersion: "1.0", PubliclyAccessible: false, Encrypted: true, KmsKeyId: KMS_KEYS.app.arn,
    EnhancedVpcRouting: false, MultiAZ: "Disabled", Tags: [{ Key: "Environment", Value: "production" }, { Key: "team", Value: "data" }], IamRoles: [],
    TotalStorageCapacityInMegaBytes: 2 * 32 * 1024 * 1024, PendingActions: [],
    ...({ MasterUsername: "awsuser", ClusterNamespaceArn: `arn:aws:redshift:${REGION}:${ACCT}:namespace:0acme0b2-4444-4555-8666-0000000000c1` } as object),
  }];
}

export function simWorkgroups(region: string, now: number = Date.now()): RawWorkgroup[] {
  if (region !== REGION) return [];
  const w = REDSHIFT.workgroup;
  return [{
    workgroupId: w.id, workgroupArn: w.arn, workgroupName: w.name, namespaceName: w.name, baseCapacity: 8, maxCapacity: 64, enhancedVpcRouting: false,
    securityGroupIds: [EXISTING.securityGroups.prodDb], subnetIds: [...NETWORK.production.privateSubnets], status: "AVAILABLE",
    endpoint: { address: `${w.name}.${ACCT}.${REGION}.redshift-serverless.amazonaws.com`, port: 5439, vpcEndpoints: [{ vpcEndpointId: "vpce-0acme0rsserverless1", vpcId: NETWORK.production.vpc }] },
    publiclyAccessible: false, creationDate: new Date(now - 150 * DAY), workgroupVersion: "1.0.120000",
  }];
}

export function simNamespaces(region: string, now: number = Date.now()): RawNamespace[] {
  if (region !== REGION) return [];
  return [{
    namespaceArn: `arn:aws:redshift-serverless:${REGION}:${ACCT}:namespace/${NAMESPACE_ID}`, namespaceId: NAMESPACE_ID, namespaceName: REDSHIFT.workgroup.name, dbName: "adhoc",
    kmsKeyId: KMS_KEYS.app.arn, iamRoles: [], logExports: ["userlog", "connectionlog"], status: "AVAILABLE", creationDate: new Date(now - 150 * DAY),
    ...({ adminUsername: "admin" } as object),
  }];
}

// The paused warehouse hasn't served a query in weeks; the ad-hoc workgroup ran one this morning.
export const simLastQuery = (id: string, now: number = Date.now()) => (id === REDSHIFT.cluster.id ? now - 40 * DAY : now - 3 * 3_600_000);
