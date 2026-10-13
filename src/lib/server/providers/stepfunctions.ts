// Step Functions provider: state machines, with edges read from their definitions (Amazon States Language) — Lambda
// invokes, SNS publishes, SQS sends, DynamoDB reads/writes, ECS tasks, nested executions, EventBridge, S3, Kinesis,
// HTTP endpoints — plus the execution role, log groups and KMS key. Discovery lists, hands the list to ctx.checkpoint,
// then reads definitions and tags through enrich() (R18); a machine whose tags weren't read is tagsUnread (R01). The
// panel shows the states and recent executions. Action: start an execution (danger: runs the workflow for real) — with
// a default name from the plan, so a retry can't start a second STANDARD execution; EXPRESS starts are sent once (F31).
import "server-only";
import { DescribeStateMachineCommand, ListExecutionsCommand, ListStateMachinesCommand, ListTagsForResourceCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { arnName, byteLength, field, fmtBytes, fmtTime, jsonProblem, parseArn, pickFields, tagMap } from "../../inventory/serverless-common.ts";
import { aslRefs, aslStates, defaultExecutionName, sfnResult, type RawStateMachine } from "../../inventory/serverless-sfn.ts";
import type { Resource, ResourceDetail } from "../../inventory/types.ts";
import { simExecutions, simMachine, simSfn, simStart } from "./mock/stepfunctions.ts";
import { budget, conflict, enrich, invalid, paged, perRegion, sdkConfig, simDelay, softly, t } from "./serverless-util.ts";
import type { ActionContext, Provider, ProviderAction, ProviderContext } from "./types.ts";

const sfn = perRegion((region) => new SFNClient(sdkConfig(region)), "states");
// F31: EXPRESS executions aren't idempotent by name, so their start is sent once; STANDARD ones dedupe by name.
const sfnOnce = perRegion((region) => new SFNClient(sdkConfig(region, { maxAttempts: 1 })), "states");
const DESCRIBE_MAX = 500;
const MAX_INPUT = 32 * 1024;
const AUTHORITATIVE_MS = 5_000; // the live tag read before a change (R01)

const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || r.region || fallback;

async function fetchSfn(ctx: ProviderContext): Promise<RawStateMachine[]> {
  const c = sfn(ctx.region);
  const list = await paged(ctx, "step functions", async (nextToken) => {
    const r = await c.send(new ListStateMachinesCommand({ nextToken, maxResults: 1000 }), t(ctx));
    return { items: r.stateMachines, next: r.nextToken };
  }, { service: "states" });
  ctx.checkpoint?.(sfnResult(list.map((m) => ({ ...m, enrichment: { definition: "skipped", tags: "skipped" } }))));
  const until = budget();
  const [described, tags] = await Promise.all([
    enrich(ctx, list, { label: "step functions definitions", max: DESCRIBE_MAX, until }, (m) => c.send(new DescribeStateMachineCommand({ stateMachineArn: m.stateMachineArn }), t(ctx))),
    enrich(ctx, list, { label: "step functions tags", max: DESCRIBE_MAX, until }, async (m) => tagMap((await c.send(new ListTagsForResourceCommand({ resourceArn: m.stateMachineArn }), t(ctx))).tags)),
  ]);
  return list.map((m, i): RawStateMachine => ({
    ...m, ...(described.results[i] ?? {}), tags: tags.state[i] === "ok" ? (tags.results[i] ?? {}) : undefined,
    enrichment: { definition: described.state[i], tags: tags.state[i] },
  }));
}

// ---------- detail ----------

function buildDetail(r: Resource, m: RawStateMachine | undefined, executions: { name?: string; status?: string; startDate?: Date; stopDate?: Date }[]): ResourceDetail {
  if (!m) return { key: r.key, sections: [{ title: "Not found", note: "This state machine no longer exists." }] };
  const states = aslStates(m.definition, r.key);
  const failed = executions.filter((e) => e.status === "FAILED" || e.status === "TIMED_OUT" || e.status === "ABORTED").length;
  return {
    key: r.key,
    sections: [
      {
        title: "States",
        table: states.length ? { columns: ["State", "Type", "Calls"], rows: states.map((s) => [s.name, s.type, s.target ? (s.target.startsWith("arn:") ? `${parseArn(s.target)?.service} ${arnName(s.target)}` : s.target) : s.resource ?? ""]) } : undefined,
        note: states.length ? undefined : m.definition ? "The definition couldn't be parsed." : "Definition not readable (states:DescribeStateMachine).",
      },
      {
        title: "Recent executions",
        table: executions.length ? { columns: ["Execution", "Status", "Started", "Duration"], rows: executions.map((e) => [e.name ?? "", e.status ?? "", fmtTime(e.startDate?.getTime()), e.stopDate && e.startDate ? `${((e.stopDate.getTime() - e.startDate.getTime()) / 1000).toFixed(1)} s` : "running"]) } : undefined,
        note: executions.length ? (failed ? `${failed} of the last ${executions.length} executions failed.` : undefined) : "No recent executions.",
      },
    ],
  };
}

async function detail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  if (ctx.mock) return buildDetail(r, simMachine(r.key), simExecutions(r.key));
  const c = sfn(regionOf(r, ctx.region));
  const [m, ex] = await Promise.all([
    softly(ctx, "step functions definition")(() => c.send(new DescribeStateMachineCommand({ stateMachineArn: r.key }), t(ctx))),
    softly(ctx, "step functions executions")(() => c.send(new ListExecutionsCommand({ stateMachineArn: r.key, maxResults: 10 }), t(ctx))),
  ]);
  return buildDetail(r, m ?? { stateMachineArn: r.key }, ex?.executions ?? []);
}

// ---------- action ----------

type StartInput = { input?: string; name?: string };

async function liveMachine(r: Resource, ctx: ActionContext): Promise<RawStateMachine> {
  if (ctx.mock) {
    const m = simMachine(r.key);
    if (!m) throw invalid(`state machine ${r.name} not found`);
    return m;
  }
  return sfn(regionOf(r, ctx.region)).send(new DescribeStateMachineCommand({ stateMachineArn: r.key }), t());
}

// The execution's name: the caller's, else the default — the same in the plan and the run for the same request (see
// defaultExecutionName), so the confirmed run starts the execution the plan named.
const nameFor = (r: Resource, i: StartInput, ctx: ActionContext) => i.name || defaultExecutionName(r.key, i.input || "{}", ctx.actor, Date.now());

const startExecution: ProviderAction<StartInput> = {
  id: "start-execution",
  kind: "stepfunctions",
  title: "Start an execution",
  description:
    "Starts one execution of the state machine with `input` (JSON text, at most 32 KB; default {}) and an optional execution `name` (unique per state machine for 90 days). Without a name it gets console-<UTC quarter-hour>-<hash of machine, input and caller>, shown in the plan: the same request repeated within the quarter-hour can't start a second STANDARD execution (Step Functions refuses the name) — give a name to start another. EXPRESS executions are started once, never retried. The workflow runs for real — every function it invokes, message it sends and item it writes happens — so this is always a danger action. The plan lists what the definition calls. Returns the execution ARN, name and start time.",
  risk: "danger",
  perm: "act",
  summary: "Starts one run of the workflow with a test input.",
  iam: ["states:StartExecution"],
  undo: "Irreversible — stop the execution in the Step Functions console; whatever already ran stays done",
  verifies: "Step Functions returns the execution ARN; its status shows under Recent executions",
  retrySafe: false, // EXPRESS executions don't dedupe by name; a finished STANDARD one refuses the name
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      input: field("Execution input (JSON)", { type: "string", maxLength: MAX_INPUT, description: "Execution input as JSON text (at most 32 KB)." }),
      name: field("Execution name (optional)", { type: "string", pattern: "^[A-Za-z0-9_-]{1,80}$", description: "Execution name (default: console-<quarter-hour>-<hash>, shown in the plan)." }),
    },
  },
  auditSummary: (res) => pickFields(res, ["stateMachine", "executionArn", "executionName", "startDate"]),
  when: (r) => (r.healthReason === "being deleted" ? "the state machine is being deleted" : undefined),
  async plan(r, i, ctx) {
    const problem = jsonProblem(i.input, MAX_INPUT, "the input");
    if (problem) throw invalid(problem);
    const m = await liveMachine(r, ctx);
    if (m.status === "DELETING") throw conflict("the state machine is being deleted");
    const calls = aslRefs(m.definition, r.key);
    const express = m.type === "EXPRESS";
    return {
      summary: `Start an execution of ${r.name} (${m.type ?? "STANDARD"}) with a ${fmtBytes(byteLength(i.input || "{}"))} input`,
      changes: [
        `execution name: ${nameFor(r, i, ctx)}${i.name ? "" : express ? " (default)" : " (default: the same request again within this quarter-hour reuses it, so it can't start twice — give a name to start another)"}`,
        ...(calls.length ? calls.map((c) => `may ${c.kind === "invoke" ? "call" : c.kind === "writes" ? "write to" : "read"} ${c.service} ${arnName(c.to) || c.to} (${c.states.join(", ")})`) : ["the definition calls no resource the console recognises"]),
      ],
      warnings: [
        "the workflow runs for real: everything it invokes, sends or writes happens",
        ...(m.roleArn ? [`it runs as role ${arnName(m.roleArn)}`] : []),
        ...(express ? ["EXPRESS workflow: started once and never retried — if the answer is lost, check its logs before starting it again"] : []),
      ],
    };
  },
  async run(r, i, ctx) {
    const problem = jsonProblem(i.input, MAX_INPUT, "the input");
    if (problem) throw invalid(problem);
    const name = nameFor(r, i, ctx);
    if (ctx.mock) {
      await simDelay(400);
      const out = simStart(r.key, name);
      return { stateMachine: r.name, executionArn: out.executionArn, executionName: name, startDate: out.startDate.toISOString() };
    }
    const region = regionOf(r, ctx.region);
    const m = await liveMachine(r, ctx);
    const client = m.type === "EXPRESS" ? sfnOnce : sfn;
    try {
      const out = await client(region).send(new StartExecutionCommand({ stateMachineArn: r.key, input: i.input || "{}", name }), t());
      return { stateMachine: r.name, executionArn: out.executionArn, executionName: name, startDate: out.startDate?.toISOString() };
    } catch (e) {
      if ((e as { name?: string })?.name === "ExecutionAlreadyExists" && !i.name) throw conflict(`an execution named ${name} already ran (the same input in this quarter-hour) — give a name to start another`);
      throw e;
    }
  },
};

export const stepfunctionsProvider: Provider = {
  id: "stepfunctions",
  label: "Step Functions",
  scope: "regional",
  kinds: ["stepfunctions"],
  covers: ["states:stateMachine"],
  multiRegionMock: true,
  read: ["states:ListStateMachines", "states:DescribeStateMachine", "states:ListTagsForResource", "states:ListExecutions"],
  write: ["states:StartExecution"],
  async discover(ctx) {
    return sfnResult(ctx.mock ? simSfn(ctx.region) : await fetchSfn(ctx));
  },
  activity: (r) => [{ namespace: "AWS/States", metric: "ExecutionsStarted", dims: { StateMachineArn: r.key }, stat: "Sum", label: "Executions started", region: regionOf(r, r.region), required: true }],
  detail,
  // R01: the state machine's tags, read live right before a change (5 s; throws when they can't be read).
  async authoritative(r, ctx) {
    if (ctx.mock) {
      const m = simMachine(r.key);
      if (!m) throw invalid(`state machine ${r.name} not found`);
      return { tags: { ...(m.tags ?? {}) } };
    }
    const out = await sfn(regionOf(r, ctx.region)).send(new ListTagsForResourceCommand({ resourceArn: r.key }), t(undefined, AUTHORITATIVE_MS));
    return { tags: tagMap(out.tags) };
  },
  actions: [startExecution] as ProviderAction[],
};
