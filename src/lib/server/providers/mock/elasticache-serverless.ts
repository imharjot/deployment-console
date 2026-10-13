// Simulated ElastiCache Serverless caches of the Acme account (mock-names SERVERLESS_CACHE), per region (the provider
// sets multiRegionMock), in the SDK's shapes so the real mapping runs. us-east-1: acme-sessions-cache, the Valkey cache
// sessions moved to, in production's private subnets behind the Valkey security group, encrypted with the application
// key. Other regions: none.
import type { RawServerlessCache } from "../../../inventory/caches.ts";
import { EXISTING, KMS_KEYS, NETWORK, REGION, SERVERLESS_CACHE } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

export function simServerlessCaches(region: string, now: number = Date.now()): RawServerlessCache[] {
  if (region !== REGION) return [];
  const c = SERVERLESS_CACHE;
  return [{
    ServerlessCacheName: c.name, ARN: c.arn, Description: "Storefront sessions", CreateTime: new Date(now - 75 * DAY), Status: "available", Engine: "valkey",
    MajorEngineVersion: "8", FullEngineVersion: "8.0", CacheUsageLimits: { DataStorage: { Maximum: 10, Unit: "GB" }, ECPUPerSecond: { Maximum: 10_000 } },
    KmsKeyId: KMS_KEYS.app.arn, SecurityGroupIds: [EXISTING.securityGroups.prodValkey], SubnetIds: [...NETWORK.production.privateSubnets],
    Endpoint: { Address: c.endpoint, Port: 6379 }, ReaderEndpoint: { Address: c.readerEndpoint, Port: 6380 }, SnapshotRetentionLimit: 1, DailySnapshotTime: "04:00", NetworkType: "ipv4",
    tags: [{ Key: "Environment", Value: "production" }, { Key: "team", Value: "storefront" }], enrichment: { tags: "ok" },
  }];
}

// Sessions are read on every request (simulated metrics aren't read).
export const simLastUse = (now: number = Date.now()) => now - 60_000;
