// Secrets Manager provider: secrets' METADATA only — name, description, KMS key, rotation, last access, deletion
// schedule, tags. All of it comes from ListSecrets (IncludePlannedDeletion, 100 per page); DescribeSecret runs only when a
// panel opens. This file never imports GetSecretValue or BatchGetSecretValue: values reach a browser only through the
// audited Variables editor (aws.ts). Read-only: no actions. The mapper is pure (../../inventory/secrets.ts).
import "server-only";
import { DescribeSecretCommand, ListSecretsCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { parseArn } from "../../inventory/arn.ts";
import { secretsDetail, secretsResult, type RawSecret, type RawSecretDetail } from "../../inventory/secrets.ts";
import { simSecrets } from "./mock/secrets.ts";
import { paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const sm = perRegion((region) => new SecretsManagerClient(sdkConfig(region)), "secretsmanager");

async function fetchSecrets(ctx: ProviderContext): Promise<RawSecret[]> {
  const c = sm(ctx.region);
  return paged<RawSecret>(ctx, "secrets", async (NextToken) => {
    const r = await c.send(new ListSecretsCommand({ IncludePlannedDeletion: true, MaxResults: 100, NextToken }), t(ctx));
    return { items: r.SecretList, next: r.NextToken };
  }, { service: "secretsmanager" });
}

export const secretsProvider: Provider = {
  id: "secrets",
  label: "Secrets Manager",
  kinds: ["secret"],
  scope: "regional",
  covers: ["secretsmanager:secret"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["secretsmanager:ListSecrets", "secretsmanager:DescribeSecret"],
  async discover(ctx) {
    const secrets = ctx.mock ? simSecrets(ctx.region) : await fetchSecrets(ctx);
    return secretsResult(secrets, { now: Date.now() });
  },
  // DescribeSecret: metadata and version stages, never a value.
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    if (ctx.mock) return secretsDetail(r.key, simSecrets(region).find((s) => s.ARN === r.key));
    // A secret deleted for good since the map was built answers ResourceNotFoundException: the panel says it's gone.
    const d = await sm(region).send(new DescribeSecretCommand({ SecretId: r.key }), t(ctx)).catch((e: unknown) => ((e as { name?: string })?.name === "ResourceNotFoundException" ? undefined : Promise.reject(e)));
    return secretsDetail(r.key, d as RawSecretDetail | undefined);
  },
};
