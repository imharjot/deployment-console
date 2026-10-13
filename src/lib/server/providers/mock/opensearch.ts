// Simulated OpenSearch Service domains of the Acme account (mock-names OPENSEARCH), per region (the provider sets
// multiRegionMock), in the SDK's shapes so the real mapping runs. us-east-1: acme-search, a VPC domain in production's
// private subnets behind the data tier's security group (the services it admits are the ones that search), two data
// nodes across two zones, encrypted with the application key, fine-grained access control on. Other regions: none.
import type { RawDomain } from "../../../inventory/opensearch.ts";
import { ACCT, EXISTING, KMS_KEYS, NETWORK, OPENSEARCH, REGION } from "../mock-names.ts";

export function simDomains(region: string): RawDomain[] {
  if (region !== REGION) return [];
  return [{
    DomainId: `${ACCT}/${OPENSEARCH.name}`, DomainName: OPENSEARCH.name, ARN: OPENSEARCH.arn, Created: true, Deleted: false, Endpoints: { vpc: OPENSEARCH.endpoint },
    Processing: false, UpgradeProcessing: false, DomainProcessingStatus: "Active", EngineVersion: "OpenSearch_2.17",
    ClusterConfig: { InstanceType: "r7g.large.search", InstanceCount: 2, DedicatedMasterEnabled: false, ZoneAwarenessEnabled: true, WarmEnabled: false, MultiAZWithStandbyEnabled: false },
    EBSOptions: { EBSEnabled: true, VolumeType: "gp3", VolumeSize: 100, Iops: 3000, Throughput: 125 },
    VPCOptions: { VPCId: NETWORK.production.vpc, SubnetIds: [...NETWORK.production.privateSubnets], AvailabilityZones: [`${REGION}a`, `${REGION}b`], SecurityGroupIds: [EXISTING.securityGroups.prodDb] },
    EncryptionAtRestOptions: { Enabled: true, KmsKeyId: KMS_KEYS.app.arn }, NodeToNodeEncryptionOptions: { Enabled: true },
    DomainEndpointOptions: { EnforceHTTPS: true, TLSSecurityPolicy: "Policy-Min-TLS-1-2-PFS-2023-10", CustomEndpointEnabled: false },
    AdvancedSecurityOptions: { Enabled: true, InternalUserDatabaseEnabled: false, AnonymousAuthEnabled: false },
    ServiceSoftwareOptions: { CurrentVersion: "OpenSearch_2_17_R20250610", NewVersion: "", UpdateAvailable: false, UpdateStatus: "COMPLETED" },
    tags: [{ Key: "Environment", Value: "production" }, { Key: "team", Value: "search" }], enrichment: { tags: "ok" },
  }];
}

// The storefront searches all day (simulated metrics aren't read).
export const simLastSearch = (now: number = Date.now()) => now - 60_000;
