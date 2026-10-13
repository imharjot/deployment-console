// Runs provider actions on cloud-map resources: the only door from the map (POST /api/inventory/action) and from
// agents (the cloud.action operation) to a provider's run(). Providers never check roles, lock or audit themselves —
// this file does, in this order, for every call:
//   parse strictly → find the resource and the action (the action's kind must match the resource's) → validate the
//   input against the action's schema → protection and role from the cached map (the protected variant when the
//   resource counts as protected) → the console never acts on itself → the action's own `when` → the console's AWS
//   identity can do it (F06: a known refusal is 409) → dry run: the plan, no side effects |
//   run: typed confirmation (+ reason) → the mutation coordinator (R04: one canonical lock per resource across the map,
//   console actions and variable saves; an operation record) → inside the lock: protection metadata read live (R01),
//   protection and self decided again from it → audit intent (refused when it can't be written) → provider run() →
//   result recorded as a safe summary (R08) → the provider re-discovers on the next read.
// Audit rows get the input with the action's secret fields hidden and large values (an uploaded zip) summarised, and
// never the raw result: only what the action's auditSummary allows, or ids, versions and sizes.
import "server-only";
import { actionKeys, auditSummaryOf, capabilityText, iamOf, isSelfTagged, recheck, SELF, TAGS_UNREAD } from "../inventory/action-rules.ts";
import { resourceRegion } from "../inventory/schedule.ts";
import type { ActionInfo, Resource } from "../inventory/types.ts";
import { validate } from "../ops-schema.ts";
import { can, roleFor, type Perm, type User } from "../rbac.ts";
import type { EnvInfo } from "../types.ts";
import { withCallSignal } from "./aws-limiter.ts";
import { capability, noteAllowed, noteDenied, refreshCapability, watchActions } from "./capability.ts";
import { listEnvs } from "./discovery.ts";
import { HttpError, accessDeniedOf, errText } from "./errors.ts";
import { findResource, invalidateProvider, rediscover, resourceProtection } from "./inventory.ts";
import { mutate, type MutationActor } from "./mutations.ts";
import type { Plan } from "./ops/types.ts";
import { PROVIDERS, providerById } from "./providers/index.ts";
import { actionInfo, type ActionContext, type Provider, type ProviderAction } from "./providers/types.ts";
import { homeRegion, sourceKind } from "./sources.ts";

export interface Who {
  user: User; // role checks
  actor: string; // what the audit log records (an agent token names itself here)
  ip?: string;
  token?: boolean; // an API token asked (directly, or a person approved its request): human-only actions are refused
  via?: string; // "map", "api", "mcp" — kept on the operation record
}

export interface ActionRequest {
  key: string;
  provider: string;
  action: string;
  input: Record<string, unknown>;
  confirm?: string;
  reason?: string;
  dryRun: boolean;
}

export const PEOPLE_ONLY = "people only: this action isn't available to API tokens — a person runs it in the console";
const FIELDS = ["key", "provider", "action", "input", "confirm", "reason", "dryRun"];
const AUTHORITATIVE_MS = 15_000; // a live tag read (providers time out their own calls sooner)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// Fail safe: any dryRun other than an explicit false / 0 / absent means "plan only" — a typo never runs the real thing.
const off = (v: unknown) => v === undefined || v === null || v === false || v === 0 || v === "false" || v === "0";
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const title = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Every write action a provider declares is watched by the capability store (simulated, and remembered from real calls).
watchActions(PROVIDERS.flatMap((p) => [...(p.write ?? []), ...(p.actions ?? []).flatMap((a) => a.iam ?? [])]));

export function parseActionRequest(body: unknown, dryRunQuery?: string | null): ActionRequest {
  if (!isObj(body)) throw new HttpError(400, "body must be a JSON object: { key, provider, action, input, confirm?, reason?, dryRun? }");
  const extra = Object.keys(body).filter((k) => !FIELDS.includes(k));
  if (extra.length) throw new HttpError(400, `unknown field(s): ${extra.join(", ")}`);
  const { key, provider, action, input, confirm, reason } = body;
  if (typeof key !== "string" || !key || key.length > 2048) throw new HttpError(400, "key must be a resource key from GET /api/inventory");
  if (typeof provider !== "string" || !/^[a-z0-9-]{1,40}$/.test(provider)) throw new HttpError(400, "provider must be a provider id");
  if (typeof action !== "string" || !/^[a-z0-9-]{1,60}$/.test(action)) throw new HttpError(400, "action must be an action id");
  if (input !== undefined && !isObj(input)) throw new HttpError(400, "input must be an object");
  if (confirm !== undefined && (typeof confirm !== "string" || confirm.length > 300)) throw new HttpError(400, "confirm must be a string");
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) throw new HttpError(400, "reason must be a string of at most 500 characters");
  return { key, provider, action, input: (input as Record<string, unknown>) ?? {}, confirm, reason, dryRun: !off(body.dryRun) || !off(dryRunQuery ?? undefined) };
}

function need(user: User, perm: Perm, protectedEnv: boolean) {
  if (!can(user, perm, protectedEnv)) throw new HttpError(403, `your role (${user.role}) can't do this${protectedEnv ? " on a protected environment" : ""} — needs ${roleFor(perm, protectedEnv)}`);
}

export const findAction = (providerId: string, actionId: string): { provider: Provider; action: ProviderAction } | undefined => {
  const provider = providerById(providerId);
  const action = provider?.actions?.find((a) => a.id === actionId);
  return provider && action ? { provider, action } : undefined;
};

// The resource, the action and whether the resource counts as protected (and why). 404 for unknown keys/actions, 400
// when the action is for another kind of resource.
export async function actionTarget(key: string, providerId: string, actionId: string) {
  const found = await findResource(key);
  if (!found) throw new HttpError(404, `no resource "${cut(key, 200)}" on the map — it may be gone; refresh the map`);
  const hit = findAction(providerId, actionId);
  if (!hit) throw new HttpError(404, `unknown action "${providerId}.${actionId}" — GET /api/inventory/actions?key=… lists what applies`);
  if (hit.action.kind !== found.resource.kind) throw new HttpError(400, `${providerId}.${actionId} applies to ${hit.action.kind}, not ${found.resource.kind}`);
  const protection = resourceProtection(found.resource, found.envs);
  return { r: found.resource, ...hit, protected: protection.protected, protection, envs: found.envs };
}

// What a person must type: the resource's name for dangerous actions and on protected environments, else "yes".
export const confirmFor = (a: Pick<ProviderAction, "risk">, r: Pick<Resource, "name">, prot: boolean) => (a.risk === "danger" || prot ? r.name : "yes");
const reasonNeeded = (a: Pick<ProviderAction, "risk">, prot: boolean) => a.risk === "danger" || prot;

// Input as audit rows, approval views and plans may show it: secret fields hidden, big values summarised.
export function maskActionInput(a: Pick<ProviderAction, "secretFields"> | undefined, input: unknown): Record<string, unknown> {
  if (!isObj(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (a?.secretFields?.includes(k)) out[k] = "(hidden)";
    else if (typeof v === "string" && v.length > 300) out[k] = `(${v.length.toLocaleString("en-US")} characters)`;
    else if (v && typeof v === "object" && JSON.stringify(v).length > 2000) out[k] = "(large value)";
    else out[k] = v;
  }
  return out;
}

const UNREAD_NOTE = "Treated as protected: its tags weren't read. The name and a reason are needed, and protection is checked again right before the change.";

// GET /api/inventory/actions: every action whose kind matches, with `allowed` for this caller on this resource,
// `blocked` when the action can't run right now (the console itself, the action's own precondition, or an AWS
// permission the console's identity lacks) and `note` when the permission is probably missing. Human-only actions are
// left out for API tokens.
export async function listActions(key: string, user: User, opts: { token?: boolean } = {}): Promise<ActionInfo[]> {
  const found = await findResource(key);
  if (!found) throw new HttpError(404, "no such resource on the map — it may be gone; refresh the map");
  const r = found.resource;
  const prot = resourceProtection(r, found.envs);
  void refreshCapability(); // lazily: what is known now is shown, the next listing sees the rest
  return PROVIDERS.flatMap((p) =>
    (p.actions ?? [])
      .filter((a) => a.kind === r.kind && !(opts.token && a.humanOnly))
      .map((a) => {
        let blocked: string | undefined;
        try {
          blocked = isSelfTagged(r.tags) ? SELF : a.when?.(r);
        } catch (e) {
          blocked = errText(e);
        }
        const cap = capabilityText(capability(iamOf(a, p)));
        blocked ??= cap.blocked;
        const note = [cap.note, prot.why === TAGS_UNREAD ? UNREAD_NOTE : undefined].filter(Boolean).join(" ");
        return { ...actionInfo(p, a), allowed: can(user, a.perm, prot.protected), ...(blocked ? { blocked } : {}), ...(note ? { note } : {}) };
      }),
  );
}

// An EnvInfo for the operation record and its listeners: the ECS environment when the resource is in one, else a
// stand-in ("shared" for resources without an environment).
async function auditEnv(r: Resource, prot: boolean, region: string): Promise<EnvInfo> {
  const ecs = r.env ? (await listEnvs().catch(() => [])).find((e) => e.id === r.env) : undefined;
  if (ecs) return { ...ecs, protected: ecs.protected || prot };
  return { id: r.env ?? "shared", label: r.env ? title(r.env) : "Shared", protected: prot, region, cluster: "", kind: "unknown", order: 99, source: "discovered" };
}

// Only own string-valued entries: tags from a provider's live read go into protection decisions.
function ownTags(v: unknown): Record<string, string> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, string> = {};
  for (const k of Object.keys(v)) if (Object.hasOwn(v, k) && typeof v[k] === "string") out[k] = v[k] as string;
  return out;
}

// R01: the tags protection depends on, read live right before a change, under the lock. The action provider's
// authoritative() read, else the resource's own provider's; without either, a forced re-discovery of the resource's
// provider in its region, which must have read its tags. Anything else refuses the change.
async function liveTags(p: Provider, r: Resource, ctx: ActionContext, region: string): Promise<{ tags: Record<string, string>; how: string }> {
  const unavailable = (why?: string) => new HttpError(409, `protection metadata unavailable — refusing to change ${r.name}${why ? ` (${cut(why, 300)})` : ""}`);
  const owner = providerById(r.provider);
  const reader = p.authoritative ? p : owner?.authoritative ? owner : undefined;
  if (reader?.authoritative) {
    const read = reader.authoritative.bind(reader);
    let live: Awaited<ReturnType<typeof read>>;
    try {
      live = await withCallSignal(AbortSignal.timeout(AUTHORITATIVE_MS), () => read(r, ctx));
    } catch (e) {
      throw unavailable(errText(e));
    }
    const tags = ownTags(live?.tags);
    if (!tags) throw unavailable(`${reader.label} returned no tags`);
    return { tags, how: `${reader.id} live tags` };
  }
  let fresh: Awaited<ReturnType<typeof rediscover>>;
  try {
    fresh = await rediscover(r.provider, r.key, region);
  } catch (e) {
    throw unavailable(errText(e));
  }
  if (!fresh.resource) throw unavailable(fresh.state === "ok" ? "a fresh read doesn't list it — it may be gone; refresh the map" : (fresh.why ?? `re-reading ${owner?.label ?? r.provider} failed`));
  if (fresh.resource.tagsUnread === true) throw unavailable("a fresh read couldn't read its tags");
  return { tags: ownTags(fresh.resource.tags) ?? {}, how: `${owner?.label ?? r.provider} re-read` };
}

export async function runAction(body: unknown, who: Who, dryRunQuery?: string | null): Promise<{ plan: Plan } | { result: unknown; operationId: string }> {
  const req = parseActionRequest(body, dryRunQuery);
  const { r, provider: p, action: a, protected: prot, protection, envs } = await actionTarget(req.key, req.provider, req.action);
  if (a.humanOnly && who.token) throw new HttpError(403, PEOPLE_ONLY);
  const problems = validate(a.input, req.input);
  if (problems.length) throw new HttpError(400, `invalid input: ${problems.join("; ")}`);
  need(who.user, a.perm, prot);
  if (isSelfTagged(r.tags)) throw new HttpError(409, SELF);
  const why = a.when?.(r);
  if (why) throw new HttpError(409, why);
  // F06: an AWS permission the console's identity is known to lack — refused before anything else happens.
  const iam = iamOf(a, p);
  void refreshCapability();
  const cap = capability(iam);
  if (cap.state === "denied") throw new HttpError(409, capabilityText(cap).blocked!);
  // The resource's own region (its key's "@region" or ARN region, else the region its provider reported; global → home):
  // a database in eu-west-1 is changed through eu-west-1, whatever the console's home region is.
  const home = homeRegion();
  const region = resourceRegion(r, home);
  const ctx: ActionContext = { region, mock: sourceKind() === "mock", actor: who.actor };
  const confirm = confirmFor(a, r, prot);
  const needsReason = reasonNeeded(a, prot);

  if (req.dryRun) {
    const plan = await a.plan(r, req.input, ctx);
    const warnings = [
      ...(plan.warnings ?? []),
      ...(cap.state === "probably-denied" ? [capabilityText(cap).note!] : []),
      ...(protection.why === TAGS_UNREAD ? [UNREAD_NOTE] : []),
      ...(needsReason ? ["Needs a `reason` (at least 3 characters) — it goes to the audit log."] : []),
    ];
    return { plan: { ...plan, summary: cut(String(plan.summary ?? a.title), 300), confirm, ...(warnings.length ? { warnings } : {}) } };
  }

  // The name is always accepted (it is the stronger confirmation): a resource found protected only by the live read
  // below is confirmed that way.
  if (req.confirm !== confirm && req.confirm !== r.name) throw new HttpError(400, confirm === "yes" ? 'confirm must be "yes" — a dry run returns the plan first' : `type the resource name to confirm: expected "${confirm}"`);
  if (needsReason && (req.reason?.trim().length ?? 0) < 3) throw new HttpError(400, `a reason (at least 3 characters) is required${a.risk === "danger" ? " for a dangerous action" : " on a protected environment"}`);
  let targets: string[] | undefined;
  try {
    targets = a.targets?.(r, req.input);
  } catch (e) {
    throw new HttpError(400, `${p.id}.${a.id}: ${errText(e)}`);
  }
  const env = await auditEnv(r, prot, region);
  const actor: MutationActor = { display: who.actor, kind: who.via === "agent" ? "agent" : who.token ? "token" : "person", userId: who.user.id, ...(who.ip ? { ip: who.ip } : {}), ...(who.via ? { via: who.via } : {}) };
  let recorded = false; // past the audit intent: AWS may have been changed, so the provider reads again
  try {
    const out = await mutate(
      {
        action: `${p.id}.${a.id}`,
        actor,
        env: { id: env.id, label: env.label, protected: env.protected, region },
        target: r.name,
        keys: actionKeys(r.key, targets, region, home),
        reason: req.reason?.trim() || undefined,
        params: { key: r.key, kind: r.kind, input: maskActionInput(a, req.input) },
        retrySafe: a.retrySafe === true,
        summarize: (res) => auditSummaryOf(a, res, req.input),
      },
      async (h) => {
        // R01: what protection depends on, read live under the lock — the cached map may be minutes old or may not
        // have read the tags at all. Decided again from it before anything is recorded or changed.
        const live = await liveTags(p, r, ctx, region);
        const now = resourceProtection({ ...r, tags: live.tags, tagsUnread: false }, envs);
        const refused = recheck({
          name: r.name, was: prot, now, self: isSelfTagged(live.tags), allowedProtected: can(who.user, a.perm, true), needs: roleFor(a.perm, true), role: who.user.role,
          confirm: req.confirm, reason: req.reason,
        });
        if (refused) {
          // The map was behind: read the provider again so the next dry run shows the resource as it is now.
          invalidateProvider(...new Set([p.id, r.provider]));
          throw new HttpError(refused.status, refused.error);
        }
        await h.intent({ protection: now.protected ? `protected (${now.why ?? "yes"})` : "not protected", read: live.how });
        recorded = true;
        try {
          return await a.run({ ...r, tags: live.tags, tagsUnread: false }, req.input, ctx);
        } catch (e) {
          const denied = accessDeniedOf(e);
          const action = denied?.action ?? iam[0];
          if (denied && action) noteDenied(action, denied.resource);
          throw e;
        }
      },
    );
    for (const x of iam) noteAllowed(x);
    return { result: out.result, operationId: out.operationId };
  } finally {
    if (recorded) invalidateProvider(...new Set([p.id, r.provider]));
  }
}
