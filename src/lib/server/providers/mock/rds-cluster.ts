// Simulated RDS clusters, proxies and the global database of the Acme account (names from ../mock-names.ts AURORA,
// RDS_PROXY), per region (the provider sets multiRegionMock), in the SDK's shapes so the real mapping runs.
// us-east-1: Aurora PostgreSQL acme-analytics (writer acme-analytics-1, reader acme-analytics-2) in production's private
// subnets, the primary of the global database acme-analytics-global; the proxy acme-production-pg-proxy in front of
// acme-production-pg (end-to-end IAM authentication, so no credentials secret). eu-west-1: the global database's
// secondary acme-analytics-eu (one reader, the application key's replica). Other regions: none. Read-only.
import type { RawDbCluster, RawGlobalCluster, RawProxy, RawSubnetGroup } from "../../../inventory/rds-cluster.ts";
import { ACCT, AURORA, EU, EU_REGION, EXISTING, KMS_KEYS, NETWORK, RDS_PROXY, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

const GLOBAL_ARN = `arn:aws:rds::${ACCT}:global-cluster:${AURORA.global.id}`;
const CA = (now: number) => ({ CAIdentifier: "rds-ca-rsa2048-g1", ValidTill: new Date(now + 300 * DAY) });

export function simClusters(region: string, now: number = Date.now()): RawDbCluster[] {
  if (region === REGION) {
    const c = AURORA.cluster;
    return [{
      DBClusterIdentifier: c.id, DBClusterArn: c.arn, DbClusterResourceId: "cluster-0ACME0ANALYTICS0PRIMARY01", Engine: c.engine, EngineVersion: "16.4", EngineMode: "provisioned",
      Status: "available", Endpoint: c.endpoint, ReaderEndpoint: c.readerEndpoint, CustomEndpoints: [], Port: 5432, MultiAZ: true, DatabaseName: "analytics",
      DBSubnetGroup: "acme-production-db", DBClusterParameterGroup: "default.aurora-postgresql16", VpcSecurityGroups: [{ VpcSecurityGroupId: EXISTING.securityGroups.prodDb, Status: "active" }],
      DBClusterMembers: [
        { DBInstanceIdentifier: c.members[0], IsClusterWriter: true, PromotionTier: 1 },
        { DBInstanceIdentifier: c.members[1], IsClusterWriter: false, PromotionTier: 1 },
      ],
      StorageEncrypted: true, KmsKeyId: KMS_KEYS.app.arn, DeletionProtection: true, BackupRetentionPeriod: 7, PreferredBackupWindow: "03:30-04:00",
      PreferredMaintenanceWindow: "sun:05:00-sun:05:30", ClusterCreateTime: new Date(now - 400 * DAY), StorageType: "aurora", IAMDatabaseAuthenticationEnabled: true,
      EnabledCloudwatchLogsExports: ["postgresql"], GlobalClusterIdentifier: AURORA.global.id, CertificateDetails: CA(now),
      TagList: [{ Key: "Environment", Value: "production" }, { Key: "team", Value: "data" }],
    }];
  }
  if (region === EU_REGION) {
    const s = EU.auroraSecondary;
    return [{
      DBClusterIdentifier: s.id, DBClusterArn: s.arn, DbClusterResourceId: "cluster-0ACME0ANALYTICS0EU0000001", Engine: AURORA.cluster.engine, EngineVersion: "16.4", EngineMode: "provisioned",
      Status: "available", Endpoint: `${s.id}.cluster-c0example.${EU_REGION}.rds.amazonaws.com`, ReaderEndpoint: `${s.id}.cluster-ro-c0example.${EU_REGION}.rds.amazonaws.com`,
      Port: 5432, MultiAZ: false, DBSubnetGroup: "acme-production-eu-db", DBClusterParameterGroup: "default.aurora-postgresql16",
      VpcSecurityGroups: [{ VpcSecurityGroupId: EU.securityGroups.db, Status: "active" }], DBClusterMembers: [{ DBInstanceIdentifier: s.members[0], IsClusterWriter: false, PromotionTier: 1 }],
      StorageEncrypted: true, KmsKeyId: KMS_KEYS.appReplica.arn, DeletionProtection: true, BackupRetentionPeriod: 7, PreferredBackupWindow: "02:30-03:00",
      PreferredMaintenanceWindow: "sun:06:00-sun:06:30", ClusterCreateTime: new Date(now - 120 * DAY), StorageType: "aurora", GlobalClusterIdentifier: AURORA.global.id,
      // No Environment tag: its VPC places it in eu-west-1's production environment, not the home one.
      CertificateDetails: CA(now), TagList: [{ Key: "team", Value: "data" }],
    }];
  }
  return [];
}

// DescribeDBSubnetGroups: the groups the simulated databases use (the instances' groups in ../../mock.ts too).
export function simSubnetGroups(region: string): RawSubnetGroup[] {
  const group = (name: string, vpc: string, subnets: string[]): RawSubnetGroup => ({ DBSubnetGroupName: name, VpcId: vpc, Subnets: subnets.map((s) => ({ SubnetIdentifier: s, SubnetStatus: "Active" })) });
  if (region === REGION)
    return [
      group("acme-production-db", NETWORK.production.vpc, NETWORK.production.privateSubnets),
      group("acme-staging-db", NETWORK.staging.vpc, NETWORK.staging.namedPrivateSubnets),
    ];
  if (region === EU_REGION) return [group("acme-production-eu-db", EU.vpc.id, EU.vpc.subnets)];
  return [];
}

export function simProxies(region: string, now: number = Date.now()): RawProxy[] {
  if (region !== REGION) return [];
  return [{
    DBProxyName: RDS_PROXY.name, DBProxyArn: RDS_PROXY.arn, Status: "available", EngineFamily: "POSTGRESQL", VpcId: NETWORK.production.vpc,
    VpcSecurityGroupIds: [EXISTING.securityGroups.prodDb], VpcSubnetIds: [...NETWORK.production.privateSubnets], DefaultAuthScheme: "IAM_AUTH", Auth: [],
    Endpoint: RDS_PROXY.endpoint, RequireTLS: true, IdleClientTimeout: 1800, DebugLogging: false, CreatedDate: new Date(now - 90 * DAY),
    targets: [{
      TargetArn: `arn:aws:rds:${REGION}:${ACCT}:db:${RDS_PROXY.target}`, Endpoint: EXISTING.rdsHost(RDS_PROXY.target), RdsResourceId: RDS_PROXY.target, Port: 5432,
      Type: "RDS_INSTANCE", Role: "READ_WRITE", TargetHealth: { State: "AVAILABLE" },
    }],
    enrichment: { targets: "ok" },
  }];
}

// DescribeGlobalClusters answers the same in every region: global databases are account-wide.
export function simGlobalClusters(region: string): RawGlobalCluster[] {
  if (region !== REGION && region !== EU_REGION) return [];
  return [{
    GlobalClusterIdentifier: AURORA.global.id, GlobalClusterArn: GLOBAL_ARN, Status: "available", Engine: AURORA.cluster.engine,
    GlobalClusterMembers: [
      { DBClusterArn: AURORA.cluster.arn, IsWriter: true, Readers: [AURORA.secondary.arn] },
      { DBClusterArn: AURORA.secondary.arn, IsWriter: false, SynchronizationStatus: "connected", Readers: [] },
    ],
  }];
}

// When each simulated cluster or proxy last served a connection (simulated metrics aren't read): all in use.
export const simLastConnection = (now: number = Date.now()) => now - 60_000;
