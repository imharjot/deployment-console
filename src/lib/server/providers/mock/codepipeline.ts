// Simulated CodePipeline of the Acme account (names from ../mock-names.ts), as ListPipelines, GetPipeline,
// GetPipelineState and ListPipelineExecutions would return them, per region (the provider sets multiRegionMock).
// us-east-1: acme-billing-release — GitHub (acme/billing, main) → CodeBuild acme-billing-build → ECS deploy to
// acme-production/billing; artifacts in the shared acme-logs bucket under pipelines/. Its last run succeeded two days ago
// (revision summaries come as JSON, as a CodeStar connection sends them).
// Its build action passes a PLAINTEXT variable that must never reach the map. Other regions: none. Read-only.
import type { PipelineRaw, RawExecution, RawPipeline, RawStageState } from "../../../inventory/cicd.ts";
import { ACCT, CODEBUILD, CODEPIPELINE, IAM_ROLES, KMS_KEYS, REGION, S3 } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

const NAME = CODEPIPELINE.billing.name;

export function simPipelineDeclaration(region: string, name: string): RawPipeline | undefined {
  if (region !== REGION || name !== NAME) return undefined;
  return {
    name, roleArn: IAM_ROLES.codebuild.arn, pipelineType: "V2", executionMode: "QUEUED",
    artifactStore: { type: "S3", location: S3.logs.name, encryptionKey: { id: KMS_KEYS.app.arn } },
    stages: [
      { name: "Source", actions: [{ name: "GitHub", actionTypeId: { category: "Source", owner: "AWS", provider: "CodeStarSourceConnection" }, configuration: { ConnectionArn: `arn:aws:codeconnections:${REGION}:${ACCT}:connection/0acme0c9-0000-4000-8000-000000000001`, FullRepositoryId: "acme/billing", BranchName: "main", OutputArtifactFormat: "CODE_ZIP" } }] },
      { name: "Build", actions: [{ name: "Image", actionTypeId: { category: "Build", owner: "AWS", provider: "CodeBuild" }, configuration: { ProjectName: CODEBUILD.billing.name, EnvironmentVariables: JSON.stringify([{ name: "DOCKERHUB_TOKEN", value: "dckr_pat_fake_acme_pipeline", type: "PLAINTEXT" }]) } }] },
      { name: "Deploy", actions: [{ name: "Production", actionTypeId: { category: "Deploy", owner: "AWS", provider: "ECS" }, configuration: { ClusterName: CODEPIPELINE.billing.deploys.cluster, ServiceName: CODEPIPELINE.billing.deploys.service, FileName: "imagedefinitions.json" } }] },
    ],
  };
}

export function simPipelineState(region: string, name: string): RawStageState[] | undefined {
  if (region !== REGION || name !== NAME) return undefined;
  return ["Source", "Build", "Deploy"].map((stageName, i) => ({ stageName, ...(i ? { inboundTransitionState: { enabled: true } } : {}), latestExecution: { status: "Succeeded" } }));
}

export function simExecutions(region: string, name: string, now: number = Date.now()): RawExecution[] {
  if (region !== REGION || name !== NAME) return [];
  return [2, 6, 9].map((d, i) => ({
    pipelineExecutionId: `0acme0e${i}-0000-4000-8000-00000000000${i}`, status: "Succeeded", startTime: new Date(now - d * DAY), lastUpdateTime: new Date(now - d * DAY + 14 * 60_000),
    trigger: { triggerType: "Webhook" }, sourceRevisions: [{ actionName: "GitHub", revisionId: ["4f2a9c1e7b3d5a6c8e0f", "9b8a7c6d5e4f3a2b1c0d", "1a2b3c4d5e6f7a8b9c0d"][i], revisionSummary: JSON.stringify({ ProviderType: "GitHub", CommitMessage: ["Retry failed invoices\n\nCloses #812", "Bump stripe SDK", "Add dunning emails"][i] }) }],
  }));
}

export function simPipelines(region: string, now: number = Date.now()): PipelineRaw {
  if (region !== REGION) return { pipelines: [] };
  const ok = <T,>(value: T) => ({ value, state: "ok" as const });
  return {
    pipelines: [{ name: NAME, arn: CODEPIPELINE.billing.arn, created: new Date(now - 380 * DAY), updated: new Date(now - 30 * DAY), pipelineType: "V2" }],
    declaration: { [NAME]: ok(simPipelineDeclaration(region, NAME)!) },
    state: { [NAME]: ok(simPipelineState(region, NAME)!) },
    executions: { [NAME]: ok(simExecutions(region, NAME, now)) },
    tags: { [NAME]: ok([{ key: "team", value: "payments" }, { key: "Environment", value: "production" }]) },
  };
}
