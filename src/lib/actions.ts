// What may be done to a service, and the exact confirmation each action needs.
// The same functions build the UI's buttons and gate the server, so they can never disagree.
import type { ActionName, ActionSpec, BoxAction, EnvName } from "./types.ts";

export interface ActionRequest {
  action: ActionName;
  confirm: string;
  revisionArn?: string;
  reason?: string;
  migrationAck?: boolean;
}

export interface RevisionFact {
  arn: string;
  imagePresent: boolean;
  sha?: string;
  migrations?: boolean | "unknown"; // "unknown": the comparison could not be made or was incomplete (R25)
  migrationsWhy?: string;
}

export interface ActionContext {
  env: EnvName;
  protected: boolean; // production-like env: typed confirmation + reason
  service: string;
  desired: number;
  inProgress: boolean;
  isSelf: boolean;
  locked: boolean;
  liveArn?: string;
  revisions?: RevisionFact[];
}

type Check = { ok: true } | { ok: false; status: number; error: string };
const fail = (status: number, error: string): Check => ({ ok: false, status, error });

const ACTIONS: ActionName[] = ["restart", "stop", "start", "switch"];
const ALLOWED_KEYS = new Set(["action", "confirm", "revisionArn", "reason", "migrationAck"]);

// Strict: unknown keys (e.g. a crafted desiredCount) are rejected, not ignored.
export function parseActionBody(body: unknown): { ok: true; req: ActionRequest } | { ok: false; status: 400; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length) return { ok: false, status: 400, error: `unknown field(s): ${extra.join(", ")}` };
  if (!ACTIONS.includes(b.action as ActionName)) return { ok: false, status: 400, error: "action must be restart | stop | start | switch" };
  if (typeof b.confirm !== "string") return { ok: false, status: 400, error: "confirm is required" };
  if (b.revisionArn !== undefined && typeof b.revisionArn !== "string") return { ok: false, status: 400, error: "revisionArn must be a string" };
  if (b.reason !== undefined && (typeof b.reason !== "string" || b.reason.length > 500)) return { ok: false, status: 400, error: "reason must be a string ≤ 500 chars" };
  if (b.migrationAck !== undefined && typeof b.migrationAck !== "boolean") return { ok: false, status: 400, error: "migrationAck must be boolean" };
  return {
    ok: true,
    req: {
      action: b.action as ActionName,
      confirm: b.confirm,
      revisionArn: b.revisionArn as string | undefined,
      reason: (b.reason as string | undefined)?.trim() || undefined,
      migrationAck: b.migrationAck as boolean | undefined,
    },
  };
}

// What the user must type. Unprotected env: a plain "yes" from the dialog. Protected env: something that proves intent.
export function expectedConfirm(protectedEnv: boolean, action: ActionName, service: string, envId: string, targetSha?: string): string {
  if (!protectedEnv) return "yes";
  if (action === "restart") return service;
  if (action === "stop") return `${envId}/${service}`;
  if (action === "switch") return (targetSha ?? "").slice(0, 7) || "switch";
  return "yes"; // start
}

function precheck(action: ActionName, ctx: ActionContext): Check {
  if (ctx.isSelf) return fail(403, "the console never acts on its own service");
  if (ctx.locked) return fail(409, "another action on this service is still being submitted");
  if (ctx.inProgress && action !== "stop") return fail(409, "a rollout is in progress — wait for it to finish");
  if (action === "start" && ctx.desired !== 0) return fail(409, `already started (desired count is ${ctx.desired})`);
  if ((action === "stop" || action === "restart") && ctx.desired === 0) return fail(409, "service is stopped");
  return { ok: true };
}

export function checkAction(req: ActionRequest, ctx: ActionContext): Check {
  const pre = precheck(req.action, ctx);
  if (!pre.ok) return pre;

  let targetSha: string | undefined;
  if (req.action === "switch") {
    if (!req.revisionArn) return fail(400, "revisionArn is required to switch revision");
    if (req.revisionArn === ctx.liveArn) return fail(409, "that revision is already live");
    const rev = ctx.revisions?.find((r) => r.arn === req.revisionArn);
    if (!rev) return fail(409, "revision not found for this service");
    if (!rev.imagePresent) return fail(409, "that revision's image is no longer in ECR — it cannot start");
    if (rev.migrations === "unknown" && !req.migrationAck) {
      return fail(400, `could not check whether database migrations changed (${rev.migrationsWhy || "comparison unavailable"}) — acknowledgement required`);
    }
    if (rev.migrations === true && !req.migrationAck) return fail(400, "database migrations changed between these commits — acknowledgement required");
    targetSha = rev.sha;
  }
  if (ctx.protected && (!req.reason || req.reason.length < 3)) return fail(400, "a reason is required on a protected environment");
  const want = expectedConfirm(ctx.protected, req.action, ctx.service, ctx.env, targetSha);
  if (req.confirm !== want) return fail(400, `confirmation text does not match (expected "${want}")`);
  return { ok: true };
}

export function actionSpecs(ctx: ActionContext): ActionSpec[] {
  const spec = (name: ActionName, label: string, danger = false): ActionSpec => {
    const c = precheck(name, ctx);
    return { name, label, enabled: c.ok, why: c.ok ? undefined : c.error, danger };
  };
  return [spec("restart", "Restart"), spec("start", "Start"), spec("stop", "Stop", true), spec("switch", "Switch revision")];
}

// ---------- power: EC2 container instances and RDS instances ----------

export interface PowerTarget {
  kind: "host" | "database";
  state: string | undefined; // EC2 instance state / RDS status
  protected: boolean;
  asg?: string; // host in an Auto Scaling group
  aurora?: string; // RDS instance in an Aurora cluster
}

export function checkPower(action: BoxAction, t: PowerTarget, confirm: unknown): Check {
  if (confirm !== "yes") return fail(400, 'confirmation text does not match (expected "yes")');
  if (!t.state) return fail(404, `${t.kind} not found`);
  if (t.protected) return fail(403, "power actions are disabled on protected environments");
  if (t.asg) return fail(409, `managed by Auto Scaling group ${t.asg} — stopping it would just start a replacement; scale the group instead`);
  if (t.aurora) return fail(409, `part of Aurora cluster ${t.aurora} — Aurora is stopped per cluster, not per instance`);
  const up = t.kind === "host" ? t.state === "running" : t.state === "available";
  const down = t.state === "stopped";
  if (["stopping", "starting", "pending"].includes(t.state)) return fail(409, `${t.kind} is ${t.state} — wait for it to settle`);
  if (action === "start" && !down) return fail(409, up ? "already running" : `can't start from "${t.state}"`);
  if (action === "stop" && !up) return fail(409, down ? "already stopped" : `can't stop from "${t.state}"`);
  return { ok: true };
}

export function powerSpecs(t: PowerTarget): ActionSpec[] {
  const s = (a: BoxAction, label: string, danger: boolean): ActionSpec => {
    const c = checkPower(a, t, "yes");
    return { name: a === "start" ? "boxStart" : "boxStop", label, enabled: c.ok, why: c.ok ? undefined : c.error, danger };
  };
  const noun = t.kind === "host" ? "instance" : "database";
  return [s("start", `Start ${noun}`, false), s("stop", `Stop ${noun}`, true)];
}
