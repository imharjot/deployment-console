// App Runner services, per region: status, URL, source (image or code repository), auto-deploy, instance size, VPC
// connector (subnets and security groups, for network edges), what each runs as and pulls from (instance and ECR access
// roles, the ECR repository, the KMS key) and runtime env values as mentions. The service list is handed over first;
// each service's details and tags follow within the time budget (R18). Actions: deploy again, pause and resume — each
// after a live read of the service's tags (R01).
import "server-only";
import {
  AppRunnerClient, DescribeServiceCommand, DescribeVpcConnectorCommand, ListOperationsCommand, ListServicesCommand, ListTagsForResourceCommand, PauseServiceCommand,
  ResumeServiceCommand, StartDeploymentCommand, type Service, type ServiceSummary,
} from "@aws-sdk/client-apprunner";
import { LIMITS } from "../../config.ts";
import { propOf } from "../../inventory/compute-common.ts";
import { apprunnerId, apprunnerResource, type AppRunnerView } from "../../inventory/compute-paas.ts";
import type { EnrichState, Link, Mention, Resource, ResourceDetail } from "../../inventory/types.ts";
import { HttpError } from "../errors.ts";
import { abortOpts, budget, call, enrich, ms, optional, regional, sdkConfig, tagMap } from "./compute-util.ts";
import { mockOperations, mockServices } from "./mock/apprunner.ts";
import { MOCK_REGION, mockApprunner } from "./mock/compute-state.ts";
import type { ActionContext, Provider, ProviderAction, ProviderContext } from "./types.ts";

const DETAIL_CAP = 300; // services discovery describes and reads tags of (1 call each)
const apprunner = regional((region) => new AppRunnerClient(sdkConfig(region)), "apprunner");
const apprunnerWrite = regional((region) => new AppRunnerClient(sdkConfig(region, { maxAttempts: 1 })), "apprunner"); // sent once (F31)
// A service is read and changed in its own region (its ARN says which).
const regionOf = (r: Resource, ctx: { region: string }) => (r.region && r.region !== "global" ? r.region : ctx.region);

function view(s: Service, net?: { subnets: string[]; sgs: string[] }): AppRunnerView {
  const img = s.SourceConfiguration?.ImageRepository;
  const code = s.SourceConfiguration?.CodeRepository;
  const values = code?.CodeConfiguration?.CodeConfigurationValues;
  const vars = img?.ImageConfiguration?.RuntimeEnvironmentVariables ?? values?.RuntimeEnvironmentVariables ?? {};
  return {
    name: s.ServiceName!, arn: s.ServiceArn!, status: s.Status ?? "UNKNOWN", url: s.ServiceUrl,
    source: {
      image: img?.ImageIdentifier, imageRepoType: img?.ImageRepositoryType, codeRepo: code?.RepositoryUrl, branch: code?.SourceCodeVersion?.Value,
      runtime: values?.Runtime, port: img?.ImageConfiguration?.Port ?? values?.Port,
    },
    autoDeploy: !!s.SourceConfiguration?.AutoDeploymentsEnabled, cpu: s.InstanceConfiguration?.Cpu, memory: s.InstanceConfiguration?.Memory,
    instanceRole: s.InstanceConfiguration?.InstanceRoleArn, accessRole: s.SourceConfiguration?.AuthenticationConfiguration?.AccessRoleArn,
    kmsKey: s.EncryptionConfiguration?.KmsKey, egress: s.NetworkConfiguration?.EgressConfiguration?.EgressType,
    vpcConnector: s.NetworkConfiguration?.EgressConfiguration?.VpcConnectorArn, publicIngress: s.NetworkConfiguration?.IngressConfiguration?.IsPubliclyAccessible,
    subnetIds: net?.subnets ?? [], securityGroups: net?.sgs ?? [], env: Object.entries(vars).map(([name, value]) => ({ name, value })),
    createdAt: ms(s.CreatedAt), updatedAt: ms(s.UpdatedAt),
  };
}

// What the list says about a service (details and tags not read yet).
const summaryView = (x: ServiceSummary): AppRunnerView => ({
  name: x.ServiceName!, arn: x.ServiceArn!, status: x.Status ?? "UNKNOWN", url: x.ServiceUrl, source: {}, subnetIds: [], securityGroups: [], env: [],
  createdAt: ms(x.CreatedAt), updatedAt: ms(x.UpdatedAt),
});

type Found = { views: AppRunnerView[]; state?: Record<string, EnrichState>[] };

async function servicesReal(ctx: ProviderContext, onList: (f: Found) => void): Promise<Found> {
  const c = apprunner(ctx.region);
  const list: ServiceSummary[] = [];
  let NextToken: string | undefined;
  do {
    const r = await call(ctx, (o) => c.send(new ListServicesCommand({ MaxResults: 20, NextToken }), o));
    list.push(...(r.ServiceSummaryList ?? []).filter((x) => x.Status !== "DELETED" && x.ServiceArn && x.ServiceName));
    NextToken = r.NextToken;
  } while (NextToken && list.length < ctx.cap);
  if (NextToken || list.length > ctx.cap) ctx.note(`apprunner: showing the first ${ctx.cap.toLocaleString("en-US")} services`);
  const summaries = list.slice(0, ctx.cap);
  onList({ views: summaries.map(summaryView) });

  const connectors = new Map<string, Promise<{ subnets: string[]; sgs: string[] } | undefined>>();
  const connector = (arn: string) => {
    if (!connectors.has(arn))
      connectors.set(arn, optional(ctx, "apprunner: VPC connectors", async () => {
        const v = (await call(ctx, (o) => c.send(new DescribeVpcConnectorCommand({ VpcConnectorArn: arn }), o))).VpcConnector;
        return { subnets: v?.Subnets ?? [], sgs: v?.SecurityGroups ?? [] };
      }, undefined));
    return connectors.get(arn)!;
  };
  const until = budget();
  const [details, tags] = await Promise.all([
    enrich(ctx, summaries, { label: "apprunner: service details", max: DETAIL_CAP, until }, async (x) => {
      const s = (await c.send(new DescribeServiceCommand({ ServiceArn: x.ServiceArn }), abortOpts(ctx.signal))).Service!;
      const arn = s.NetworkConfiguration?.EgressConfiguration?.VpcConnectorArn;
      return view(s, arn ? await connector(arn) : undefined);
    }),
    enrich(ctx, summaries, { label: "apprunner: tags", max: DETAIL_CAP, until }, async (x) => tagMap((await c.send(new ListTagsForResourceCommand({ ResourceArn: x.ServiceArn }), abortOpts(ctx.signal))).Tags)),
  ]);
  const views = summaries.map((x, i) => {
    const v = details.results[i] ?? summaryView(x);
    return tags.state[i] === "ok" ? { ...v, tags: tags.results[i] ?? {} } : v;
  });
  return { views, state: summaries.map((_, i) => ({ details: details.state[i], tags: tags.state[i] })) };
}

async function discover(ctx: ProviderContext) {
  const region = ctx.region;
  const build = (f: Found) => {
    const resources: Resource[] = [], links: Link[] = [], mentions: Mention[] = [];
    f.views.forEach((s, i) => {
      const m = apprunnerResource(s, region, ctx.accountId, f.state?.[i]);
      resources.push(m.resource);
      links.push(...m.links);
      mentions.push(...m.mentions);
    });
    return { resources, links, mentions };
  };
  if (ctx.mock) return build({ views: region === MOCK_REGION ? mockServices() : [] }); // the simulated service is in the home region
  // R18: the list first; details and tags within the time budget.
  return build(await servicesReal(ctx, (f) => ctx.checkpoint?.(build(f))));
}

// R01: the service's tags, read live right before an action.
async function authoritative(r: Resource, ctx: ActionContext): Promise<{ tags: Record<string, string> }> {
  if (ctx.mock) {
    const s = mockServices().find((x) => x.arn === r.key);
    if (!s) throw new HttpError(404, `App Runner service ${r.name} not found`);
    return { tags: { ...(s.tags ?? {}) } };
  }
  return { tags: tagMap((await apprunner(regionOf(r, ctx)).send(new ListTagsForResourceCommand({ ResourceArn: r.key }), abortOpts())).Tags) };
}

async function detail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  const ops = ctx.mock
    ? mockOperations().map((o) => ({ type: o.type, status: o.status, started: o.startedAt, ended: o.endedAt }))
    : ((await call(ctx, (o) => apprunner(regionOf(r, ctx)).send(new ListOperationsCommand({ ServiceArn: r.key, MaxResults: 10 }), o))).OperationSummaryList ?? []).map((o) => ({
        type: o.Type ?? "", status: o.Status ?? "", started: ms(o.StartedAt), ended: ms(o.EndedAt),
      }));
  const iso = (t?: number) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "");
  return {
    key: r.key,
    sections: [{ title: "Recent operations", table: { columns: ["Started", "Operation", "Status", "Ended"], rows: ops.map((o) => [iso(o.started), o.type, o.status, iso(o.ended)]) }, note: ops.length ? undefined : "No operations recorded." }],
  };
}

// ---------- actions ----------

async function liveStatus(r: Resource, ctx: ActionContext): Promise<string> {
  if (ctx.mock) return mockServices().find((s) => s.arn === r.key)?.status ?? "UNKNOWN";
  return (await apprunner(regionOf(r, ctx)).send(new DescribeServiceCommand({ ServiceArn: r.key }), abortOpts())).Service?.Status ?? "UNKNOWN";
}

type Op = "start-deployment" | "pause" | "resume";
const NEEDS: Record<Op, string> = { "start-deployment": "RUNNING", pause: "RUNNING", resume: "PAUSED" };
const statusProblem = (op: Op, status: string) => (status === NEEDS[op] ? undefined : status === "OPERATION_IN_PROGRESS" ? "an operation is in progress — wait for it to finish" : `service is ${status.toLowerCase()}${op === "resume" ? " (only a paused service resumes)" : ""}`);

async function checked(op: Op, r: Resource, ctx: ActionContext) {
  const s = await liveStatus(r, ctx);
  const msg = statusProblem(op, s);
  if (msg) throw new HttpError(409, msg);
}

const COMMAND: Record<Op, string> = { "start-deployment": "StartDeployment", pause: "PauseService", resume: "ResumeService" };

interface Text { title: string; summary: string; description: string; undo: string; verifies: string; retrySafe: boolean }
function action(op: Op, perm: "act" | "power", t: Text, plan: (r: Resource) => { summary: string; warnings: string[] }): ProviderAction {
  return {
    id: op, kind: "apprunner", title: t.title, summary: t.summary, description: t.description, risk: "change", perm,
    iam: [`apprunner:${COMMAND[op]}`], undo: t.undo, verifies: t.verifies, retrySafe: t.retrySafe,
    input: { type: "object", additionalProperties: false, properties: {} },
    when: (r) => statusProblem(op, propOf(r, "Status") ?? "UNKNOWN"),
    async plan(r, _i, ctx) {
      await checked(op, r, ctx);
      const p = plan(r);
      return { summary: p.summary, changes: [`${COMMAND[op]} ${r.name}`], warnings: p.warnings };
    },
    async run(r, _i, ctx) {
      await checked(op, r, ctx);
      if (ctx.mock) return { service: r.name, ...mockApprunner(op === "start-deployment" ? "START_DEPLOYMENT" : op === "pause" ? "PAUSE_SERVICE" : "RESUME_SERVICE") };
      const c = apprunnerWrite(regionOf(r, ctx));
      const ServiceArn = r.key;
      const o = { abortSignal: AbortSignal.timeout(LIMITS.awsWriteTimeoutMs) };
      const res =
        op === "start-deployment" ? await c.send(new StartDeploymentCommand({ ServiceArn }), o)
        : op === "pause" ? await c.send(new PauseServiceCommand({ ServiceArn }), o)
        : await c.send(new ResumeServiceCommand({ ServiceArn }), o);
      return { service: r.name, operationId: res.OperationId ?? "" };
    },
  };
}

const sourceOf = (r: Resource) => propOf(r, "Source") ?? "its source";
const actions = [
  action("start-deployment", "act", {
    title: "Deploy again",
    summary: "Deploys this service again from its configured image tag or branch.",
    description: "Starts a new App Runner deployment (StartDeployment): pulls the configured image tag again, or builds the latest commit of the configured branch. Refuses unless the service is RUNNING. Returns the operation id.",
    undo: "No one-step undo: point the source back at the previous image or commit and deploy again",
    verifies: "The deployment operation SUCCEEDED and the service is RUNNING",
    retrySafe: false, // each call starts another deployment
  }, (r) => ({
    summary: `Redeploy ${r.name} from ${sourceOf(r)}`,
    warnings: [sourceOf(r).startsWith("image") ? "An image source redeploys the same tag: only useful when the tag was pushed again." : "Builds and deploys the branch's latest commit.", "Traffic moves to the new instances once they pass health checks."],
  })),
  action("pause", "power", {
    title: "Pause service",
    summary: "Pauses this service: it stops serving and stops paying for compute until resumed.",
    description: "Pauses a running App Runner service (PauseService): it stops serving requests and stops accruing compute and memory charges until resumed. Returns the operation id.",
    undo: "Resume the service",
    verifies: "The service is PAUSED",
    retrySafe: true, // pausing a paused service is refused, nothing more happens
  }, (r) => ({ summary: `Pause ${r.name}`, warnings: ["Its URL answers with errors until it is resumed."] })),
  action("resume", "power", {
    title: "Resume service",
    summary: "Resumes this paused service.",
    description: "Resumes a paused App Runner service (ResumeService). Returns the operation id.",
    undo: "Pause the service again",
    verifies: "The service is RUNNING",
    retrySafe: true,
  }, (r) => ({ summary: `Resume ${r.name}`, warnings: ["Compute and memory charges start again."] })),
];

export const apprunnerProvider: Provider = {
  id: "apprunner",
  label: "App Runner",
  scope: "regional",
  multiRegionMock: true,
  kinds: ["apprunner"],
  covers: ["apprunner:service"],
  read: ["apprunner:ListServices", "apprunner:DescribeService", "apprunner:ListTagsForResource", "apprunner:DescribeVpcConnector", "apprunner:ListOperations"],
  write: ["apprunner:StartDeployment", "apprunner:PauseService", "apprunner:ResumeService"],
  discover,
  authoritative,
  // R20: requests show it is used (documented dimensions ServiceName + ServiceID).
  activity: (r) => [{ namespace: "AWS/AppRunner", metric: "Requests", dims: { ServiceName: r.name, ServiceID: apprunnerId(r.key) }, stat: "Sum", label: "Requests", required: true }],
  detail,
  actions,
};
