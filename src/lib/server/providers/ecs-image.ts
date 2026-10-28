// "Deploy image" for ECS services on the cloud map. No resources of its own (the ecs provider lists the services):
// registers a revision identical to the live task definition except one container's image, then points the service
// at it (a rolling deployment). Refuses the console's own service, a service mid-rollout, and anything but a full
// image URI with a tag or digest from an allowed registry (provisioning.allowedImageRegistries). The service is read
// and changed in its own region: its key says which ("ecs:service/<cluster>/<service>@eu-west-1" outside home), and
// cluster names can repeat across regions.
// R04: the action locks the canonical ECS service (the same key a console restart or a variable save takes), re-reads
// the service under that lock, and refuses when its task definition moved on since the plan the person reviewed (the
// plan's revision comes back as `expectedRevision`; without it, the last plan made for exactly this change counts).
// R01: the service's tags are read live (ecs:ListTagsForResource) right before the change.
import "server-only";
import { ECSClient, ListTagsForResourceCommand } from "@aws-sdk/client-ecs";
import { parseImageRef } from "../../discover.ts";
import { arnOf, parseArn } from "../../inventory/arn.ts";
import { imageProblem, limitsOf } from "../../provision.ts";
import type { Resource } from "../../inventory/types.ts";
import { cached, invalidate } from "../cache.ts";
import { consoleConfig, inRegion, listEnvs, metaOf, servicesOf } from "../discovery.ts";
import { HttpError } from "../errors.ts";
import type { Plan } from "../ops/types.ts";
import { cloudFor, getCloud } from "../sources.ts";
import { abortOpts, regional, sdkConfig, tagMap } from "./compute-util.ts";
import { field } from "./edge-util.ts";
import type { ActionContext, Provider, ProviderAction } from "./types.ts";

type In = { image: string; container?: string; expectedRevision?: number };
type Where = { cluster: string; region: string };

const ecs = regional((region) => new ECSClient(sdkConfig(region)), "ecs");
const servicesIn = (env: Where) => servicesOf(env.cluster, env.region);
const invalidateServices = (env: Where) => invalidate(`svc:${inRegion(env.cluster, env.region)}`);
const KEY = /^ecs:service\/([^/@]+)\/([^/@]+)(?:@([a-z0-9-]+))?$/;

async function facts(r: Resource, i: In, ctx: ActionContext) {
  const m = KEY.exec(r.key);
  if (!m) throw new HttpError(400, "not an ECS service");
  const [, cluster, service, at] = m;
  const region = at ?? ctx.region;
  const env = (await listEnvs()).find((e) => e.cluster === cluster && e.region === region);
  if (!env) throw new HttpError(404, `cluster ${cluster} in ${region} isn't an environment the console discovered`);
  invalidateServices(env);
  const live = (await servicesIn(env)).find((s) => s.name === service);
  if (!live) throw new HttpError(404, `service "${service}" not found in ${cluster}`);
  if ((await metaOf(env, live)).self) throw new HttpError(409, "This is the console itself — it never deploys to its own service.");
  if (live.deployments.some((d) => d.rolloutState === "IN_PROGRESS")) throw new HttpError(409, "a rollout is in progress — wait for it to finish");
  const td = live.taskDef;
  if (!td) throw new HttpError(409, "the service has no task definition to copy");
  const container = i.container ?? td.main;
  const c = td.containers.find((x) => x.name === container);
  if (!c) throw new HttpError(400, `no container "${container}" in ${td.family}:${td.revision} (containers: ${td.containers.map((x) => x.name).join(", ")})`);
  // Without an explicit allowlist, a new image must come from where the container already pulls: the same registry
  // host (ECR, ghcr.io…), or — for Docker Hub references without a host — the same repository. A deploy runs that code
  // with the service's role and every secret its task definition injects.
  const allowed = limitsOf(consoleConfig().config.provisioning).allowedImageRegistries;
  const bad = allowed ? imageProblem(i.image, allowed) : imageProblem(i.image) ?? sameSourceProblem(c.image, i.image);
  if (bad) throw new HttpError(400, bad);
  if (c.image === i.image) throw new HttpError(409, `${container} already runs ${i.image}`);
  return { env, cluster, service, live, td, container, current: c.image };
}

// "host/…" when the first path part is a registry host (has a dot or port, or is localhost); else Docker Hub.
const registryHost = (image: string) => {
  const first = image.split("/")[0];
  return image.includes("/") && (/[.:]/.test(first) || first === "localhost") ? first : undefined;
};
const repositoryOf = (image: string) => image.replace(/@sha256:[0-9a-f]+$/, "").replace(/:[\w.-]+$/, "");
export function sameSourceProblem(current: string, next: string): string | undefined {
  const host = registryHost(current);
  if (host) return registryHost(next) === host ? undefined : `the new image must come from ${host}, like the current one (or list registries in provisioning.allowedImageRegistries)`;
  return repositoryOf(next) === repositoryOf(current) ? undefined : `the new image must be another tag of ${repositoryOf(current)}, like the current one (or list registries in provisioning.allowedImageRegistries)`;
}

// R04: refuse when the live task definition isn't the one the plan was made against. undefined = deploy.
export function staleRevisionProblem(expected: number | undefined, live: { family: string; revision: number }): string | undefined {
  if (expected === undefined || expected === live.revision) return undefined;
  return `task definition changed since the plan (rev ${expected} → ${live.revision}) — re-plan`;
}

// The revision the last plan for exactly this change (service, container, image) saw — the fallback when a confirmation
// doesn't send `expectedRevision` back (a client that doesn't echo the plan). On globalThis: routes and the worker share it.
const PLAN_TTL_MS = 60 * 60_000;
const PLAN_MAX = 500; // bounded like the other globalThis stores: the oldest plans go first
const g = globalThis as { __ecsImagePlans?: Map<string, { revision: number; family: string; at: number }> };
const plans = () => (g.__ecsImagePlans ??= new Map());
const planKey = (r: Resource, container: string, image: string) => `${r.key}|${container}|${image}`;
function remember(key: string, td: { family: string; revision: number }) {
  const now = Date.now();
  for (const [k, v] of plans()) if (now - v.at > PLAN_TTL_MS) plans().delete(k);
  plans().delete(key); // re-inserted last: Map order is age order
  while (plans().size >= PLAN_MAX) plans().delete(plans().keys().next().value!);
  plans().set(key, { revision: td.revision, family: td.family, at: now });
}
function recalled(key: string, family: string): number | undefined {
  const p = plans().get(key);
  return p && p.family === family && Date.now() - p.at <= PLAN_TTL_MS ? p.revision : undefined;
}

// A tag the console's own ECR doesn't have would fail to pull: say so in the plan (not a refusal — another account's
// registry or a digest can't be checked here).
export async function tagWarning(image: string, region: string): Promise<string | undefined> {
  const ref = parseImageRef(image);
  if (!ref.ecr || !ref.tag || ref.digest || ref.region !== region) return undefined;
  const cloud = await getCloud(region);
  try {
    const tags = (await cached(`ecr:${inRegion(ref.repository, region)}`, 60_000, () => cloud.imageTags(ref.repository))).value;
    return tags.has(ref.tag) ? undefined : `Tag ${ref.tag} isn't in ECR repository ${ref.repository} (yet) — tasks would fail to pull it.`;
  } catch {
    return `Couldn't check that ${ref.repository}:${ref.tag} exists in ECR.`;
  }
}

// R01: the service's tags as ECS has them now. The service ARN (long format) is built from the cluster's account; a
// service created before the long ARN format can't carry tags at all, which ECS answers with InvalidParameterException.
async function authoritative(r: Resource, ctx: ActionContext): Promise<{ tags: Record<string, string> }> {
  const m = KEY.exec(r.key);
  if (!m) throw new HttpError(400, "not an ECS service");
  const [, cluster, service, at] = m;
  const region = at ?? ctx.region;
  const env = (await listEnvs()).find((e) => e.cluster === cluster && e.region === region);
  if (!env) throw new HttpError(404, `cluster ${cluster} in ${region} isn't an environment the console discovered`);
  if (ctx.mock) {
    invalidateServices(env);
    const live = (await servicesIn(env)).find((s) => s.name === service);
    if (!live) throw new HttpError(404, `service "${service}" not found in ${cluster}`);
    return { tags: { ...live.tags } };
  }
  const account = parseArn(env.clusterArn ?? "")?.account || ctx.accountId;
  if (!account) throw new HttpError(409, `the account of cluster ${cluster} isn't known — can't read the service's tags`);
  const resourceArn = arnOf.ecsService(region, account, cluster, service);
  try {
    const out = await ecs(region).send(new ListTagsForResourceCommand({ resourceArn }), abortOpts());
    return { tags: tagMap(out.tags) };
  } catch (e) {
    if ((e as { name?: string }).name === "InvalidParameterException" && /long arn format/i.test((e as Error).message ?? "")) return { tags: {} };
    throw e;
  }
}

const deployImage: ProviderAction<In> = {
  id: "deploy-image", kind: "ecs-service", title: "Deploy image",
  summary: "Rolls out a new container image to this service: tasks are replaced gradually; roll back from Releases.",
  description:
    "Deploys a new container image to an ECS service: registers a copy of the live task definition with only that container's image changed (tags, roles, variables and secrets references unchanged), then updates the service to it — a rolling deployment under the service's own deployment settings. The image must be a full URI with a tag or digest, from provisioning.allowedImageRegistries when set, otherwise from the registry the container already uses. Refuses the console's own service, services with a rollout in progress, and — when `expectedRevision` (the dry run's plan returns it in `echo`) no longer matches the live task definition — a deploy whose plan is out of date. Returns the new task definition ARN.",
  risk: "danger", perm: "act", // new code with the service's role and secrets: an agent's request always needs a person
  iam: ["ecs:RegisterTaskDefinition", "ecs:UpdateService", "iam:PassRole"],
  undo: "Roll back from Releases: the previous revision stays registered and redeploys the old image",
  verifies: "Every task runs the new revision and the deployment is COMPLETED (the console watches it for 15 minutes)",
  retrySafe: false, // F31: a second run registers another revision and starts another deployment
  input: {
    type: "object", additionalProperties: false, required: ["image"],
    properties: {
      image: field({ type: "string", title: "Container image URI", minLength: 3, maxLength: 255, description: "Full image URI with a tag or digest, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/api:1.4.2" }),
      container: field({ type: "string", title: "Container (optional)", pattern: "^[A-Za-z0-9_-]{1,255}$", description: "Container to change; defaults to the service's main container." }),
      expectedRevision: field({
        type: "integer", title: "Task definition revision (from the plan)", minimum: 1, maximum: 10_000_000, "x-echo": true,
        description: "The task definition revision the dry run planned against (its plan returns it in `echo`). The deploy refuses with 409 when the service has moved to another revision since.",
      }),
    },
  },
  // R04: lock the canonical ECS service, the key console actions and variable saves of this service take too.
  targets: (r) => [r.key],
  async plan(r, i, ctx) {
    const f = await facts(r, i, ctx);
    const stale = staleRevisionProblem(i.expectedRevision, f.td);
    const warnings = [
      ...(stale ? [`The task definition changed since that plan (rev ${i.expectedRevision} → ${f.td.revision}): this plan is against the new one.`] : []),
      f.live.circuitBreaker ? "The deployment circuit breaker rolls back if the new tasks fail to start." : "No deployment circuit breaker: if the new tasks fail, the service stays degraded until you roll back.",
      ...(f.live.desired === 0 ? ["Desired count is 0: the new revision runs only once the service is scaled up."] : []),
      ...[await tagWarning(i.image, f.env.region)].filter((x): x is string => !!x),
    ];
    remember(planKey(r, f.container, i.image), f.td);
    const plan: Plan = {
      summary: `Deploy ${i.image} to ${f.service} in ${f.env.id} (container ${f.container}, from revision ${f.td.revision})`,
      changes: [
        `RegisterTaskDefinition ${f.td.family}: revision ${f.td.revision} with ${f.container} ${f.current} → ${i.image}`,
        `UpdateService ${f.cluster}/${f.service} → the new revision (${f.live.desired} task${f.live.desired === 1 ? "" : "s"}, rolling)`,
      ],
      warnings,
      // Send these back in `input` when confirming: the deploy refuses if the service moved past this revision meanwhile.
      echo: { expectedRevision: f.td.revision },
    };
    return plan;
  },
  async run(r, i, ctx) {
    // Under the runner's lock on the service: read it again and decide again.
    const f = await facts(r, i, ctx);
    const expected = i.expectedRevision ?? recalled(planKey(r, f.container, i.image), f.td.family);
    const stale = staleRevisionProblem(expected, f.td);
    if (stale) throw new HttpError(409, stale);
    const cloud = await cloudFor(f.env);
    const taskDefinition = await cloud.registerWithImage(f.td.arn, f.container, i.image);
    const requestId = await cloud.updateService(f.cluster, f.service, { taskDefinition });
    invalidateServices(f.env);
    invalidate(`events:${inRegion(f.cluster, f.env.region)}:${f.service}`);
    return { service: f.service, env: f.env.id, container: f.container, image: i.image, fromRevision: f.td.revision, taskDefinition, requestId };
  },
};

// The connect actions (ecs-connect.ts) read an ECS service's live tags the same way.
export { authoritative as ecsServiceTags };

export const ecsImageProvider: Provider = {
  id: "ecs-image",
  label: "ECS image deploys",
  scope: "home", // no discovery of its own; its action works on the ecs provider's services in any region
  kinds: [],
  // Reads go through the console's own ECS discovery (already granted); the live tag read and the writes are its own.
  read: ["ecs:ListTagsForResource"],
  write: ["ecs:RegisterTaskDefinition", "ecs:UpdateService"],
  implicit: ["iam:PassRole"],
  async discover() {
    return { resources: [], links: [], mentions: [] };
  },
  authoritative,
  actions: [deployImage as ProviderAction],
};
