// The cloud map as agent operations: a compact summary of everything in the account (cloud.map), one resource with
// its connections (cloud.get), what can be done to it (cloud.actions) and running one of those actions
// (cloud.action). cloud.action goes through the same runner as POST /api/inventory/action (../inventory-actions.ts),
// so validation, roles, protection (read live right before the change), typed confirmations, the mutation coordinator's
// lock and the audit log all apply; the registry (./index.ts) adds token modes and approvals in front, with the
// provider action's own risk (riskOf), permission (permOf) and the resource's environment (env).
// Outputs are compact JSON for a model: names, kinds, environments, health, evidence — never secret values. Actions
// marked humanOnly are neither listed for nor run by API tokens. A resource's category, service and type label come
// from categoryOf / serviceOf / kindLabelOf (a generic aws-resource carries its own), never from KIND_INFO directly.
import "server-only";
import { HttpError } from "../errors.ts";
import { can } from "../../rbac.ts";
import { resourceRegion } from "../../inventory/schedule.ts";
import { CATEGORY_ORDER, KIND_INFO, categoryOf, kindLabelOf, serviceOf, type Category, type Edge, type Resource, type ResourceKind } from "../../inventory/types.ts";
import { actionTarget, findAction, listActions, maskActionInput, runAction, type Who } from "../inventory-actions.ts";
import { findResource, getInventory, resourceEdges, resourceProtected } from "../inventory.ts";
import { noteCounts } from "../notes.ts";
import { defineOps, type JsonSchema, type OpContext, type Operation, type Risk } from "./types.ts";

const KEY: JsonSchema = { type: "string", minLength: 1, maxLength: 2048, description: "Resource key, from cloud.map (its `resources`) or the map: an ARN, or e.g. \"ecs:service/<cluster>/<service>\", \"rds:<id>\", \"external:<host>\"." };
const KINDS = Object.keys(KIND_INFO) as ResourceKind[];
// A token's or an agent's call, or a person approving a token's request (ctx.tokenId / ctx.approval), counts as a
// machine's: human-only actions are refused.
const who = (ctx: OpContext): Who => ({
  user: ctx.user, actor: ctx.actor, ip: ctx.ip, token: ctx.via === "token" || ctx.via === "agent" || !!ctx.tokenId || !!ctx.approval, via: ctx.via === "token" ? "api" : ctx.via,
});
const op = <I,>(o: Operation<I>) => o;
const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : undefined);
// The type label only where the kind doesn't say it (generic resources); the region only outside the home region.
const brief = (r: Resource, home?: string) => {
  const region = home ? resourceRegion(r, home) : undefined;
  return {
    key: r.key, kind: r.kind, ...(r.kind === "aws-resource" ? { type: kindLabelOf(r) } : {}), name: r.name, env: r.env ?? null, health: r.health,
    ...(region && region !== home ? { region } : {}),
  };
};

type MapIn = { env?: string; kind?: ResourceKind; q?: string; service?: string; region?: string; layer?: Category; limit?: number; refresh?: boolean };
type KeyIn = { key: string };
type ActionIn = { key: string; provider: string; action: string; input?: Record<string, unknown>; confirm?: string; reason?: string };

async function cloudMap(i: MapIn) {
  const v = await getInventory({ refresh: i.refresh });
  const home = v.homeRegion ?? v.region;
  const q = i.q?.toLowerCase();
  const service = i.service?.toLowerCase();
  const shared = i.env === "shared";
  const rs = v.resources.filter(
    (r) =>
      !r.hidden &&
      (!i.env || (shared ? !r.env : r.env === i.env)) &&
      (!i.kind || r.kind === i.kind) &&
      (!q || r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q)) &&
      (!service || serviceOf(r).toLowerCase() === service) &&
      (!i.region || resourceRegion(r, home) === i.region) &&
      (!i.layer || categoryOf(r) === i.layer),
  );
  const count = (f: (r: Resource) => string) => {
    const out: Record<string, number> = {};
    for (const r of rs) out[f(r)] = (out[f(r)] ?? 0) + 1;
    return out;
  };
  const rank = { error: 0, warning: 1, unknown: 2, stopped: 3, ok: 4 };
  const problems = rs.filter((r) => r.health === "error" || r.health === "warning").sort((a, b) => rank[a.health] - rank[b.health]);
  const idle = rs.filter((r) => r.idle);
  const limit = i.limit ?? 50;
  const regions = v.regions ?? [v.region];
  const vanishing = rs.filter((r) => r.facts?.vanishing === true);
  return {
    region: v.region,
    ...(regions.length > 1 ? { regions, ...(v.partial?.pendingRegions?.length ? { pendingRegions: v.partial.pendingRegions } : {}) } : {}),
    accountId: v.accountId ?? null,
    generatedAt: iso(v.generatedAt),
    lastCompleteAt: iso(v.completeness?.lastCompleteAt) ?? null,
    counts: {
      resources: rs.length, edges: v.edges.length, byKind: count((r) => r.kind), byService: count(serviceOf), byLayer: count(categoryOf), byEnv: count((r) => r.env ?? "shared"),
      ...(regions.length > 1 ? { byRegion: count((r) => resourceRegion(r, home)) } : {}),
    },
    envs: v.envs.map((e) => ({ id: e.id, protected: e.protected, source: e.source })),
    problems: problems.slice(0, limit).map((r) => ({ ...brief(r, home), reason: r.healthReason ?? null })),
    idle: idle.slice(0, limit).map((r) => ({ ...brief(r, home), why: r.idle!.why, since: iso(r.idle!.since) ?? null })),
    ...(vanishing.length ? { pendingDeletion: vanishing.slice(0, limit).map((r) => ({ ...brief(r, home), lastSeen: iso(Number(r.facts?.lastSeen)) ?? null })) } : {}),
    providers: v.providers.filter((p) => p.state !== "ok").map((p) => ({ id: p.id, state: p.state, missing: p.missing, error: p.error })),
    ...(v.truncated?.length ? { notes: v.truncated } : {}),
    ...(i.env || i.kind || q || service || i.region || i.layer ? { resources: rs.slice(0, limit).map((r) => brief(r, home)), more: Math.max(0, rs.length - limit) } : {}),
  };
}

async function cloudGet(i: KeyIn) {
  const found = await findResource(i.key);
  if (!found) return { error: "no such resource on the map — use cloud.map to find keys", key: i.key };
  const r = found.resource;
  const edges = await resourceEdges(r.key);
  const v = await getInventory();
  const names = new Map(v.resources.map((x) => [x.key, x]));
  const notes = (await noteCounts().catch(() => ({}) as Record<string, number>))[r.key] ?? 0;
  const side = (e: Edge) => {
    const out = e.from === r.key;
    const other = names.get(out ? e.to : e.from);
    return { direction: out ? "out" : "in", kind: e.kind, other: other ? brief(other) : { key: out ? e.to : e.from }, label: e.label, confidence: e.confidence, evidence: e.evidence };
  };
  return {
    resource: {
      key: r.key, kind: r.kind, type: kindLabelOf(r), service: serviceOf(r), layer: categoryOf(r), provider: r.provider, name: r.name, region: r.region, env: r.env ?? null, envWhy: r.envWhy ?? null,
      protectedBy: r.protectedBy ?? null, health: r.health, healthReason: r.healthReason ?? null, idle: r.idle ? { why: r.idle.why, since: iso(r.idle.since) ?? null } : null, props: r.props, tags: r.tags,
      ...(r.facts ? { facts: r.facts } : {}), ...(r.tagsUnread ? { tagsUnread: true } : {}),
      endpoints: r.endpoints ?? [], vpcId: r.vpcId, securityGroups: r.securityGroups, consoleUrl: r.consoleUrl, lastActivityAt: iso(r.lastActivityAt),
    },
    edges: edges.slice(0, 100).map(side),
    moreEdges: Math.max(0, edges.length - 100),
    notes,
  };
}

export const ops = defineOps([
  op<MapIn>({
    name: "cloud.map",
    title: "Summarise the cloud map",
    description:
      "A compact summary of every resource the console found in the AWS account (and Cloudflare, when connected), in every region it covers: counts by kind, AWS service, map layer, environment (and region when there are several), resources with problems (health error or warning, with the reason), idle resources (no activity over the idle window, with why), resources pending deletion confirmation (not seen by the latest complete read), environments, and discovery providers that were denied or failed (with the missing IAM action). Filter with `env` (an environment id, or \"shared\" for resources without one), `kind`, `service` (an AWS service name such as \"Lambda\" or \"SageMaker\"), `region` (a region code), `layer` (a map column: edge, compute, messaging, data, storage, external, network, security, observability, delivery, other) or `q` (text in the name or key) — any filter also returns the matching `resources` (key, kind, name, env, health; region outside the home region; type for generic resources) so you can call cloud.get or cloud.actions with a key. AWS-managed resources the map never draws (service roles, AWS-managed keys) aren't counted. Cached for about two minutes; `refresh` re-discovers (developer role and up, at most every 20 s).",
    risk: "read",
    perm: "view",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        env: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$", description: "Only this environment id (from `envs`), or \"shared\"." },
        kind: { type: "string", enum: KINDS, description: "Only this kind of resource." },
        q: { type: "string", maxLength: 100, description: "Only resources whose name or key contains this text (case-insensitive)." },
        service: { type: "string", minLength: 1, maxLength: 80, description: "Only resources of this AWS service, by its name as counts.byService shows it (\"Lambda\", \"SageMaker\"; case-insensitive)." },
        region: { type: "string", pattern: "^[a-z]{2}(-[a-z]+)+-\\d+$", description: "Only resources in this region (e.g. eu-west-1); global resources count as the home region." },
        layer: { type: "string", enum: CATEGORY_ORDER, description: "Only resources in this map column or support layer." },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 50, description: "Most items per list (default 50)." },
        refresh: { type: "boolean", description: "Re-discover now instead of using the cached map." },
      },
    },
    // Forcing a re-discovery costs AWS calls: developers and up, like GET /api/inventory?refresh=1.
    run: (i, ctx) => {
      if (i.refresh && !can(ctx.user, "act")) throw new HttpError(403, "re-discovering the account needs the developer role — omit `refresh` to use the cached map");
      return cloudMap(i);
    },
  }),
  op<KeyIn>({
    name: "cloud.get",
    title: "Get a resource from the cloud map",
    description:
      "One resource in detail: kind, environment and why it was assigned, health and reason, idle mark, properties, tags, endpoints, network, the AWS console link, the number of notes people attached, and every connection in or out — kind (route, invoke, event, poll, sql, cache, stream, reads, writes, uses, http), the other end, and how the console knows (confidence config = read from AWS configuration, allowed = a security group permits it, mentioned = named in configuration such as an environment variable; evidence names the rule or variable, never its value).",
    risk: "read",
    perm: "view",
    input: { type: "object", additionalProperties: false, required: ["key"], properties: { key: KEY } },
    run: (i) => cloudGet(i),
  }),
  op<KeyIn>({
    name: "cloud.actions",
    title: "List actions for a cloud resource",
    description:
      "What can be done to one resource (deploy new Lambda code, shift an alias, purge a queue, invalidate CloudFront paths…): provider, action id, title, description, risk (change or danger), permission, the input JSON Schema, `allowed` for you on this resource (role × protected environment) and `blocked` when it can't run right now. Actions reserved for people (e.g. download links that hand out data) aren't listed for API tokens. Run one with cloud.action.",
    risk: "read",
    perm: "view",
    input: { type: "object", additionalProperties: false, required: ["key"], properties: { key: KEY } },
    run: async (i, ctx) => ({ key: i.key, actions: await listActions(i.key, ctx.user, { token: who(ctx).token }) }),
  }),
  op<ActionIn>({
    name: "cloud.action",
    title: "Run an action on a cloud resource",
    description:
      "Runs one action from cloud.actions on a resource. Dry run first: the plan lists the changes and warnings, and its `confirm` is the exact text to send — \"yes\" for routine changes, the resource's name for dangerous actions and on protected environments (which also need a `reason` of at least 3 characters, stored in the audit log). `input` must match the action's schema. Its risk and required role are the action's own, so with an API token a dangerous action, or any change on a protected environment, becomes an approval request a person must accept. Refuses unknown resources or actions, actions for another kind of resource, actions reserved for people when called with an API token (403 — a token can't even request one), the console's own resources, and actions whose preconditions fail (the reason is returned). Returns the action's small result (ids, versions).",
    risk: "change",
    riskOf: (i): Risk => findAction(i.provider, i.action)?.action.risk ?? "danger",
    perm: "act",
    permOf: async (i) => (await actionTarget(i.key, i.provider, i.action)).action.perm,
    input: {
      type: "object",
      additionalProperties: false,
      required: ["key", "provider", "action", "confirm"],
      properties: {
        key: KEY,
        provider: { type: "string", pattern: "^[a-z0-9-]{1,40}$", description: "Provider id of the action, from cloud.actions." },
        action: { type: "string", pattern: "^[a-z0-9-]{1,60}$", description: "Action id, from cloud.actions." },
        input: { type: "object", description: "The action's input, matching its schema from cloud.actions (default {})." },
        confirm: { type: "string", maxLength: 300, description: "Exactly the `confirm` of a dry run's plan. When a person approves the request, their typed text is used." },
        reason: { type: "string", maxLength: 500, description: "Why. Required (at least 3 characters) for dangerous actions and on protected environments; stored in the audit log." },
      },
    },
    maskInput: (i) => ({ ...i, input: maskActionInput(findAction(i.provider, i.action)?.action, i.input) }),
    env: async (i) => (await findResource(i.key))?.resource.env,
    // The runner's own rule (tag console:protected, protected hints, unassigned resources), so tokens get approvals there too.
    protectedOf: async (i) => {
      const f = await findResource(i.key);
      return f ? resourceProtected(f.resource, f.envs) : true;
    },
    plan: async (i, ctx) => {
      const r = await runAction({ ...i, dryRun: true }, who(ctx));
      if (!("plan" in r)) throw new Error("dry run returned no plan");
      return r.plan;
    },
    run: async (i, ctx) => {
      const r = await runAction({ ...i, dryRun: false }, who(ctx));
      return "result" in r ? r.result : r;
    },
  }),
]);
