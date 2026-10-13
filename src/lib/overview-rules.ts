// Pure rules behind the ECS overview, the sampler and the guarded actions (src/lib/server/console.ts): load balancer
// roll-up (F01), traffic attribution (R22, F03, F09), image checks (R24, F68), migration checks (F07, R25), the
// capability and autoscaling notes on actions (F06, CC-20), sampler staleness (R21) and whether an ECS change has
// taken effect (REVIEW "accepted is not done"). Kept free of server-only imports so `node --test` covers them.
import { ago } from "./freshness.ts";
import { targetGroupsHealth, type TgHealth, type TgInput } from "./status.ts";
import type { ActionSpec, PropertyItem, RawService, RawTargetHealth } from "./types.ts";

// ---------- load balancer roll-up (F01) ----------

const tgShort = (arn: string) => arn.match(/targetgroup\/([^/]+)/)?.[1] ?? arn;

// One input per target group: its health counts and the summed desired count of every service attached to it. A
// group no service references keeps desired undefined (unknown → treated as active). Targets still draining from a
// group whose services were all scaled to 0 are leaving, not failing: they don't count (a Stop would otherwise read
// DOWN for the whole deregistration delay, 300 s by default).
export function tgInputs(services: { desired: number; targetGroupArns: string[] }[], health: RawTargetHealth[]): TgInput[] {
  const desired = new Map<string, number>();
  for (const s of services) for (const a of new Set(s.targetGroupArns)) desired.set(a, (desired.get(a) ?? 0) + s.desired);
  return health.map((h) => {
    const d = desired.get(h.targetGroupArn);
    const leaving = d === 0 && h.healthy + h.unhealthy + (h.initial ?? 0) === 0;
    return {
      arn: h.targetGroupArn, healthy: h.healthy, unhealthy: h.unhealthy, initial: h.initial, draining: leaving ? 0 : h.draining,
      ...(d !== undefined ? { desired: d } : {}),
    };
  });
}

export function lbRollup(services: { desired: number; targetGroupArns: string[] }[], health: RawTargetHealth[]): TgHealth {
  return targetGroupsHealth(tgInputs(services, health));
}

// The service panel's line for one of its target groups. A stopped service's empty group is expected, not bad.
export function targetGroupItem(tg: RawTargetHealth, desired: number): PropertyItem {
  const label = `Target group ${tgShort(tg.targetGroupArn)}`;
  if (desired === 0 && tg.healthy + tg.unhealthy + (tg.initial ?? 0) === 0) {
    return { label, value: tg.draining ? `${tg.draining} draining (service stopped)` : "no targets (service stopped)", tone: "muted" };
  }
  const extra = [tg.initial ? `${tg.initial} registering` : "", tg.draining ? `${tg.draining} draining` : ""].filter(Boolean);
  return {
    label,
    value: `${tg.healthy} healthy · ${tg.unhealthy} unhealthy${extra.length ? ` · ${extra.join(" · ")}` : ""}${tg.reasons.length ? ` (${tg.reasons.join(", ")})` : ""}`,
    tone: tg.unhealthy === 0 && tg.healthy > 0 ? "ok" : desired === 0 ? "warn" : "bad",
  };
}

// ---------- numbers (F09, F70) ----------

// Three significant digits: 0.0123, 1.23, 123, 12300 — small rates never round to 0.
export function sig3(v: number): number {
  if (!Number.isFinite(v) || v === 0) return Number.isFinite(v) ? 0 : v;
  return Number(v.toPrecision(3));
}

// The load balancer card's traffic stat from requests per minute: req/min below 1 request per second.
export function rateStat(perMin: number): { label: string; value: string } {
  const rps = perMin / 60;
  return rps < 1 ? { label: "req/min", value: String(sig3(perMin)) } : { label: "rps", value: String(sig3(rps)) };
}

export const GIB = 1024 ** 3;

// ---------- traffic per service and per load balancer (R22, F03) ----------

// CloudWatch dimension values: "targetgroup/<name>/<id>" and "app/<name>/<id>".
export const tgDim = (arn: string) => arn.slice(arn.indexOf("targetgroup/"));
export const lbDim = (arn: string) => arn.split(":loadbalancer/")[1];

export interface TrafficSpec {
  id: string;
  namespace: "AWS/ApplicationELB";
  metric: "RequestCount";
  dims: Record<string, string>;
  stat: "Sum";
}

export interface TrafficPlan {
  specs: TrafficSpec[];
  services: Record<string, string[]>; // service name → spec ids of its target groups
  lbs: Record<string, string>; // load balancer ARN → spec id of its whole-LB count
}

// Each target group is measured on its OWN load balancer with RequestCount {TargetGroup, LoadBalancer} (requests, not
// RequestCountPerTarget, which is divided by the number of targets). The environment's total sums the distinct
// load balancers once each (RequestCount {LoadBalancer}), never a target group twice.
export function trafficPlan(services: { name: string; targetGroupArns: string[] }[], tglb: Record<string, string | undefined>): TrafficPlan {
  const specs: TrafficSpec[] = [];
  const out: TrafficPlan = { specs, services: {}, lbs: {} };
  const byTg = new Map<string, string>();
  for (const s of services) {
    for (const tg of new Set(s.targetGroupArns)) {
      const lb = Object.hasOwn(tglb, tg) ? tglb[tg] : undefined;
      if (!lb || !lbDim(lb) || !tg.includes("targetgroup/")) continue;
      let id = byTg.get(tg);
      if (!id) {
        id = `t${byTg.size}`;
        byTg.set(tg, id);
        specs.push({ id, namespace: "AWS/ApplicationELB", metric: "RequestCount", dims: { TargetGroup: tgDim(tg), LoadBalancer: lbDim(lb) }, stat: "Sum" });
      }
      (out.services[s.name] ??= []).push(id);
      if (!Object.hasOwn(out.lbs, lb)) {
        out.lbs[lb] = `l${Object.keys(out.lbs).length}`;
        specs.push({ id: out.lbs[lb], namespace: "AWS/ApplicationELB", metric: "RequestCount", dims: { LoadBalancer: lbDim(lb) }, stat: "Sum" });
      }
    }
  }
  return out;
}

// Requests per minute from 1-minute Sum buckets (the average of the last `points` buckets). `total` is undefined when
// no load balancer reported anything.
export function trafficRates(plan: TrafficPlan, data: Record<string, [number, number][]>, points = 5): { services: Record<string, number>; total?: number } {
  const avg = (id: string) => {
    const pts = (Object.hasOwn(data, id) ? data[id] : []).slice(-points);
    return pts.length ? pts.reduce((a, p) => a + p[1], 0) / pts.length : undefined;
  };
  const services: Record<string, number> = {};
  for (const [name, ids] of Object.entries(plan.services)) {
    const vals = ids.map(avg).filter((v): v is number => v !== undefined);
    if (vals.length) services[name] = vals.reduce((a, b) => a + b, 0);
  }
  const lbs = Object.values(plan.lbs).map(avg).filter((v): v is number => v !== undefined);
  return lbs.length ? { services, total: lbs.reduce((a, b) => a + b, 0) } : { services };
}

// ---------- images (R24, F68) ----------

export interface ImageRefInfo {
  container: string;
  image: string;
  ecr: boolean;
  repository: string;
  tag?: string;
  digest?: string;
}

// The result of checking one essential container's image. `found` null = the registry can't be asked (not ECR);
// `error` = asking failed (denied, throttled …).
export interface ContainerCheck {
  ref: ImageRefInfo;
  found?: { exists: boolean; digest?: string } | null;
  error?: string;
}

export interface ImageVerdict {
  imageCheck: "present" | "missing" | "unknown";
  why?: string;
  present: boolean; // what the switch guard uses: only a confirmed missing image blocks
  digest?: string;
}

const refText = (r: ImageRefInfo) => `${r.repository}${r.digest ? `@${shortDigest(r.digest)}` : `:${r.tag ?? "latest"}`}`;
export const shortDigest = (d: string) => (d.startsWith("sha256:") ? `sha256:${d.slice(7, 19)}` : d.slice(0, 19));

// Every essential ECR container must exist: any missing → missing (the switch is refused); any ECR image that couldn't
// be checked → unknown with the reason (allowed, with a warning); only a full set of confirmed ECR images is present.
// Images in other registries (Docker Hub, a public sidecar) can't be asked: they don't decide the verdict while an ECR
// image does, and are named in `why`; a revision with no ECR image at all is unknown.
export function imageVerdict(checks: ContainerCheck[]): ImageVerdict {
  if (!checks.length) return { imageCheck: "unknown", why: "no container images to check", present: true };
  const missing = checks.filter((c) => c.found?.exists === false);
  if (missing.length) {
    return { imageCheck: "missing", present: false, why: `${missing.map((c) => `${refText(c.ref)} (${c.ref.container})`).join(", ")} ${missing.length === 1 ? "is" : "are"} no longer in ECR — the revision can't start` };
  }
  const external = checks.filter((c) => c.found === null && !c.error);
  const externalWhy = external.length ? `${external.map((c) => refText(c.ref)).join(", ")}: not ${external.length === 1 ? "an ECR image" : "ECR images"}, ${external.length === 1 ? "its registry isn't" : "their registries aren't"} checked` : undefined;
  const unknown = checks.filter((c) => !c.found && !external.includes(c));
  if (unknown.length || external.length === checks.length) {
    const why = [...unknown.map((c) => `${refText(c.ref)}: couldn't check (${c.error ?? "no answer"})`), ...(externalWhy ? [externalWhy] : [])].join("; ");
    return { imageCheck: "unknown", present: true, why };
  }
  const main = checks.find((c) => c.found);
  return { imageCheck: "present", present: true, ...(main?.found?.digest ? { digest: main.found.digest } : {}), ...(externalWhy ? { why: externalWhy } : {}) };
}

// A tag can move. Warn when the image a revision names by tag is not (or not only) the one it ran:
// - the live revision: its tag now points somewhere other than what the running tasks run (a restart pulls that);
// - another revision with the live revision's tag: switching runs whatever the tag points to now;
// - another revision whose tag now points to the image the live tasks run (it was re-pointed).
export function mutableTag(o: { tag?: string; digestPinned: boolean; current?: string; live?: string; isLive: boolean; sameRefAsLive: boolean }): { mutable: boolean; why?: string } {
  if (o.digestPinned || !o.tag || !o.current) return { mutable: false };
  const now = shortDigest(o.current);
  const moved = !!o.live && o.live !== o.current;
  if (o.isLive) {
    return moved ? { mutable: true, why: `tag ${o.tag} now points to ${now}, not the image the running tasks use (${shortDigest(o.live!)}): a restart would start the new image` } : { mutable: false };
  }
  if (o.sameRefAsLive || (!!o.live && o.live === o.current)) {
    return {
      mutable: true,
      why: moved
        ? `tag ${o.tag} now points to ${now}; switching to this revision may not restore the image it originally ran`
        : `tag ${o.tag} now points to ${now}, the image the live revision runs; switching to this revision may not restore the image it originally ran`,
    };
  }
  return { mutable: false };
}

// ---------- migrations (F07, R25) ----------

// Why a migration check couldn't be made, from the compare error.
export function migrationsWhy(e: unknown): string {
  const err = e as { status?: number; $metadata?: { httpStatusCode?: number }; message?: string } | undefined;
  const status = err?.status ?? err?.$metadata?.httpStatusCode;
  const msg = String(err?.message ?? e ?? "");
  if (status === 401 || /GITHUB_TOKEN is not set|not connected|not configured/i.test(msg)) return "GitHub not connected";
  if (status === 403 || status === 429 || /rate limit/i.test(msg)) return "rate limited";
  return "compare failed";
}

// ---------- capability and autoscaling notes on actions (F06, CC-20) ----------

// denied → disabled with the reason; probably denied → enabled with a warning; unknown/allowed → unchanged.
export function withCapability(spec: ActionSpec, cap: { state: string; missing: string[] }, iam: readonly string[]): ActionSpec {
  if (cap.state === "denied") {
    const what = cap.missing.length ? cap.missing : [...iam];
    return { ...spec, enabled: false, why: spec.enabled ? `the console's AWS identity can't call ${what.join(", ")}` : spec.why };
  }
  if (cap.state === "probably-denied" && spec.enabled) {
    const what = cap.missing.length ? cap.missing : [...iam];
    return { ...spec, warning: joinWarning(spec.warning, `AWS permission not verified — likely denied (${what.join(", ")})`) };
  }
  return spec;
}

export const joinWarning = (a: string | undefined, b: string) => (a ? `${a} · ${b}` : b);

export interface Autoscaling {
  min: number;
  max: number;
  policies: string[];
}

export const autoscalingNote = (a: Autoscaling) =>
  `Application Auto Scaling manages this service (min ${a.min}, max ${a.max}): a desired count outside that range is overridden`;

// Whether setting `desired` fights the autoscaler (undefined desired: unknown target, warn whenever there is one).
export const outsideRange = (a: Autoscaling, desired?: number) => desired === undefined || desired < a.min || desired > a.max;

// ---------- sampler freshness (R21) ----------

const clock = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;

// An environment's sampled overview is stale once it is older than `intervals` sampler intervals; before its first
// sample it gets the same allowance from the sampler's start.
export function samplerStaleness(o: { sampledAt?: number; startedAt?: number; now: number; intervalMs: number; intervals: number }): { stale: boolean; reason?: string } {
  const limit = o.intervalMs * o.intervals;
  if (o.sampledAt !== undefined) {
    return o.now - o.sampledAt > limit ? { stale: true, reason: `not sampled since ${clock(o.sampledAt)} (${ago(o.now - o.sampledAt)})` } : { stale: false };
  }
  if (o.startedAt === undefined) return { stale: true, reason: "the background sampler is not running" };
  return o.now - o.startedAt > limit ? { stale: true, reason: `not sampled yet (sampler running since ${clock(o.startedAt)})` } : { stale: false };
}

// ---------- outcome verification (REVIEW "durable operations": accepted is not done) ----------

export const VERIFY_WINDOW_MS = 15 * 60_000;
// The operations whose effect the sampler checks on the ECS service they hold a key for: console and map actions, image
// deploys, and the provisioning changes to an existing service's count (a scale, a delete).
export const VERIFIED_ACTION = /^(?:(?:ecs|services|ecs-image)\.|provision\.(?:scale|delete-service)$)/;
// The same set as SQL LIKE patterns, so other operations never crowd these out of a bounded query.
export const VERIFIED_ACTION_SQL = "(action LIKE 'ecs.%' OR action LIKE 'services.%' OR action LIKE 'ecs-image.%' OR action IN ('provision.scale', 'provision.delete-service'))";
const CLOCK_SKEW_MS = 60_000;

export interface OpToVerify {
  action: string;
  createdAt: number;
  params?: Record<string, unknown>;
}

export type Verdict = { result: "verified" } | { result: "failed"; detail: string } | { result: "pending"; detail?: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

// Steady on the new state: no rollout running, every desired task running, nothing pending, and the change itself
// visible (the count it set, the revision it switched to, a deployment newer than the request). A rollout that
// failed after the request fails the operation at once. `svc` undefined: the service isn't in the cluster (verified
// for a delete); null: it couldn't be read (still pending).
export function verifyOutcome(op: OpToVerify, svc: RawService | null | undefined, now: number, windowMs = VERIFY_WINDOW_MS): Verdict {
  const late = now - op.createdAt > windowMs;
  const timeout: Verdict = { result: "failed", detail: `did not stabilise in ${Math.round(windowMs / 60_000)} min` };
  const verb = op.action.slice(op.action.lastIndexOf(".") + 1);
  if (/delete/.test(verb)) {
    if (svc === undefined || (svc && svc.status !== "ACTIVE")) return { result: "verified" };
    return late && svc ? timeout : { result: "pending" };
  }
  if (svc === null) return { result: "pending", detail: "the service couldn't be read" };
  if (svc === undefined) return late ? { result: "failed", detail: "the service is no longer in the cluster" } : { result: "pending" };
  const since = op.createdAt - CLOCK_SKEW_MS;
  const failed = svc.deployments.find((d) => d.rolloutState === "FAILED" && d.createdAt >= since);
  if (failed) return { result: "failed", detail: `rollout failed${failed.rolloutReason ? `: ${failed.rolloutReason}` : ""}` };
  const primary = svc.deployments.find((d) => d.status === "PRIMARY");
  const steady =
    !svc.deployments.some((d) => d.rolloutState === "IN_PROGRESS") &&
    !svc.deployments.some((d) => d.status === "ACTIVE" && d.running > 0) &&
    svc.running === svc.desired && svc.pending === 0;
  const p = op.params ?? {};
  let applied = true;
  if (verb === "stop") applied = svc.desired === 0;
  else if (verb === "start" || verb === "scale") {
    const want = num(p.desiredAfter) ?? num(p.desired);
    applied = want === undefined ? svc.desired > 0 : svc.desired === want;
  } else if (verb === "switch") {
    const to = str(p.to) ?? str(p.revisionArn);
    applied = !to || primary?.taskDefinition === to || svc.taskDef?.arn === to;
  } else if (verb === "restart" || op.action.startsWith("ecs-image.")) applied = !!primary && primary.createdAt >= since;
  if (steady && applied) return { result: "verified" };
  return late ? timeout : { result: "pending" };
}

// What a service card says about a recent operation.
export function verificationOf(verify: string | null | undefined): "accepted" | "verified" | "failed" {
  return verify === "verified" ? "verified" : verify === "failed" ? "failed" : "accepted";
}

// The ECS services a stored operation holds keys for ("ecs-service:<region>/<cluster>/<service>").
export function ecsServicesOf(keys: unknown): { region: string; cluster: string; service: string }[] {
  if (!Array.isArray(keys)) return [];
  const out: { region: string; cluster: string; service: string }[] = [];
  for (const k of keys) {
    const m = typeof k === "string" ? /^ecs-service:([^/]+)\/([^/]+)\/([^/]+)$/.exec(k) : null;
    if (m) out.push({ region: m[1], cluster: m[2], service: m[3] });
  }
  return out;
}
