// KMS keys provider: every KMS key in the region with its aliases, state, multi-Region role and rotation. Lists keys
// and aliases (aliases without a target key skipped), hands that to ctx.checkpoint, then reads per key through enrich()
// (R18): DescribeKey for the first 500 — softly, because a key policy can deny the console one key (CC-19) — rotation
// for customer symmetric keys and tags for the first 200 customer keys (a key whose tags weren't read is tagsUnread,
// R01). A key policy denial answers for that key only: the other keys are still read. AWS-managed keys are hidden but
// resolvable, so "alias/aws/sqs" still names a key. Read-only: no actions. The mapper is pure (../../inventory/kms.ts).
import "server-only";
import { DescribeKeyCommand, GetKeyRotationStatusCommand, KMSClient, ListAliasesCommand, ListKeysCommand, ListResourceTagsCommand } from "@aws-sdk/client-kms";
import { parseArn } from "../../inventory/arn.ts";
import type { EnrichState } from "../../inventory/types.ts";
import { aliasesByKey, isAwsManaged, kmsDetail, kmsResult, rotationApplies, type KmsKeyMetadata, type RawKmsKey } from "../../inventory/kms.ts";
import { simKms } from "./mock/kms.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import { deniedAction, type Provider, type ProviderContext } from "./types.ts";

const kms = perRegion((region) => new KMSClient(sdkConfig(region)), "kms");
const KEYS_PAGE = 1_000; // ListKeys takes up to 1,000 per page
const ALIASES_PAGE = 100; // ListAliases: at most 100 per page (the SDK model; KMS accepts more today, but that is undocumented)
const DESCRIBE_MAX = 500;
const TAGS_MAX = 200;

// Key policies allow or deny per key (CC-19). enrich() stops a whole kind of read after its first AccessDenied, so a
// denial is caught here and becomes that key's "denied" state; the remaining keys are still read. One note per kind.
type PerKey<R> = { ok: R } | { denied: string };
async function perKey<T, R>(ctx: ProviderContext, items: T[], o: { label: string; max: number; until: number }, fn: (item: T) => Promise<R>): Promise<{ results: (R | undefined)[]; state: EnrichState[] }> {
  const r = await enrich(ctx, items, o, async (item): Promise<PerKey<R>> => {
    try {
      return { ok: await fn(item) };
    } catch (e) {
      const action = deniedAction(e);
      if (action) return { denied: action };
      throw e;
    }
  });
  const denied = r.results.filter((x): x is { denied: string } => !!x && "denied" in x);
  if (denied.length) ctx.note(`${o.label}: ${denied.length.toLocaleString("en-US")} key${denied.length === 1 ? "" : "s"} refused ${denied[0].denied} (key policy or IAM)`);
  return {
    results: r.results.map((x) => (x && "ok" in x ? x.ok : undefined)),
    state: r.state.map((st, i): EnrichState => {
      const x = r.results[i];
      return x && "denied" in x ? "denied" : st;
    }),
  };
}

async function fetchKeys(ctx: ProviderContext): Promise<RawKmsKey[]> {
  const c = kms(ctx.region);
  const [keys, aliases] = await Promise.all([
    paged(ctx, "kms keys", async (Marker) => {
      const r = await c.send(new ListKeysCommand({ Limit: KEYS_PAGE, Marker }), t(ctx));
      return { items: r.Keys, next: r.Truncated ? r.NextMarker : undefined };
    }, { service: "kms" }),
    paged(ctx, "kms aliases", async (Marker) => {
      const r = await c.send(new ListAliasesCommand({ Limit: ALIASES_PAGE, Marker }), t(ctx));
      return { items: r.Aliases, next: r.Truncated ? r.NextMarker : undefined };
    }, { service: "kms" }),
  ]);
  const byKey = aliasesByKey(aliases);
  const base = keys.filter((k) => k.KeyId).map((k): RawKmsKey => ({ KeyId: k.KeyId, KeyArn: k.KeyArn, aliases: byKey.get(k.KeyId!) ?? [], enrichment: { describe: "skipped" } }));
  ctx.checkpoint?.(kmsResult(base, { region: ctx.region, account: ctx.accountId }));

  const until = budget();
  const described = await perKey(ctx, base, { label: "kms key details", max: DESCRIBE_MAX, until }, async (k) => (await c.send(new DescribeKeyCommand({ KeyId: k.KeyId }), t(ctx))).KeyMetadata as KmsKeyMetadata | undefined);
  const withMeta = base.map((k, i): RawKmsKey => ({ ...k, metadata: described.results[i], enrichment: { describe: described.state[i] } }));
  const rotating = withMeta.filter(rotationApplies);
  const customer = withMeta.filter((k) => k.metadata && !isAwsManaged(k));
  const [rotation, tags] = await Promise.all([
    perKey(ctx, rotating, { label: "kms key rotation", max: DESCRIBE_MAX, until }, async (k) => {
      const r = await c.send(new GetKeyRotationStatusCommand({ KeyId: k.KeyId }), t(ctx));
      return { KeyRotationEnabled: r.KeyRotationEnabled, RotationPeriodInDays: r.RotationPeriodInDays, NextRotationDate: r.NextRotationDate };
    }),
    perKey(ctx, customer, { label: "kms key tags", max: TAGS_MAX, until }, async (k) => (await c.send(new ListResourceTagsCommand({ KeyId: k.KeyId, Limit: 50 }), t(ctx))).Tags ?? []),
  ]);
  const rotationOf = new Map(rotating.map((k, i) => [k.KeyId, { value: rotation.results[i], state: rotation.state[i] }]));
  const tagsOfKey = new Map(customer.map((k, i) => [k.KeyId, { value: tags.state[i] === "ok" ? tags.results[i] : undefined, state: tags.state[i] }]));
  return withMeta.map((k) => {
    const r = rotationOf.get(k.KeyId);
    const tg = tagsOfKey.get(k.KeyId);
    return { ...k, rotation: r?.value, tags: tg?.value, enrichment: { ...k.enrichment, ...(r ? { rotation: r.state } : {}), ...(tg ? { tags: tg.state } : {}) } };
  });
}

async function realDetail(keyArn: string, aliases: string[], ctx: ProviderContext): Promise<RawKmsKey> {
  const region = parseArn(keyArn)?.region || ctx.region;
  const keyId = keyArn.split("/").pop() ?? keyArn;
  const c = kms(region);
  const metadata = (await c.send(new DescribeKeyCommand({ KeyId: keyArn }), t(ctx))).KeyMetadata as KmsKeyMetadata | undefined;
  const k: RawKmsKey = { KeyId: keyId, KeyArn: keyArn, aliases, metadata };
  const [rotation, tags] = await Promise.all([
    rotationApplies(k) ? softly(ctx, "kms key rotation", { service: "kms" })(() => c.send(new GetKeyRotationStatusCommand({ KeyId: keyArn }), t(ctx))) : undefined,
    metadata && !isAwsManaged(k) ? softly(ctx, "kms key tags", { service: "kms" })(() => c.send(new ListResourceTagsCommand({ KeyId: keyArn, Limit: 50 }), t(ctx))) : undefined,
  ]);
  return { ...k, ...(rotation ? { rotation: { KeyRotationEnabled: rotation.KeyRotationEnabled, RotationPeriodInDays: rotation.RotationPeriodInDays, NextRotationDate: rotation.NextRotationDate } } : {}), ...(tags ? { tags: tags.Tags ?? [] } : {}) };
}

export const kmsProvider: Provider = {
  id: "kms",
  label: "KMS keys",
  kinds: ["kms-key"],
  scope: "regional",
  covers: ["kms:key"],
  ttlMs: 30 * 60_000,
  multiRegionMock: true,
  read: ["kms:ListKeys", "kms:ListAliases", "kms:DescribeKey", "kms:GetKeyRotationStatus", "kms:ListResourceTags"],
  async discover(ctx) {
    const keys = ctx.mock ? simKms(ctx.region) : await fetchKeys(ctx);
    return kmsResult(keys, { region: ctx.region, account: ctx.accountId });
  },
  async detail(r, ctx) {
    const aliases = (r.aliases ?? []).filter((a) => a.startsWith("alias/"));
    const raw = ctx.mock ? simKms(parseArn(r.key)?.region || ctx.region).find((k) => k.KeyArn === r.key) : await realDetail(r.key, aliases, ctx);
    return kmsDetail(r.key, raw);
  },
};
