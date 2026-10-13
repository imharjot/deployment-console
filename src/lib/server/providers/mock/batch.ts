// Simulated AWS Batch of the Acme account (names from ../mock-names.ts), as DescribeComputeEnvironments,
// DescribeJobQueues, ListJobs and DescribeJobDefinitions return them, per region. us-east-1: the Spot compute
// environment acme-batch-spot (its own AWSBatch-… ECS cluster, the ECS instance profile, production subnets; no
// security groups, so the demo map isn't drawn over with the worker group's "allowed" edges) behind the acme-reports
// queue, which runs the nightly report definition (the jobs image, the worker's roles, the production database and
// orders queue in its environment). One report job has waited for capacity for over an hour (warning) and one export
// failed two days ago. Other regions: none. Read-only.
import type { BatchInput, RawJob, RawJobDefinition } from "../../../inventory/batch.ts";
import { ACCT, BATCH, ECR_REPOS, EXISTING, IAM_ROLES, LOG_GROUPS, REGION, SQS, ecrImage } from "../mock-names.ts";
import { DAY, MIN } from "./serverless-sim.ts";

const DEFINITION = `arn:aws:batch:${REGION}:${ACCT}:job-definition/acme-nightly-report:3`;

export const simBatchDefinitions = (): RawJobDefinition[] => [
  {
    jobDefinitionName: "acme-nightly-report", jobDefinitionArn: DEFINITION, revision: 3, status: "ACTIVE", type: "container", platformCapabilities: ["EC2"],
    containerProperties: {
      image: ecrImage(ECR_REPOS.jobs.name, "2026.10.01"), jobRoleArn: IAM_ROLES.tasks.worker.arn, executionRoleArn: IAM_ROLES.taskExecution.arn,
      environment: [{ name: "DB_HOST", value: EXISTING.rdsHost(EXISTING.rds.production) }, { name: "ORDERS_QUEUE_URL", value: SQS.orders.url }, { name: "REPORT_FORMAT", value: "csv" }],
      secrets: [{ name: "DB_PASSWORD", valueFrom: EXISTING.secretArn("worker") }],
      logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": LOG_GROUPS.ecs("production", "worker"), "awslogs-stream-prefix": "batch" } },
    },
  },
];

export function simBatchJobs(now: number = Date.now()): { runnable: RawJob[]; failed: RawJob[]; running: RawJob[]; succeeded: RawJob[] } {
  const job = (name: string, id: string, o: Partial<RawJob>): RawJob => ({ jobName: name, jobId: id, jobArn: `arn:aws:batch:${REGION}:${ACCT}:job/${id}`, jobDefinition: DEFINITION, ...o });
  return {
    runnable: [job("monthly-revenue-report", "0acme0b9-1111-4222-8333-000000000001", { createdAt: now - 95 * MIN, status: "RUNNABLE" })],
    failed: [job("nightly-export", "0acme0b9-1111-4222-8333-000000000002", { createdAt: now - 2 * DAY - 30 * MIN, startedAt: now - 2 * DAY - 28 * MIN, stoppedAt: now - 2 * DAY - 20 * MIN, status: "FAILED", statusReason: "Essential container in task exited" })],
    running: [],
    succeeded: [job("nightly-report", "0acme0b9-1111-4222-8333-000000000003", { createdAt: now - 10 * 60 * MIN, startedAt: now - 10 * 60 * MIN + 2 * MIN, stoppedAt: now - 9 * 60 * MIN, status: "SUCCEEDED" })],
  };
}

export function simBatch(region: string, now: number = Date.now()): BatchInput {
  if (region !== REGION) return { environments: [], queues: [], definitions: [] };
  const jobs = simBatchJobs(now);
  return {
    environments: [
      {
        computeEnvironmentName: BATCH.environment.name, computeEnvironmentArn: BATCH.environment.arn, type: "MANAGED", state: "ENABLED", status: "VALID", statusReason: "ComputeEnvironment Healthy",
        ecsClusterArn: `arn:aws:ecs:${REGION}:${ACCT}:cluster/AWSBatch-${BATCH.environment.name}-0acme0b9-2222-4333-8444-000000000001`, containerOrchestrationType: "ECS",
        computeResources: {
          type: "SPOT", allocationStrategy: "SPOT_PRICE_CAPACITY_OPTIMIZED", minvCpus: 0, maxvCpus: 64, desiredvCpus: 4, instanceTypes: ["optimal"],
          instanceRole: IAM_ROLES.ecsInstance.instanceProfile, subnets: [...EXISTING.subnets.production],
        },
        tags: { Environment: "production", Team: "data" },
      },
    ],
    queues: [
      {
        jobQueueName: BATCH.queue.name, jobQueueArn: BATCH.queue.arn, state: "ENABLED", status: "VALID", statusReason: "JobQueue Healthy", priority: 10,
        computeEnvironmentOrder: [{ order: 1, computeEnvironment: BATCH.environment.arn }], tags: { Environment: "production", Team: "data" },
        jobs: { runnable: jobs.runnable, running: jobs.running, failed: jobs.failed, succeeded: jobs.succeeded }, enrichment: { jobs: "ok" },
      },
    ],
    definitions: simBatchDefinitions(),
  };
}
