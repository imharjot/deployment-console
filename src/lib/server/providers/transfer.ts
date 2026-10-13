// Transfer Family provider: SFTP / FTPS / FTP / AS2 servers, the hosts they answer on (their own and the custom hostname
// tag), their identity provider, users' home buckets and file systems, and logs. ListServers (1,000 per page),
// checkpoint, then DescribeServer and ListUsers per server through enrich() (R18, first 300; tags come with
// DescribeServer — a server it didn't answer for is tagsUnread, R01). Users are read for names, home directories and
// roles only (never SSH key bodies or session policies). Read-only: no actions. Activity: AWS/Transfer BytesIn and
// BytesOut {ServerId} (required, R20). The mapper is pure (../../inventory/app-platforms.ts).
import "server-only";
import { DescribeServerCommand, ListServersCommand, ListUsersCommand, TransferClient } from "@aws-sdk/client-transfer";
import { parseArn } from "../../inventory/arn.ts";
import { transferDetail, transferResult, type RawTransferServer, type RawTransferUser } from "../../inventory/app-platforms.ts";
import { errText } from "../errors.ts";
import { simTransfer } from "./mock/transfer.ts";
import { budget, enrich, paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const transfer = perRegion((region) => new TransferClient(sdkConfig(region)), "transfer");
const DESCRIBE_MAX = 300;
const USERS_PAGES = 2; // up to 2,000 users per server

const regionOf = (arn: string, fallback: string) => parseArn(arn)?.region || fallback;
const notFound = (e: unknown) => /NotFound/.test((e as { name?: string })?.name ?? "");

// DescribeServer, the fields the mapper reads (banners, host key fingerprints and workflow details stay out).
async function describe(region: string, id: string, ctx: ProviderContext): Promise<Partial<RawTransferServer>> {
  const s = (await transfer(region).send(new DescribeServerCommand({ ServerId: id }), t(ctx))).Server;
  if (!s) return {};
  return {
    Arn: s.Arn, ServerId: s.ServerId, State: s.State, Domain: s.Domain, EndpointType: s.EndpointType, IdentityProviderType: s.IdentityProviderType, LoggingRole: s.LoggingRole,
    UserCount: s.UserCount, Certificate: s.Certificate, Protocols: s.Protocols, SecurityPolicyName: s.SecurityPolicyName, StructuredLogDestinations: s.StructuredLogDestinations,
    EndpointDetails: s.EndpointDetails, Tags: s.Tags ?? [], described: true,
    IdentityProviderDetails: s.IdentityProviderDetails ? { Url: s.IdentityProviderDetails.Url, InvocationRole: s.IdentityProviderDetails.InvocationRole, DirectoryId: s.IdentityProviderDetails.DirectoryId, Function: s.IdentityProviderDetails.Function } : undefined,
  };
}

async function users(region: string, id: string, ctx: ProviderContext): Promise<{ users: RawTransferUser[]; more: boolean }> {
  const out: RawTransferUser[] = [];
  let NextToken: string | undefined;
  for (let page = 0; page < USERS_PAGES; page++) {
    const r = await transfer(region).send(new ListUsersCommand({ ServerId: id, MaxResults: 1000, NextToken }), t(ctx));
    out.push(...(r.Users ?? []).map((u) => ({ UserName: u.UserName, Arn: u.Arn, HomeDirectory: u.HomeDirectory, HomeDirectoryType: u.HomeDirectoryType, Role: u.Role, SshPublicKeyCount: u.SshPublicKeyCount })));
    NextToken = r.NextToken;
    if (!NextToken) break;
  }
  return { users: out, more: !!NextToken };
}

// DescribeServer and ListUsers for one server: the describe decides; users are best effort (their state is kept, and a
// denial is noted once per run through `noted`).
async function read(region: string, id: string, ctx: ProviderContext, noted = new Set<string>()): Promise<Partial<RawTransferServer>> {
  const [d, u] = await Promise.all([describe(region, id, ctx), users(region, id, ctx).then((x) => ({ ok: x }), (e: unknown) => ({ e }))]);
  if ("ok" in u) return { ...d, users: u.ok.users, usersMore: u.ok.more, enrichment: { describe: "ok", users: "ok" } };
  if (notFound(u.e)) return { ...d, enrichment: { describe: "ok", users: "ok" } };
  const denied = /AccessDenied|not authorized/i.test(`${(u.e as { name?: string })?.name} ${(u.e as { message?: string })?.message}`);
  const why = denied ? "transfer users skipped: transfer:ListUsers denied" : `transfer users: ${errText(u.e)}`;
  if (!noted.has(denied ? "denied" : "error")) ctx.note(why);
  noted.add(denied ? "denied" : "error");
  return { ...d, enrichment: { describe: "ok", users: denied ? "denied" : "error" } };
}

async function fetchServers(ctx: ProviderContext): Promise<RawTransferServer[]> {
  const list = await paged(ctx, "transfer servers", async (NextToken) => {
    const r = await transfer(ctx.region).send(new ListServersCommand({ MaxResults: 1000, NextToken }), t(ctx));
    return { items: r.Servers, next: r.NextToken };
  }, { service: "transfer" });
  const base = list.filter((s) => s.Arn && s.ServerId).map((s): RawTransferServer => ({
    Arn: s.Arn, ServerId: s.ServerId, State: s.State, Domain: s.Domain, EndpointType: s.EndpointType, IdentityProviderType: s.IdentityProviderType, LoggingRole: s.LoggingRole,
    UserCount: s.UserCount, enrichment: { describe: "skipped" },
  }));
  const now = Date.now();
  ctx.checkpoint?.(transferResult(base, { region: ctx.region, account: ctx.accountId, now }));
  const noted = new Set<string>();
  const r = await enrich(ctx, base, { label: "transfer server details", max: DESCRIBE_MAX, until: budget() }, (s) => read(ctx.region, s.ServerId!, ctx, noted));
  return base.map((s, i) => (r.state[i] === "ok" && r.results[i] ? { ...s, ...r.results[i] } : { ...s, enrichment: { describe: r.state[i] } }));
}

export const transferProvider: Provider = {
  id: "transfer",
  label: "Transfer Family",
  kinds: ["transfer-server"],
  scope: "regional",
  covers: ["transfer:server"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["transfer:ListServers", "transfer:DescribeServer", "transfer:ListUsers"],
  async discover(ctx) {
    return transferResult(ctx.mock ? simTransfer(ctx.region) : await fetchServers(ctx), { region: ctx.region, account: ctx.accountId, now: Date.now() });
  },
  activity: (r) => {
    // The id from the ARN (the key is authoritative; aliases are merged with other sources' names).
    const id = parseArn(r.key)?.id ?? r.aliases?.[0];
    if (!id) return [];
    const region = regionOf(r.key, r.region);
    return [
      { namespace: "AWS/Transfer", metric: "BytesIn", dims: { ServerId: id }, stat: "Sum", label: "Bytes in", region, required: true },
      { namespace: "AWS/Transfer", metric: "BytesOut", dims: { ServerId: id }, stat: "Sum", label: "Bytes out", region, required: true },
    ];
  },
  async detail(r, ctx) {
    const region = regionOf(r.key, ctx.region);
    if (ctx.mock) return transferDetail(r.key, simTransfer(region).find((s) => s.Arn === r.key));
    const id = parseArn(r.key)?.id ?? r.aliases?.[0];
    if (!id) return transferDetail(r.key, undefined);
    try {
      return transferDetail(r.key, { ServerId: id, ...(await read(region, id, ctx)) });
    } catch (e) {
      if (notFound(e)) return transferDetail(r.key, undefined);
      throw e;
    }
  },
};
