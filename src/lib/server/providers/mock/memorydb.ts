// Simulated MemoryDB clusters of the Acme account (mock-names MEMORYDB), per region (the provider sets
// multiRegionMock), in the SDK's shapes so the real mapping runs. us-east-1: acme-ratelimits, a one-shard Multi-AZ
// Valkey cluster the API's rate limiter keeps its counters in, TLS on, encrypted with the application key. Other
// regions: none.
import type { RawMemoryDbCluster } from "../../../inventory/caches.ts";
import { EXISTING, KMS_KEYS, MEMORYDB, REGION } from "../mock-names.ts";

export function simMemoryDb(region: string): RawMemoryDbCluster[] {
  if (region !== REGION) return [];
  return [{
    Name: MEMORYDB.name, ARN: MEMORYDB.arn, Description: "API rate-limit counters", Status: "available", NumberOfShards: 1,
    Shards: [{ Name: "0001", Status: "available", NumberOfNodes: 2 }], AvailabilityMode: "multiaz", ClusterEndpoint: { Address: MEMORYDB.endpoint, Port: 6379 },
    NodeType: "db.r7g.large", Engine: "valkey", EngineVersion: "7.3", ParameterGroupName: "default.memorydb-valkey7",
    SecurityGroups: [{ SecurityGroupId: EXISTING.securityGroups.prodValkey, Status: "active" }], SubnetGroupName: "acme-production-memorydb", TLSEnabled: true,
    KmsKeyId: KMS_KEYS.app.arn, SnapshotRetentionLimit: 7, SnapshotWindow: "05:00-06:00", MaintenanceWindow: "sun:06:00-sun:07:00", ACLName: "acme-ratelimits-acl",
    DataTiering: "false", tags: [{ Key: "Environment", Value: "production" }, { Key: "team", Value: "platform" }], enrichment: { tags: "ok" },
  }];
}

// The rate limiter counts every API request (simulated metrics aren't read).
export const simLastUse = (now: number = Date.now()) => now - 60_000;
