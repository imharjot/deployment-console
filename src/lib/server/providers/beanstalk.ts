// Elastic Beanstalk environments, per region: status and health (color + enhanced-health cause), version, platform,
// CNAME, where they run (VPC, subnets, security groups from their settings), the instance profile and service role they
// run as, links to the Auto Scaling group, instances, load balancer and worker queue Beanstalk created, and environment
// properties as mentions (values stay server-side). The environment list is handed over first; each environment's
// resources, settings, tags and health cause follow within the time budget (R18). Actions: deploy an existing
// application version, restart the app server — each after a live read of the environment's tags (R01).
import "server-only";
import {
  DescribeApplicationVersionsCommand, DescribeApplicationsCommand, DescribeConfigurationSettingsCommand, DescribeEnvironmentHealthCommand,
  DescribeEnvironmentResourcesCommand, DescribeEnvironmentsCommand, DescribeEventsCommand, ElasticBeanstalkClient, ListTagsForResourceCommand,
  RestartAppServerCommand, UpdateEnvironmentCommand, type EnvironmentDescription,
} from "@aws-sdk/client-elastic-beanstalk";
import { LIMITS } from "../../config.ts";
import { prop, propOf } from "../../inventory/compute-common.ts";
import { beanstalkResource, versionProblem, type BeanstalkResources, type BeanstalkView, type OptionSetting } from "../../inventory/compute-paas.ts";
import type { EnrichState, Link, Mention, Resource, ResourceDetail } from "../../inventory/types.ts";
import { HttpError, errText } from "../errors.ts";
import { abortOpts, budget, call, enrich, ms, optional, regional, sdkConfig, tagMap } from "./compute-util.ts";
import { field } from "./edge-util.ts";
import { mockEnvironments, mockEvents, mockVersions } from "./mock/beanstalk.ts";
import { MOCK_REGION, mockBeanstalk } from "./mock/compute-state.ts";
import { deniedAction, type ActionContext, type Provider, type ProviderAction, type ProviderContext } from "./types.ts";

const DETAIL_CAP = 300; // environments whose resources, settings and tags discovery reads (3–4 calls each)
const eb = regional((region) => new ElasticBeanstalkClient(sdkConfig(region)), "elasticbeanstalk");
const ebWrite = regional((region) => new ElasticBeanstalkClient(sdkConfig(region, { maxAttempts: 1 })), "elasticbeanstalk"); // sent once (F31)
const writeOpts = () => ({ abortSignal: AbortSignal.timeout(LIMITS.awsWriteTimeoutMs) });
// An environment is read and changed in its own region (its ARN says which).
const regionOf = (r: Resource, ctx: { region: string }) => (r.region && r.region !== "global" ? r.region : ctx.region);
const NO_RESOURCES: BeanstalkResources = { autoScalingGroups: [], instances: [], loadBalancers: [], queues: [] };

function baseView(e: EnvironmentDescription): Omit<BeanstalkView, "tags" | "resources" | "options" | "cause"> {
  return {
    name: e.EnvironmentName!, id: e.EnvironmentId!, arn: e.EnvironmentArn!, app: e.ApplicationName ?? "", status: e.Status ?? "Unknown", health: e.Health,
    healthStatus: e.HealthStatus, version: e.VersionLabel, platform: e.SolutionStackName ?? e.PlatformArn?.split("/").slice(-2).join(" "), tier: e.Tier?.Name,
    cname: e.CNAME, endpointUrl: e.EndpointURL, createdAt: ms(e.DateCreated), updatedAt: ms(e.DateUpdated),
  };
}

type Found = { views: BeanstalkView[]; versions: Map<string, number>; state?: Record<string, EnrichState>[] };

async function environmentsReal(ctx: ProviderContext, onList: (f: Found) => void): Promise<Found> {
  const c = eb(ctx.region);
  const envs: EnvironmentDescription[] = [];
  let NextToken: string | undefined;
  do {
    const r = await call(ctx, (o) => c.send(new DescribeEnvironmentsCommand({ IncludeDeleted: false, MaxRecords: 1000, NextToken }), o));
    envs.push(...(r.Environments ?? []).filter((e) => e.Status !== "Terminated"));
    NextToken = r.NextToken;
  } while (NextToken && envs.length < ctx.cap);
  if (NextToken || envs.length > ctx.cap) ctx.note(`beanstalk: showing the first ${ctx.cap.toLocaleString("en-US")} environments`);
  const list = envs.slice(0, ctx.cap);
  // R18: the environments first (resources, settings and tags not read yet).
  onList({ views: list.map((e) => ({ ...baseView(e), resources: NO_RESOURCES, options: [] })), versions: new Map() });

  const apps = await optional(ctx, "beanstalk: applications", async () => (await call(ctx, (o) => c.send(new DescribeApplicationsCommand({}), o))).Applications ?? [], []);
  const versions = new Map(apps.map((a) => [a.ApplicationName ?? "", a.Versions?.length ?? 0]));
  const until = budget();
  // The settings are a second read per environment: one that fails (or is denied) loses the placement, roles and env
  // mentions of that environment, never its resources. Noted once.
  let settingsNoted = false;
  const settings = (e: EnvironmentDescription) =>
    c.send(new DescribeConfigurationSettingsCommand({ ApplicationName: e.ApplicationName, EnvironmentName: e.EnvironmentName }), abortOpts(ctx.signal))
      .then((x): OptionSetting[] => x.ConfigurationSettings?.[0]?.OptionSettings ?? [])
      .catch((err: unknown): OptionSetting[] => {
        if (ctx.signal.aborted) throw err;
        if (!settingsNoted) {
          settingsNoted = true;
          const denied = deniedAction(err);
          ctx.note(denied ? `beanstalk: configuration settings not shown — the console's role lacks ${denied}` : `beanstalk: configuration settings not shown (${errText(err)})`);
        }
        return [];
      });
  const [details, tags] = await Promise.all([
    enrich(ctx, list, { label: "beanstalk: environment resources", max: DETAIL_CAP, until }, async (e) => {
      const [res, opts, cause] = await Promise.all([
        c.send(new DescribeEnvironmentResourcesCommand({ EnvironmentId: e.EnvironmentId }), abortOpts(ctx.signal)).then(({ EnvironmentResources: r }): BeanstalkResources => ({
          autoScalingGroups: (r?.AutoScalingGroups ?? []).map((x) => x.Name!).filter(Boolean), instances: (r?.Instances ?? []).map((x) => x.Id!).filter(Boolean),
          loadBalancers: (r?.LoadBalancers ?? []).map((x) => x.Name!).filter(Boolean), queues: (r?.Queues ?? []).map((q) => ({ name: q.Name, url: q.URL })),
        })),
        settings(e),
        // Enhanced health only (basic-health environments answer InvalidRequest): the first cause explains a Yellow/Red.
        e.Health && e.Health !== "Green"
          ? c.send(new DescribeEnvironmentHealthCommand({ EnvironmentId: e.EnvironmentId, AttributeNames: ["Causes"] }), abortOpts(ctx.signal)).then((h) => h.Causes?.[0]).catch(() => undefined)
          : undefined,
      ]);
      return { resources: res, options: opts, cause };
    }),
    enrich(ctx, list, { label: "beanstalk: tags", max: DETAIL_CAP, until }, async (e) =>
      tagMap((await c.send(new ListTagsForResourceCommand({ ResourceArn: e.EnvironmentArn }), abortOpts(ctx.signal))).ResourceTags)),
  ]);
  const views = list.map((e, i): BeanstalkView => ({
    ...baseView(e), resources: details.results[i]?.resources ?? NO_RESOURCES, options: details.results[i]?.options ?? [], cause: details.results[i]?.cause,
    ...(tags.state[i] === "ok" ? { tags: tags.results[i] ?? {} } : {}),
  }));
  return { views, versions, state: list.map((_, i) => ({ details: details.state[i], tags: tags.state[i] })) };
}

async function discover(ctx: ProviderContext) {
  const region = ctx.region;
  const build = (f: Found) => {
    const resources: Resource[] = [], links: Link[] = [], mentions: Mention[] = [];
    f.views.forEach((v, i) => {
      const m = beanstalkResource(v, region, ctx.accountId, f.state?.[i], ctx.home);
      const n = f.versions.get(v.app);
      if (n) m.resource.props.push(prop("Versions available", n)!);
      resources.push(m.resource);
      links.push(...m.links);
      mentions.push(...m.mentions);
    });
    return { resources, links, mentions };
  };
  if (ctx.mock) {
    if (region !== MOCK_REGION) return build({ views: [], versions: new Map() }); // the simulated environment is in the home region
    return build({ views: mockEnvironments(), versions: new Map([[mockEnvironments()[0].app, mockVersions().length]]) });
  }
  return build(await environmentsReal(ctx, (f) => ctx.checkpoint?.(build(f))));
}

// R01: the environment's tags, read live right before an action.
async function authoritative(r: Resource, ctx: ActionContext): Promise<{ tags: Record<string, string> }> {
  if (ctx.mock) {
    const e = mockEnvironments().find((x) => x.arn === r.key);
    if (!e) throw new HttpError(404, `environment ${r.name} not found`);
    return { tags: { ...(e.tags ?? {}) } };
  }
  return { tags: tagMap((await eb(regionOf(r, ctx)).send(new ListTagsForResourceCommand({ ResourceArn: r.key }), abortOpts())).ResourceTags) };
}

// ---------- detail ----------

interface Version { label: string; description?: string; status?: string; createdAt?: number }

async function versionsOf(app: string, ctx: { mock: boolean; region: string }, labels?: string[]): Promise<Version[]> {
  if (ctx.mock) return mockVersions().filter((v) => !labels || labels.includes(v.label));
  const r = await eb(ctx.region).send(new DescribeApplicationVersionsCommand({ ApplicationName: app, VersionLabels: labels, MaxRecords: labels ? undefined : 15 }), abortOpts());
  return (r.ApplicationVersions ?? []).map((v) => ({ label: v.VersionLabel ?? "", description: v.Description, status: v.Status, createdAt: ms(v.DateCreated) }));
}

const iso = (t?: number) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "");

async function detail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  const app = propOf(r, "Application") ?? "";
  const current = propOf(r, "Version");
  const region = regionOf(r, ctx);
  const [versions, events] = await Promise.all([
    versionsOf(app, { mock: ctx.mock, region }),
    ctx.mock
      ? mockEvents()
      : call(ctx, (o) => eb(region).send(new DescribeEventsCommand({ EnvironmentName: r.name, MaxRecords: 15 }), o)).then((x) =>
          (x.Events ?? []).map((e) => ({ at: ms(e.EventDate) ?? 0, severity: e.Severity ?? "", message: e.Message ?? "" }))),
  ]);
  return {
    key: r.key,
    sections: [
      { title: "Application versions", table: { columns: ["Version", "Created", "Status", "Description"], rows: versions.map((v) => [`${v.label}${v.label === current ? " (deployed)" : ""}`, iso(v.createdAt), v.status ?? "", (v.description ?? "").slice(0, 120)]) } },
      { title: "Recent events", table: { columns: ["Time", "Severity", "Message"], rows: events.map((e) => [iso(e.at), e.severity, e.message.slice(0, 200)]) } },
    ],
  };
}

// ---------- actions ----------

async function liveEnv(r: Resource, ctx: ActionContext): Promise<{ id: string; app: string; status: string; version?: string }> {
  const id = propOf(r, "Environment id") ?? "";
  if (ctx.mock) {
    const v = mockEnvironments().find((e) => e.id === id);
    if (!v) throw new HttpError(404, `environment ${r.name} not found`);
    return { id, app: v.app, status: v.status, version: v.version };
  }
  const e = (await eb(regionOf(r, ctx)).send(new DescribeEnvironmentsCommand({ EnvironmentIds: [id] }), abortOpts())).Environments?.[0];
  if (!e || e.Status === "Terminated") throw new HttpError(404, `environment ${r.name} not found`);
  return { id, app: e.ApplicationName ?? "", status: e.Status ?? "Unknown", version: e.VersionLabel };
}

const readyProblem = (status: string) => (status === "Ready" ? undefined : `environment is ${status.toLowerCase()} — wait until it is Ready`);

async function deploymentPolicy(r: Resource, app: string, ctx: ActionContext): Promise<string | undefined> {
  if (ctx.mock) return "AllAtOnce";
  const s = await eb(regionOf(r, ctx))
    .send(new DescribeConfigurationSettingsCommand({ ApplicationName: app, EnvironmentName: r.name }), abortOpts())
    .catch(() => undefined);
  return s?.ConfigurationSettings?.[0]?.OptionSettings?.find((o) => o.Namespace === "aws:elasticbeanstalk:command" && o.OptionName === "DeploymentPolicy")?.Value;
}

type DeployIn = { versionLabel: string };
async function checkDeploy(r: Resource, i: DeployIn, ctx: ActionContext) {
  const e = await liveEnv(r, ctx);
  const msg = readyProblem(e.status) ?? versionProblem(i.versionLabel, await versionsOf(e.app, { mock: ctx.mock, region: regionOf(r, ctx) }, [i.versionLabel]), e.version);
  if (msg) throw new HttpError(409, msg);
  return e;
}

const deployVersion: ProviderAction<DeployIn> = {
  id: "deploy-version", kind: "beanstalk", title: "Deploy version",
  summary: "Rolls out an application version that already exists to this environment, by its deployment policy.",
  description: "Deploys an existing application version to the environment (UpdateEnvironment with VersionLabel), rolled out by the environment's deployment policy. Refuses unless the environment is Ready, the version exists and has been processed, and it isn't already deployed. Returns the environment and version.",
  risk: "change", perm: "act",
  iam: ["elasticbeanstalk:UpdateEnvironment"],
  undo: "Deploy the previous version the same way (the panel lists the versions)",
  verifies: "The environment is Ready again, running the new version, with health Green",
  retrySafe: true, // a version that is already deployed is refused
  input: {
    type: "object", additionalProperties: false, required: ["versionLabel"],
    properties: { versionLabel: field({ type: "string", title: "Application version", minLength: 1, maxLength: 100, description: "An application version label (see the panel's Application versions)." }) },
  },
  when: (r) => readyProblem(propOf(r, "Status") ?? "Unknown"),
  async plan(r, i, ctx) {
    const e = await checkDeploy(r, i, ctx);
    const policy = await deploymentPolicy(r, e.app, ctx);
    return {
      summary: `Deploy ${i.versionLabel} to ${r.name} (now ${e.version ?? "no version"})`,
      changes: [`UpdateEnvironment ${e.id} VersionLabel=${i.versionLabel}`],
      warnings: [
        policy === "AllAtOnce" || !policy ? "Deployment policy AllAtOnce: every instance switches at once — expect a short outage." : `Deployment policy ${policy}.`,
        "Roll back by deploying the previous version the same way.",
      ],
    };
  },
  async run(r, i, ctx) {
    const e = await checkDeploy(r, i, ctx);
    if (ctx.mock) return { environment: r.name, version: i.versionLabel, ...mockBeanstalk({ deploy: i.versionLabel }) };
    const res = await ebWrite(regionOf(r, ctx)).send(new UpdateEnvironmentCommand({ EnvironmentId: e.id, VersionLabel: i.versionLabel }), writeOpts());
    return { environment: r.name, version: i.versionLabel, requestId: res.$metadata.requestId ?? "" };
  },
};

const restartAppServer: ProviderAction = {
  id: "restart-app-server", kind: "beanstalk", title: "Restart app server",
  summary: "Restarts the app server on every instance of this environment; the instances themselves stay.",
  description: "Restarts the application server (web server / app process) on every instance of the environment (RestartAppServer); instances are not replaced. Refuses unless the environment is Ready. Returns the environment and request id.",
  risk: "change", perm: "act",
  iam: ["elasticbeanstalk:RestartAppServer"],
  undo: "Nothing to undo — the same version starts again",
  verifies: "The environment is Ready again with health Green",
  retrySafe: false, // each call restarts the servers again
  input: { type: "object", additionalProperties: false, properties: {} },
  when: (r) => readyProblem(propOf(r, "Status") ?? "Unknown"),
  async plan(r, _i, ctx) {
    const e = await liveEnv(r, ctx);
    const msg = readyProblem(e.status);
    if (msg) throw new HttpError(409, msg);
    return { summary: `Restart the app server on every instance of ${r.name}`, changes: [`RestartAppServer ${e.id}`], warnings: ["Requests fail briefly on each instance while its server restarts."] };
  },
  async run(r, _i, ctx) {
    const e = await liveEnv(r, ctx);
    const msg = readyProblem(e.status);
    if (msg) throw new HttpError(409, msg);
    if (ctx.mock) return { environment: r.name, ...mockBeanstalk({ restart: true }) };
    const res = await ebWrite(regionOf(r, ctx)).send(new RestartAppServerCommand({ EnvironmentId: e.id }), writeOpts());
    return { environment: r.name, requestId: res.$metadata.requestId ?? "" };
  },
};

export const beanstalkProvider: Provider = {
  id: "beanstalk",
  label: "Elastic Beanstalk",
  scope: "regional",
  multiRegionMock: true,
  kinds: ["beanstalk"],
  covers: ["elasticbeanstalk:environment"],
  read: [
    "elasticbeanstalk:DescribeEnvironments", "elasticbeanstalk:DescribeApplications", "elasticbeanstalk:DescribeEnvironmentResources", "elasticbeanstalk:DescribeConfigurationSettings",
    "elasticbeanstalk:DescribeEnvironmentHealth", "elasticbeanstalk:ListTagsForResource", "elasticbeanstalk:DescribeApplicationVersions", "elasticbeanstalk:DescribeEvents",
  ],
  write: ["elasticbeanstalk:UpdateEnvironment", "elasticbeanstalk:RestartAppServer"],
  // Beanstalk answers DescribeEnvironmentResources from the environment's CloudFormation stack, with the caller's rights.
  implicit: ["cloudformation:DescribeStackResources"],
  discover,
  authoritative,
  // R20: the instances' CPU (AWS/EC2 by the environment's Auto Scaling group) shows it is used.
  activity: (r) => {
    const group = propOf(r, "Auto Scaling group");
    return group ? [{ namespace: "AWS/EC2", metric: "CPUUtilization", dims: { AutoScalingGroupName: group }, stat: "Average", label: "CPU % (instances)", required: true }] : [];
  },
  detail,
  actions: [deployVersion as ProviderAction, restartAppServer],
};
