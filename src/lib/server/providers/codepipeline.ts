// CodePipeline provider (audit §6 A.2 #19): every pipeline in the region (ListPipelines), handed to ctx.checkpoint, then
// per pipeline within the time budget (R18, first 300): its declaration (GetPipeline — what each action builds, deploys
// or invokes becomes a link; configuration values outside a short allow-list are never copied, and a CodeBuild action's
// PLAINTEXT variables become Mention.refs only), its stage state (a disabled transition is a warning) and its last 5
// runs (the latest one failed → error), and tags (first 200). A pipeline ARN has no type segment
// (arn:aws:codepipeline:<region>:<account>:<name>). The panel shows the stages and recent runs. Read-only: no actions.
// The mapping is pure (../../inventory/cicd.ts).
import "server-only";
import {
  CodePipelineClient, GetPipelineCommand, GetPipelineStateCommand, ListPipelineExecutionsCommand, ListPipelinesCommand, ListTagsForResourceCommand,
  type PipelineExecutionSummary, type StageState,
} from "@aws-sdk/client-codepipeline";
import { arnOf, parseArn } from "../../inventory/arn.ts";
import { pipelineDetail, pipelineResults, type PipelineRaw, type RawExecution, type RawPipeline, type RawStageState, type Read } from "../../inventory/cicd.ts";
import type { EnrichState } from "../../inventory/types.ts";
import { simExecutions, simPipelines, simPipelineState } from "./mock/codepipeline.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const cp = perRegion((r) => new CodePipelineClient(sdkConfig(r)), "codepipeline");
const DETAIL_READS = 300; // pipelines whose declaration, state and runs are read
const TAG_READS = 200;
const RUNS = 5;

const execution = (e: PipelineExecutionSummary): RawExecution => ({
  pipelineExecutionId: e.pipelineExecutionId, status: e.status, startTime: e.startTime, lastUpdateTime: e.lastUpdateTime,
  sourceRevisions: e.sourceRevisions?.map((s) => ({ actionName: s.actionName, revisionId: s.revisionId, revisionSummary: s.revisionSummary })),
  trigger: e.trigger ? { triggerType: e.trigger.triggerType } : undefined,
});
const stage = (s: StageState): RawStageState => ({
  stageName: s.stageName,
  inboundTransitionState: s.inboundTransitionState ? { enabled: s.inboundTransitionState.enabled, disabledReason: s.inboundTransitionState.disabledReason } : undefined,
  latestExecution: s.latestExecution ? { status: s.latestExecution.status } : undefined,
  actionStates: s.actionStates?.map((a) => ({ actionName: a.actionName, latestExecution: a.latestExecution ? { status: a.latestExecution.status, errorDetails: a.latestExecution.errorDetails ? { code: a.latestExecution.errorDetails.code, message: a.latestExecution.errorDetails.message } : undefined } : undefined })),
});

const byName = <T,>(names: string[], r: { results: (T | undefined)[]; state: EnrichState[] }): Record<string, Read<T>> =>
  Object.fromEntries(names.map((n, i) => [n, { ...(r.results[i] !== undefined ? { value: r.results[i] } : {}), state: r.state[i] }]));

async function runsOf(ctx: { signal?: AbortSignal }, region: string, pipelineName: string): Promise<RawExecution[]> {
  return ((await cp(region).send(new ListPipelineExecutionsCommand({ pipelineName, maxResults: RUNS }), t(ctx))).pipelineExecutionSummaries ?? []).map(execution);
}
async function stateOf(ctx: { signal?: AbortSignal }, region: string, name: string): Promise<RawStageState[]> {
  return ((await cp(region).send(new GetPipelineStateCommand({ name }), t(ctx))).stageStates ?? []).map(stage);
}

async function realPipelines(ctx: ProviderContext): Promise<PipelineRaw> {
  const c = cp(ctx.region);
  const list = (await paged(ctx, "codepipeline pipelines", async (nextToken) => {
    const r = await c.send(new ListPipelinesCommand({ maxResults: 1000, nextToken }), t(ctx));
    return { items: r.pipelines, next: r.nextToken };
  }, { service: "codepipeline" })).filter((p) => p.name);
  const pipelines: PipelineRaw["pipelines"] = list.map((p) => ({ name: p.name, created: p.created, updated: p.updated, pipelineType: p.pipelineType }));
  const o = { region: ctx.region, accountId: ctx.accountId, home: ctx.home, now: Date.now() };
  ctx.checkpoint?.(pipelineResults({ pipelines }, o));

  const until = budget();
  const names = pipelines.map((p) => p.name!);
  const [decl, state, runs, tags] = await Promise.all([
    enrich(ctx, names, { label: "codepipeline: declarations", max: DETAIL_READS, until }, async (name) => {
      const r = await c.send(new GetPipelineCommand({ name }), t(ctx));
      return { pipeline: r.pipeline as RawPipeline | undefined, arn: r.metadata?.pipelineArn };
    }),
    enrich(ctx, names, { label: "codepipeline: stage states", max: DETAIL_READS, until }, (name) => stateOf(ctx, ctx.region, name)),
    enrich(ctx, names, { label: "codepipeline: runs", max: DETAIL_READS, until }, (name) => runsOf(ctx, ctx.region, name)),
    ctx.accountId
      ? enrich(ctx, names, { label: "codepipeline: tags", max: TAG_READS, until }, async (name) => (await c.send(new ListTagsForResourceCommand({ resourceArn: arnOf.pipeline(ctx.region, ctx.accountId!, name), maxResults: 50 }), t(ctx))).tags ?? [])
      : { results: names.map(() => undefined), state: names.map((): EnrichState => "skipped") },
  ]);
  pipelines.forEach((p, i) => (p.arn = decl.results[i]?.arn ?? undefined));
  return {
    pipelines,
    declaration: byName(names, { results: decl.results.map((x) => x?.pipeline), state: decl.state }),
    state: byName(names, state),
    executions: byName(names, runs),
    tags: byName(names, tags),
  };
}

export const codepipelineProvider: Provider = {
  id: "codepipeline",
  label: "CodePipeline",
  kinds: ["pipeline"],
  scope: "regional",
  covers: ["codepipeline:pipeline"],
  ttlMs: 5 * 60_000,
  multiRegionMock: true,
  read: [
    "codepipeline:ListPipelines", "codepipeline:GetPipeline", "codepipeline:GetPipelineState", "codepipeline:ListPipelineExecutions", "codepipeline:ListTagsForResource",
  ],
  async discover(ctx) {
    const o = { region: ctx.region, accountId: ctx.accountId, home: ctx.home, now: Date.now() };
    return pipelineResults(ctx.mock ? simPipelines(ctx.region, o.now) : await realPipelines(ctx), o);
  },
  // The stages as they are now and the last runs.
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    if (ctx.mock) return pipelineDetail(r.key, simExecutions(region, r.name), simPipelineState(region, r.name));
    const soft = softly(ctx, "codepipeline", { service: "codepipeline" });
    const [runs, state] = await Promise.all([soft(() => runsOf(ctx, region, r.name)), soft(() => stateOf(ctx, region, r.name))]);
    return pipelineDetail(r.key, runs, state);
  },
};
