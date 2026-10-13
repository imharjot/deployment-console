// Simulated CodeBuild of the Acme account (names from ../mock-names.ts), as BatchGetProjects and the latest build
// (ListBuildsForProject + BatchGetBuilds) would return them, per region (the provider sets multiRegionMock). us-east-1:
// acme-billing-build, which the billing pipeline runs: a Docker build under the acme-codebuild role, logging to its log
// group, reading the billing service's signing key (Parameter Store) and Stripe key (Secrets Manager) — and one token
// someone put in as PLAINTEXT, which the map must never show. Its last build succeeded. Other regions: none. Read-only.
import type { CodeBuildRaw, RawBuild, RawProject } from "../../../inventory/cicd.ts";
import { CODEBUILD, CODEPIPELINE, EXISTING, IAM_ROLES, KMS_KEYS, LOG_GROUPS, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

export function simProjects(region: string, now: number = Date.now()): RawProject[] {
  if (region !== REGION) return [];
  return [
    {
      name: CODEBUILD.billing.name, arn: CODEBUILD.billing.arn, description: "Builds and pushes the billing image", serviceRole: IAM_ROLES.codebuild.arn,
      created: new Date(now - 400 * DAY), lastModified: new Date(now - 30 * DAY), encryptionKey: KMS_KEYS.app.arn, timeoutInMinutes: 30, concurrentBuildLimit: 2,
      source: { type: "CODEPIPELINE" }, artifacts: { type: "CODEPIPELINE" },
      environment: {
        type: "LINUX_CONTAINER", image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0", computeType: "BUILD_GENERAL1_MEDIUM", privilegedMode: true,
        environmentVariables: [
          { name: "NODE_ENV", value: "production", type: "PLAINTEXT" },
          { name: "SENTRY_AUTH_TOKEN", value: "sntrys_fake_acme_build_token", type: "PLAINTEXT" },
          { name: "JWT_SIGNING_KEY", value: EXISTING.ssmParameter("billing"), type: "PARAMETER_STORE" },
          { name: "STRIPE_SECRET_KEY", value: `${EXISTING.secretName("billing")}:STRIPE_SECRET_KEY`, type: "SECRETS_MANAGER" },
        ],
      },
      logsConfig: { cloudWatchLogs: { status: "ENABLED", groupName: LOG_GROUPS.codebuild } },
      tags: [{ key: "team", value: "payments" }, { key: "Environment", value: "production" }],
    },
  ];
}

export function simLastBuild(region: string, project: string, now: number = Date.now()): RawBuild | null {
  if (region !== REGION || project !== CODEBUILD.billing.name) return null;
  return {
    id: `${project}:0acme0b1-0000-4000-8000-000000000412`, buildNumber: 412, buildStatus: CODEBUILD.billing.lastBuild, startTime: new Date(now - 2 * DAY), endTime: new Date(now - 2 * DAY + 6 * 60_000),
    sourceVersion: "arn:aws:s3:::acme-logs/pipelines/acme-billing-release/SourceArti/a1b2c3", resolvedSourceVersion: "4f2a9c1e7b3d5a6c8e0f1a2b3c4d5e6f7a8b9c0d", initiator: `codepipeline/${CODEPIPELINE.billing.name}`,
  };
}

export function simCodeBuild(region: string, now: number = Date.now()): CodeBuildRaw {
  const projects = simProjects(region, now);
  return { projects, lastBuild: Object.fromEntries(projects.map((p) => [p.name!, { value: simLastBuild(region, p.name!, now), state: "ok" as const }])) };
}

// The panel's recent builds: the last one, and two before it (one of them failed on a flaky test).
export function simBuilds(region: string, project: string, now: number = Date.now()): RawBuild[] {
  const last = simLastBuild(region, project, now);
  if (!last) return [];
  return [
    last,
    { ...last, id: `${project}:0acme0b1-0000-4000-8000-000000000411`, buildNumber: 411, buildStatus: "SUCCEEDED", startTime: new Date(now - 6 * DAY), endTime: new Date(now - 6 * DAY + 5 * 60_000), resolvedSourceVersion: "9b8a7c6d5e4f3a2b1c0d" },
    { ...last, id: `${project}:0acme0b1-0000-4000-8000-000000000410`, buildNumber: 410, buildStatus: "FAILED", startTime: new Date(now - 9 * DAY), endTime: new Date(now - 9 * DAY + 3 * 60_000), resolvedSourceVersion: "1a2b3c4d5e6f7a8b9c0d" },
  ];
}
