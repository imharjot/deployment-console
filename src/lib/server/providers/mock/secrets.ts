// Simulated Secrets Manager metadata of the Acme account (names from ../mock-names.ts), as ListSecrets returns it: one
// secret per production ECS service (Stripe keys; read by the tasks through valueFrom), encrypted with the default
// aws/secretsmanager key; billing's rotates every 30 days. No values exist here — the ECS simulation (../../mock.ts) keeps
// those for the audited Variables editor. Only us-east-1 has secrets. Read-only.
import type { RawSecretDetail } from "../../../inventory/secrets.ts";
import { EXISTING, REGION } from "../mock-names.ts";
import { DAY, HOUR } from "./serverless-sim.ts";

export function simSecrets(region: string, now: number = Date.now()): RawSecretDetail[] {
  if (region !== REGION) return [];
  const today = new Date(Math.floor(now / DAY) * DAY); // LastAccessedDate has day precision
  const secret = (service: string, o: Partial<RawSecretDetail> = {}): RawSecretDetail => ({
    ARN: EXISTING.secretArn(service), Name: EXISTING.secretName(service), Description: `Payment keys for ${service} (production)`,
    LastChangedDate: new Date(now - 90 * DAY), LastAccessedDate: today, CreatedDate: new Date(now - 400 * DAY), RotationEnabled: false,
    Tags: [{ Key: "Environment", Value: "production" }, { Key: "Service", Value: service }],
    SecretVersionsToStages: { "0acme0v1-0000-4000-8000-000000000001": ["AWSCURRENT"], "0acme0v0-0000-4000-8000-000000000000": ["AWSPREVIOUS"] },
    ...o,
  });
  return [
    secret("api"),
    secret("worker"),
    secret("billing", {
      RotationEnabled: true, RotationRules: { AutomaticallyAfterDays: 30 }, LastRotatedDate: new Date(now - 12 * DAY), NextRotationDate: new Date(now + 18 * DAY),
      LastChangedDate: new Date(now - 12 * DAY - 2 * HOUR), Description: "Payment keys for billing (production), rotated monthly",
    }),
  ];
}
