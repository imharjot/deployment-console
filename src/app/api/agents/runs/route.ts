// Agent runs (master plan §3.5; people only — the proxy never lets a token reach this). GET → { runs }: yours, newest
// first (admins: ?all=1 for everyone's; ?state=, ?kind=, ?before=<createdAt>, ?limit=). POST { kind: "assistant" |
// "workflow", goal?, resourceKey?, connectionId, workflowId?, inputs? } → 201 { runId }. An assistant run acts for you,
// with the connection you name (no fallback), under the incident investigator's policy narrowed to the resource and
// its neighbourhood; a workflow run starts the workflow's published version by hand (its own policy and connection;
// `inputs` fill its manual trigger). Nothing in the body can set an identity, a role, a mode or a policy. Errors are
// { error, code? }.
import { isRunState } from "@/lib/agents/run-state";
import type { User } from "@/lib/rbac";
import { HttpError } from "@/lib/server/errors";
import { handle, json, readJson, requirePerm } from "@/lib/server/http";
import { listRunsFor, startRun } from "@/lib/server/agents/runner";
import { personOf } from "@/lib/server/ops/caller";

const KINDS = ["assistant", "workflow", "external"] as const;

export const GET = handle(async (req) => {
  const c = personOf(req);
  const q = req.nextUrl.searchParams;
  const all = q.get("all") === "1";
  if (all) requirePerm(c.user, "admin");
  const state = q.get("state") ?? undefined;
  if (state !== undefined && !isRunState(state)) throw new HttpError(400, "unknown state");
  const kind = q.get("kind") ?? undefined;
  if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "kind must be assistant, workflow or external");
  const before = q.get("before");
  const limit = q.get("limit");
  if (before !== null && !/^\d{1,15}$/.test(before)) throw new HttpError(400, "before must be a time in ms");
  if (limit !== null && !/^\d{1,3}$/.test(limit)) throw new HttpError(400, "limit must be 1–200");
  return json({
    runs: await listRunsFor(c.user, {
      all, ...(state ? { state } : {}), ...(kind ? { kind: kind as (typeof KINDS)[number] } : {}), ...(before ? { before: Number(before) } : {}),
      limit: Math.min(Math.max(Number(limit ?? 50), 1), 200),
    }),
  });
});

const FIELDS = ["kind", "goal", "resourceKey", "connectionId", "workflowId", "inputs"];

type StartManual = (user: User, workflowId: string, inputs?: unknown, resourceKey?: string) => Promise<string>;

export const POST = handle(async (req) => {
  const c = personOf(req);
  const b = await readJson(req, 16_000);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "body must be a JSON object");
  for (const k of Object.keys(b)) if (!FIELDS.includes(k)) throw new HttpError(400, `unknown field ${k.slice(0, 40)}`);
  const own = (k: string) => (Object.hasOwn(b, k) ? (b as Record<string, unknown>)[k] : undefined);
  const kind = own("kind");
  if (kind !== "assistant" && kind !== "workflow") throw new HttpError(400, 'kind must be "assistant" or "workflow"');
  const resourceKey = own("resourceKey");
  if (resourceKey !== undefined && (typeof resourceKey !== "string" || !resourceKey || resourceKey.length > 2_048)) throw new HttpError(400, "resourceKey must be a resource key");
  if (kind === "workflow") {
    const workflowId = own("workflowId");
    if (typeof workflowId !== "string" || !workflowId || workflowId.length > 100) throw new HttpError(400, "workflowId is required for a workflow run");
    const inputs = own("inputs");
    if (inputs !== undefined && (!inputs || typeof inputs !== "object" || Array.isArray(inputs))) throw new HttpError(400, "inputs must be an object");
    // The workflow's own module (c-workflows) starts it: its published version, policy, connection and preview.
    const m = (await import("@/lib/server/agents/workflows")) as unknown as { startManualRun?: StartManual };
    if (typeof m.startManualRun !== "function") throw new HttpError(503, "workflows aren't available on this console yet");
    return json({ runId: await m.startManualRun(c.user, workflowId, inputs, typeof resourceKey === "string" ? resourceKey : undefined) }, 201);
  }
  if (own("workflowId") !== undefined || own("inputs") !== undefined) throw new HttpError(400, "workflowId and inputs are only for workflow runs");
  const connectionId = own("connectionId");
  if (typeof connectionId !== "string" || !connectionId || connectionId.length > 100) throw new HttpError(400, "connectionId is required");
  const goal = own("goal");
  if (goal !== undefined && (typeof goal !== "string" || goal.length > 4_000)) throw new HttpError(400, "goal must be a string of at most 4000 characters");
  const runId = await startRun({ kind: "assistant", initiator: c.user, connectionId, ...(goal !== undefined ? { goal } : {}), ...(typeof resourceKey === "string" ? { resourceKey } : {}) });
  return json({ runId }, 201);
});
