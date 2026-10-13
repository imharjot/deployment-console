// Amplify Hosting provider: Amplify apps with the hosts every branch and custom domain answers on, their latest builds
// and domain status. ListApps (100 per page; tags come with it), checkpoint, then per app through enrich() (R18, first
// 300): ListBranches and ListDomainAssociations (50 per page), then ListJobs (the latest job) for up to 25 branches —
// the production branch first, then the most recently updated. environmentVariables (app, auto-branch settings and
// branches) are kept only as Mention refs; basicAuthCredentials and build specs from ListApps AND ListBranches are
// dropped here, before anything else sees them. Read-only: no actions, no activity series (lastActivityAt = the newest
// job). The mapper is pure (../../inventory/app-platforms.ts).
import "server-only";
import { AmplifyClient, ListAppsCommand, ListBranchesCommand, ListDomainAssociationsCommand, ListJobsCommand } from "@aws-sdk/client-amplify";
import { parseArn } from "../../inventory/arn.ts";
import {
  amplifyDetail, amplifyResult, productionBranchOf, type RawAmplifyApp, type RawAmplifyBranch, type RawAmplifyDomain, type RawAmplifyJob,
} from "../../inventory/app-platforms.ts";
import type { EnrichState } from "../../inventory/types.ts";
import { simAmplify } from "./mock/amplify.ts";
import { budget, enrich, paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const amplify = perRegion((region) => new AmplifyClient(sdkConfig(region)), "amplify");
const DETAIL_MAX = 300;
const BRANCH_PAGES = 4; // up to 200 branches per app
const JOBS_BRANCHES = 25; // latest job of at most this many branches per app

const regionOf = (arn: string, fallback: string) => parseArn(arn)?.region || fallback;
const notFound = (e: unknown) => /NotFound/.test((e as { name?: string })?.name ?? "");
const denied = (e: unknown) => /AccessDenied|Unauthorized|not authorized/i.test(`${(e as { name?: string })?.name} ${(e as { message?: string })?.message}`);
const stateOf = (e: unknown): EnrichState => (denied(e) ? "denied" : "error");

// ListApps' App without its secrets: basicAuthCredentials, build specs and the auto-branch template's credentials never
// leave this function; environment variables are kept for mentions only.
type SdkApp = RawAmplifyApp & { createTime?: Date; updateTime?: Date; autoBranchCreationConfig?: { environmentVariables?: Record<string, string> } };
const app = (a: SdkApp): RawAmplifyApp => ({
  appId: a.appId, appArn: a.appArn, name: a.name, platform: a.platform, repository: a.repository, defaultDomain: a.defaultDomain, tags: a.tags ?? {},
  iamServiceRoleArn: a.iamServiceRoleArn, computeRoleArn: a.computeRoleArn, environmentVariables: a.environmentVariables, enableBasicAuth: a.enableBasicAuth,
  enableBranchAutoBuild: a.enableBranchAutoBuild, autoBranchCreationConfig: a.autoBranchCreationConfig?.environmentVariables ? { environmentVariables: a.autoBranchCreationConfig.environmentVariables } : undefined,
  productionBranch: a.productionBranch ? { branchName: a.productionBranch.branchName, status: a.productionBranch.status, lastDeployTime: a.productionBranch.lastDeployTime } : undefined,
  wafConfiguration: a.wafConfiguration?.webAclArn ? { webAclArn: a.wafConfiguration.webAclArn, wafStatus: a.wafConfiguration.wafStatus } : undefined,
});
// ListBranches' Branch without basicAuthCredentials or its build spec.
const branch = (b: RawAmplifyBranch): RawAmplifyBranch => ({
  branchArn: b.branchArn, branchName: b.branchName, displayName: b.displayName, stage: b.stage, framework: b.framework, updateTime: b.updateTime, customDomains: b.customDomains,
  enableAutoBuild: b.enableAutoBuild, enableBasicAuth: b.enableBasicAuth, environmentVariables: b.environmentVariables, backend: b.backend?.stackArn ? { stackArn: b.backend.stackArn } : undefined,
  computeRoleArn: b.computeRoleArn,
});
const domain = (d: RawAmplifyDomain): RawAmplifyDomain => ({
  domainName: d.domainName, domainStatus: d.domainStatus, statusReason: d.statusReason,
  subDomains: (d.subDomains ?? []).map((s) => ({ subDomainSetting: s.subDomainSetting, verified: s.verified })), certificate: d.certificate ? { type: d.certificate.type, customCertificateArn: d.certificate.customCertificateArn } : undefined,
});

async function branchesOf(region: string, appId: string, ctx: ProviderContext): Promise<{ branches: RawAmplifyBranch[]; more: boolean }> {
  const out: RawAmplifyBranch[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < BRANCH_PAGES; page++) {
    const r = await amplify(region).send(new ListBranchesCommand({ appId, maxResults: 50, nextToken }), t(ctx));
    out.push(...(r.branches ?? []).map((b) => branch(b as RawAmplifyBranch)));
    nextToken = r.nextToken;
    if (!nextToken) break;
  }
  return { branches: out, more: !!nextToken };
}

async function domainsOf(region: string, appId: string, ctx: ProviderContext): Promise<RawAmplifyDomain[]> {
  const r = await amplify(region).send(new ListDomainAssociationsCommand({ appId, maxResults: 50 }), t(ctx));
  return (r.domainAssociations ?? []).map((d) => domain(d as RawAmplifyDomain));
}

const latestJob = async (region: string, appId: string, branchName: string, ctx: ProviderContext): Promise<RawAmplifyJob | undefined> => {
  const j = (await amplify(region).send(new ListJobsCommand({ appId, branchName, maxResults: 1 }), t(ctx))).jobSummaries?.[0];
  return j ? { jobId: j.jobId, status: j.status, jobType: j.jobType, commitId: j.commitId, startTime: j.startTime, endTime: j.endTime } : undefined;
};

// Branches, domains and the latest jobs of one app. A failed branch or domain read keeps the rest (states per read).
async function readApp(region: string, a: RawAmplifyApp, ctx: ProviderContext): Promise<Partial<RawAmplifyApp>> {
  const appId = a.appId!;
  const [b, d] = await Promise.all([
    branchesOf(region, appId, ctx).then((x) => ({ ok: x }), (e: unknown) => ({ e })),
    domainsOf(region, appId, ctx).then((x) => ({ ok: x }), (e: unknown) => ({ e })),
  ]);
  if ("e" in b && notFound(b.e)) throw b.e; // deleted since the list: enrich() treats it as an answer
  const enrichment: Record<string, EnrichState> = { branches: "ok" in b ? "ok" : stateOf(b.e), domains: "ok" in d ? "ok" : notFound(d.e) ? "ok" : stateOf(d.e) };
  const out: Partial<RawAmplifyApp> = { ...("ok" in b ? { branches: b.ok.branches, branchesMore: b.ok.more } : {}), ...("ok" in d ? { domains: d.ok } : notFound(d.e) ? { domains: [] } : {}) };
  // Jobs: the production branch first, then the most recently updated.
  const prod = productionBranchOf({ ...a, ...out });
  const names = "ok" in b
    ? [...b.ok.branches].sort((x, y) => Number(y.branchName === prod) - Number(x.branchName === prod) || +new Date(y.updateTime ?? 0) - +new Date(x.updateTime ?? 0)).map((x) => x.branchName!).filter(Boolean)
    : prod ? [prod] : [];
  const jobs: Record<string, RawAmplifyJob | undefined> = {};
  let jobState: EnrichState = names.length > JOBS_BRANCHES ? "capped" : "ok";
  for (const name of names.slice(0, JOBS_BRANCHES)) {
    if (ctx.signal.aborted) {
      jobState = "skipped";
      break;
    }
    try {
      jobs[name] = await latestJob(region, appId, name, ctx);
    } catch (e) {
      if (notFound(e)) continue;
      jobState = stateOf(e);
      break;
    }
  }
  return { ...out, jobs, enrichment: { ...enrichment, jobs: jobState } };
}

async function fetchApps(ctx: ProviderContext): Promise<RawAmplifyApp[]> {
  const list = await paged(ctx, "amplify apps", async (nextToken) => {
    const r = await amplify(ctx.region).send(new ListAppsCommand({ maxResults: 100, nextToken }), t(ctx));
    return { items: r.apps, next: r.nextToken };
  }, { service: "amplify" });
  const base = list.filter((a) => a.appId && a.appArn).map((a): RawAmplifyApp => ({ ...app(a as SdkApp), enrichment: { branches: "skipped", domains: "skipped", jobs: "skipped" } }));
  ctx.checkpoint?.(amplifyResult(base, { region: ctx.region, account: ctx.accountId }));
  const r = await enrich(ctx, base, { label: "amplify branches and domains", max: DETAIL_MAX, until: budget() }, (a) => readApp(ctx.region, a, ctx));
  const notes = new Set<string>();
  const out = base.map((a, i) => {
    if (r.state[i] !== "ok") return { ...a, enrichment: { branches: r.state[i], domains: r.state[i], jobs: r.state[i] } };
    const got = r.results[i] ?? {};
    for (const [what, s] of Object.entries(got.enrichment ?? {})) if (s === "denied" || s === "error") notes.add(`amplify ${what}: ${s === "denied" ? "denied" : "not read"} for some apps`);
    return { ...a, ...got };
  });
  for (const n of notes) ctx.note(n);
  return out;
}

export const amplifyProvider: Provider = {
  id: "amplify",
  label: "Amplify Hosting",
  kinds: ["amplify-app"],
  scope: "regional",
  covers: ["amplify:apps"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["amplify:ListApps", "amplify:ListBranches", "amplify:ListDomainAssociations", "amplify:ListJobs"],
  async discover(ctx) {
    return amplifyResult(ctx.mock ? simAmplify(ctx.region) : await fetchApps(ctx), { region: ctx.region, account: ctx.accountId });
  },
  async detail(r, ctx) {
    const region = regionOf(r.key, ctx.region);
    if (ctx.mock) return amplifyDetail(r.key, simAmplify(region).find((a) => a.appArn === r.key));
    const appId = parseArn(r.key)?.id ?? r.aliases?.[0];
    if (!appId) return amplifyDetail(r.key, undefined);
    // The default domain is the one every branch host shares ("<branch>.<defaultDomain>").
    const defaultDomain = r.endpoints?.find((h) => h.endsWith(".amplifyapp.com"))?.split(".").slice(1).join(".");
    const prod = r.props.find((p) => p.label === "Production branch")?.value;
    try {
      return amplifyDetail(r.key, { appId, appArn: r.key, defaultDomain, ...(prod ? { productionBranch: { branchName: prod } } : {}), ...(await readApp(region, { appId, productionBranch: prod ? { branchName: prod } : undefined }, ctx)) });
    } catch (e) {
      if (notFound(e)) return amplifyDetail(r.key, undefined);
      throw e;
    }
  },
};
