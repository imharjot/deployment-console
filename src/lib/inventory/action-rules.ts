// Rules for running provider actions on cloud-map resources, pure (tested in action-rules.test.ts). The runner that
// applies them is src/lib/server/inventory-actions.ts.
//
// - Protection (R01, I06): a resource follows the protected-environment rules when any hint names a protected
//   environment, it is tagged console:protected, nothing placed it in an environment (unless
//   inventory.unassignedProtected is false) — or its tags weren't read (cap, time budget, AccessDenied): unknown
//   tags fail closed. Right before a change the runner re-reads the tags live and decides again (recheck()).
// - Lock keys (R04): the resource's canonical keys plus the action's extra targets, so a map deploy, a console restart
//   and a variable save of one ECS service contend for the same key in the mutation coordinator.
// - Audit summaries (R08): only what the action says may be recorded (auditSummary), or ids, versions and sizes —
//   never a presigned URL, a URL with a query string, or a returned payload.
// - Capability (F06): an action the console's AWS identity can't perform is blocked with a reason; one it probably
//   can't is flagged.
import { safeSummary, scrub } from "../mutation-core.ts";
import { keysForInventory } from "../mutation-keys.ts";
import type { CapState } from "../types.ts";
import type { Resource } from "./types.ts";

export const SELF = "This is the console itself — it never acts on its own resources.";
export const TAGS_UNREAD = "tags not read — treated as protected";

export interface Protection {
  protected: boolean;
  why?: string;
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? "");

export function protectionOf(
  r: Pick<Resource, "tags" | "tagsUnread" | "protectedBy" | "env">,
  envs: { id: string; protected: boolean }[],
  unassignedProtected = true,
): Protection {
  if (r.tagsUnread === true) return { protected: true, why: TAGS_UNREAD };
  if (r.protectedBy) return { protected: true, why: r.protectedBy };
  if (r.env && envs.find((e) => e.id === r.env)?.protected) return { protected: true, why: `environment ${r.env} is protected` };
  if (truthy(r.tags?.["console:protected"])) return { protected: true, why: "tag console:protected" };
  if (!r.env && unassignedProtected) return { protected: true, why: "in no environment — treated as protected (inventory.unassignedProtected)" };
  return { protected: false };
}

// The console's own resources carry console:self=true (IAM denies them too).
export const isSelfTagged = (tags: Record<string, string> | undefined) => /^true$/i.test(tags?.["console:self"]?.trim() ?? "");

// After the live re-read of protection metadata, inside the lock and before the audit intent: refuse when the resource
// turned out to be the console itself, or protected when the request was confirmed as unprotected.
export function recheck(o: {
  name: string;
  was: boolean; // protected when the caller confirmed (from the cached map)
  now: Protection; // from the live tags
  self: boolean;
  allowedProtected: boolean; // the caller's role may run this action on a protected resource
  needs: string; // that role, for the message
  role: string;
  confirm?: string;
  reason?: string;
}): { status: 403 | 409; error: string } | undefined {
  if (o.self) return { status: 409, error: SELF };
  if (!o.now.protected || o.was) return undefined;
  const why = o.now.why ? ` (${o.now.why})` : "";
  if (!o.allowedProtected) return { status: 403, error: `${o.name} is protected${why} — your role (${o.role}) can't do this on a protected resource; needs ${o.needs}` };
  if (o.confirm !== o.name || (o.reason?.trim().length ?? 0) < 3)
    return { status: 409, error: `${o.name} is protected${why} — run the dry run again: it now needs the name typed and a reason` };
  return undefined;
}

// Coordinator keys for an action: the resource's own, plus the action's extra targets (an alias's function, a backing
// object), each through keysForInventory — sorted and de-duplicated.
export function actionKeys(key: string, targets: string[] | undefined, region: string, home: string): string[] {
  const all = [key, ...(targets ?? [])].filter((k) => typeof k === "string" && k.length > 0 && k.length <= 2048);
  return [...new Set(all.flatMap((k) => keysForInventory(k, region, home)))].sort();
}

// What the audit log and the operation record may keep of an action's result. auditSummary when the action declares
// one, else ids, versions and sizes (safeSummary); either way scrubbed: presigned URLs, URLs with a query string or a
// password, and secret-looking fields never survive.
export function auditSummaryOf<I>(a: { auditSummary?(result: unknown, input: I): Record<string, unknown> }, result: unknown, input: I): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = a.auditSummary ? a.auditSummary(result, input) : safeSummary(result);
  } catch {
    raw = safeSummary(result);
  }
  const out = scrub(raw ?? {});
  return out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : {};
}

// F06: what the map says about an action the console's AWS identity can't (or probably can't) run.
export function capabilityText(c: { state: CapState; missing: string[] }): { blocked?: string; note?: string } {
  const what = c.missing.length ? c.missing.join(", ") : "a permission this action needs";
  if (c.state === "denied") return { blocked: `The console's AWS identity lacks ${what} — see Settings → AWS permissions` };
  if (c.state === "probably-denied") return { note: `AWS permission not verified — likely denied (${what})` };
  return {};
}

// The IAM actions an action needs: its own list; for a provider with a single action, the provider's write list.
// Cloudflare token scopes aren't IAM and are left out.
export function iamOf(a: { iam?: string[] }, provider: { write?: string[]; actions?: unknown[] }): string[] {
  const list = a.iam?.length ? a.iam : provider.actions?.length === 1 ? (provider.write ?? []) : [];
  return [...new Set(list.filter((x) => /^[a-z0-9-]+:[A-Za-z0-9*]+$/.test(x) && !x.startsWith("cloudflare:")))];
}
