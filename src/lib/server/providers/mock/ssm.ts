// Simulated Parameter Store metadata of the Acme account (names from ../mock-names.ts and the ECS simulation's
// valueFrom references), as DescribeParameters returns it, per region: each production service's JWT signing key
// (SecureString, the application KMS key). us-east-1: api, worker, billing; eu-west-1: the eu api and worker (the key's
// replica there). Other regions: none. No values exist here — ../../mock.ts keeps those for the audited Variables
// editor. Read-only.
import type { RawParameter } from "../../../inventory/ssm.ts";
import { ACCT, EU_REGION, EXISTING, KMS_KEYS, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

const param = (region: string, name: string, now: number, o: Partial<RawParameter> = {}): RawParameter => ({
  Name: name, ARN: `arn:aws:ssm:${region}:${ACCT}:parameter/${name.replace(/^\/+/, "")}`, Type: "SecureString", KeyId: KMS_KEYS.app.alias, Tier: "Standard", Version: 3, DataType: "text",
  LastModifiedDate: new Date(now - 60 * DAY), LastModifiedUser: `arn:aws:iam::${ACCT}:user/acme-ci`, Description: "JWT signing key", Policies: [], ...o,
});

export function simSsm(region: string, now: number = Date.now()): RawParameter[] {
  if (region === EU_REGION) return ["api", "worker"].map((s) => param(EU_REGION, `/acme/production-eu/${s}/JWT_SIGNING_KEY`, now, { Version: 1, LastModifiedDate: new Date(now - 120 * DAY) }));
  if (region !== REGION) return [];
  return ["api", "worker", "billing"].map((s) => param(REGION, EXISTING.ssmParameter(s), now));
}

// Tags as ListTagsForResource returns them (the panel's only extra read).
export const simSsmTags = (name: string) => [{ Key: "Environment", Value: name.includes("/production-eu/") || name.includes("/production/") ? "production" : "shared" }];
