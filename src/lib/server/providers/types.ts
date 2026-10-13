// The provider contract: one file per AWS service (or Cloudflare) that knows how to list that service's resources,
// read the relationships AWS stores explicitly, and run the few actions that service supports. The inventory
// (../inventory.ts) calls every enabled provider, merges the results and builds the cloud map.
//
// Rules every provider follows:
// - Real + simulated: `ctx.mock` → return the simulated Acme account (./mock/<id>.ts, names from ./mock-names.ts), so
//   the demo and the tests exercise the same code paths. Simulated actions change the simulated state. A mock of a
//   regional provider that sets `multiRegionMock` returns only `ctx.region`'s resources (MOCK_REGIONS).
// - Read only in discover(). Paginate, but stop at `ctx.cap` resources per type and report truncation. List first,
//   hand the base list to `ctx.checkpoint`, then enrich (tags, policies…) item by item within the time budget (R18).
// - Never put secret values in Resource.props (env var values, passwords, tokens). Values may go in Mention.refs —
//   those stay on the server and are only matched against other resources' names/ARNs/endpoints.
// - Every AWS SDK command a provider imports must be listed in `read`, `sensitive` or `write` below:
//   src/lib/iam-policy.test.ts checks it, and the shipped IAM policies are generated from these lists.
// - Actions never audit, lock or check roles themselves: the action runner (../inventory-actions.ts) does all of that
//   before calling run(). plan() must be side-effect free.
import "server-only";
import type { ActionInfo, Resource, ResourceDetail, ResourceKind, ProviderResult } from "../../inventory/types.ts";
import type { Perm } from "../../rbac.ts";
import type { JsonSchema, Plan } from "../ops/types.ts";

export interface ProviderContext {
  region: string;
  accountId?: string;
  mock: boolean;
  cap: number; // most resources per type to list (default 2000)
  signal: AbortSignal; // discovery deadline
  regions?: string[]; // every region the console covers, home first (set by the multi-region inventory)
  home?: string; // the console's home region (AWS_REGION)
  // Deadline guard around one AWS call (or a few): rejects once the run's deadline passed. Concurrency is bounded at
  // the SDK boundary (limitedClient, per service × region), not here. `service` is the IAM prefix, for diagnostics.
  limit<T>(fn: () => Promise<T>, opts?: { service?: string }): Promise<T>;
  note(msg: string): void; // truncation / partial-data notes shown on the map ("sqs: showing the first 2,000 queues")
  // R18: hand over what is listed so far. If the deadline cuts the run short, the inventory serves this (marked
  // partial) instead of nothing or an older snapshot. Call it right after the list calls, before enrichment.
  checkpoint?(partial: ProviderResult): void;
}

export interface ActionContext {
  region: string; // the resource's region (parseArn(r.key)?.region; "global" → home)
  mock: boolean;
  actor: string; // for resource tags/descriptions only (auditing is done by the runner)
  accountId?: string;
}

// One activity series for idle detection and the panel's charts (CloudWatch namespace/metric/dimensions).
export interface ActivitySpec {
  namespace: string;
  metric: string;
  dims: Record<string, string>;
  stat: "Sum" | "Average" | "Maximum";
  label: string;
  region?: string;
  // R20: the series that shows the resource is used (Invocations, not Errors). When a required series can't be read,
  // the evidence is insufficient and the resource is never called idle.
  required?: boolean;
}

export interface ProviderAction<I = Record<string, unknown>> {
  id: string; // unique within the provider, kebab-case: "deploy-code", "shift-alias", "purge"
  kind: ResourceKind; // which resources it applies to
  title: string; // "Deploy new code"
  description: string; // for people and language models: what it does, what it refuses, what it returns
  risk: "change" | "danger"; // danger: destructive/irreversible, deletes data, or runs code someone typed
  perm: Perm; // act (operate/deploy) · env (variables/data reads) · provision (create/delete/data writes) · power
  input: JsonSchema; // always { type: "object", additionalProperties: false, ... }
  secretFields?: string[]; // never echoed back (approval views, audit)
  humanOnly?: boolean; // never offered to API tokens (e.g. a download link that hands out data): people only
  iam?: string[]; // the exact IAM actions it needs (F06), shown beside the button
  summary?: string; // one plain sentence for people (F42): "Sends the DLQ's messages back to the source queue"
  // R08: what may be recorded in the audit log instead of the raw result (object identity, expiry, request id —
  // never bearer URLs or returned payloads). Without it the runner records only that the action succeeded.
  auditSummary?(result: unknown, input: I): Record<string, unknown>;
  targets?(r: Resource, input: I): string[]; // extra resource keys / ARNs to lock (alias → function, backing objects)
  retrySafe?: boolean; // F31: running it twice has the same effect as once (safe to retry after "outcome unknown")
  undo?: string; // how to undo it: "Start restores the saved task count" | "Irreversible"
  verifies?: string; // how success is verified: "Healthy when all tasks of the new revision are running"
  when?(r: Resource): string | undefined; // why it can't run on this resource right now (shown on the disabled button)
  plan(r: Resource, input: I, ctx: ActionContext): Promise<Plan>; // no side effects
  run(r: Resource, input: I, ctx: ActionContext): Promise<unknown>; // returns a small JSON result (ids, versions)
}

export interface Provider {
  id: string; // "lambda" — also the prefix of its actions' operation names
  label: string; // "Lambda"
  global?: boolean; // CloudFront, Route 53, Cloudflare: not tied to AWS_REGION (the same as scope "global")
  // Where it runs: "regional" (default) once per console region; "global" once, in `homeRegion` (IAM in us-east-1,
  // Global Accelerator in us-west-2) or the home region; "home" once, in the home region only (ecs, elb, rds…).
  scope?: "regional" | "global" | "home";
  homeRegion?: string;
  kinds?: ResourceKind[]; // what it discovers (Settings → AWS permissions, coverage)
  // Resource Explorer types it lists (exact spelling, sub-types included: "elasticloadbalancing:loadbalancer/app";
  // only types in src/lib/inventory/aws-resource-types.json). The catch-all keeps these out of the generic rows.
  covers?: string[];
  ttlMs?: number; // how long a run stays fresh (default 2 min)
  multiRegionMock?: boolean; // its mock answers per region (MOCK_REGIONS); without it the demo runs it in home only
  // IAM actions, e.g. "lambda:ListFunctions". read = discovery (read-only policy); sensitive = reads that expose data
  // (object contents, env values) — full policy only; write = what its actions need; implicit = authorised by other
  // calls (iam:PassRole…). Cloudflare lists token scopes here instead ("cloudflare:Zone:Read").
  read: string[];
  sensitive?: string[];
  write?: string[];
  implicit?: string[];
  enabled?(): { ok: true } | { ok: false; why: string }; // e.g. Cloudflare needs CLOUDFLARE_API_TOKEN
  discover(ctx: ProviderContext): Promise<ProviderResult>;
  // Activity metrics for idle detection and the panel's charts.
  activity?(r: Resource): ActivitySpec[];
  // Loaded when a panel opens. `page` browses inside a resource (S3 prefixes); the next token comes back in detail.page.
  detail?(r: Resource, ctx: ProviderContext, page?: { prefix?: string; token?: string }): Promise<ResourceDetail>;
  // R01: a live re-read of the resource's tags (and whatever else protection depends on) right before a write. The
  // action runner refuses the write when this throws or the provider has actions but no authoritative read.
  authoritative?(r: Resource, ctx: ActionContext): Promise<{ tags: Record<string, string>; facts?: Record<string, unknown> }>;
  actions?: ProviderAction[];
}

// ActionInfo without the per-caller bits, derived from a ProviderAction for the catalog.
export const actionInfo = (p: Provider, a: ProviderAction): ActionInfo => ({
  provider: p.id, id: a.id, kind: a.kind, title: a.title, description: a.description, risk: a.risk, perm: a.perm, input: a.input,
  ...(a.summary ? { summary: a.summary } : {}),
  ...(a.iam?.length ? { iam: [...a.iam] } : {}),
  ...(a.undo ? { undo: a.undo } : {}),
  ...(a.verifies ? { verifies: a.verifies } : {}),
});

// Errors AWS returns when the role lacks a permission — the inventory turns them into ProviderStatus.missing.
export function deniedAction(e: unknown): string | undefined {
  const err = e as { name?: string; Code?: string; message?: string };
  const name = err?.name ?? err?.Code ?? "";
  if (!/AccessDenied|UnauthorizedOperation|AuthorizationError|Forbidden|NotAuthorized/i.test(name) && !/not authorized to perform/i.test(err?.message ?? "")) return undefined;
  // "perform: ec2:DescribeInstances on resource…", or a Cloudflare scope with spaces ("perform: cloudflare:Cache Purge").
  return /perform: ([a-z0-9-]+:[A-Za-z0-9*:]+(?: [A-Z][A-Za-z]*)*)/.exec(err?.message ?? "")?.[1] ?? "(unknown action)";
}
