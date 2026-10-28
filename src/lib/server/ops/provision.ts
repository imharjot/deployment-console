// Create & scale as agent operations: create a service from an image or as a copy, scale it, run a one-off task, add
// an EC2 host, and delete what the console created. plan() and run() call the same server functions as POST /api/provision/<action>
// (src/lib/server/provision.ts), so roles, the pure guards, typed confirmations, the mutation coordinator (canonical
// keys, live re-checks, audit intent first) and the audit log all apply; the registry (./index.ts) adds schema
// validation, the role check and token modes in front. Outputs carry names, ids, counts, plan text and the operation id.
import "server-only";
import { DEFAULT_SIZE, FARGATE_CPU, type ProvisionPlan } from "../../provision.ts";
import {
  planAddHost, planClone, planCreate, planDeleteGroup, planDeleteService, planRunTask, planScale, planTerminateHost, runAddHost, runClone, runCreate, runDeleteGroup,
  runDeleteService, runRunTask, runScale, runTerminateHost, type Who,
} from "../provision.ts";
import { defineOps, type JsonSchema, type OpContext, type Operation, type Plan } from "./types.ts";

const obj = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const ENV: JsonSchema = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$", description: "Environment id, from envs.list." };
const SERVICE: JsonSchema = { type: "string", pattern: "^[A-Za-z0-9_-]{1,255}$", description: "ECS service name: the `id` of a service in envs.status." };
const INSTANCE: JsonSchema = { type: "string", pattern: "^i-[0-9a-f]{8,17}$", description: "EC2 instance id (i-…) of a host in envs.status (kind \"box\")." };
const CONFIRM: JsonSchema = {
  type: "string",
  maxLength: 300,
  description: 'Confirmation text: exactly the `confirm` of a dry run\'s plan — "yes" for changes on non-protected environments, otherwise a name (the service name, the new service name, the environment id for new hosts). When a person approves the request, their typed text is used.',
};
const REASON: JsonSchema = { type: "string", maxLength: 500, description: "Why. Required on protected environments (the plan says so); at least 3 characters; stored in the audit log." };
const REASON_ALWAYS: JsonSchema = { ...REASON, minLength: 3, description: "Why this is being removed (at least 3 characters); stored in the audit log." };

const who = (ctx: OpContext): Who => ({ user: ctx.user, actor: ctx.actor, ip: ctx.ip, via: ctx.via, tokenId: ctx.tokenId, approval: ctx.approval });
// The registry's plan: `confirm` is the text an approver types ("yes" = one click); the reason stays the caller's.
const toPlan = (p: ProvisionPlan): Plan => ({
  summary: p.summary, changes: p.changes, estimate: p.estimate, confirm: p.confirm.expected,
  warnings: [...p.warnings, ...(p.confirm.needReason ? ["Needs a `reason` (at least 3 characters) — it goes to the audit log."] : [])],
});
const op = <I,>(o: Operation<I>) => o;
const byEnv = (i: { env: string }) => i.env;

type CloneIn = { env: string; sourceEnv: string; source: string; name: string; image?: string; desired: number; cpu?: number; memory?: number; confirm: string; reason?: string };
type CreateIn = { env: string; name: string; image: string; port?: number; desired: number; cpu?: number; memory?: number; confirm: string; reason?: string };
type DeleteGroupIn = { env: string; id: string; confirm: string; reason: string };
type ScaleIn = { env: string; service: string; desired: number; confirm: string; reason?: string };
type RunIn = { env: string; service: string; container?: string; command?: string[]; confirm: string; reason?: string };
type AddHostIn = { env: string; from: string; count: number; instanceType?: string; confirm: string; reason?: string };
type DeleteIn = { env: string; service: string; confirm: string; reason: string };
type TerminateIn = { env: string; id: string; confirm: string; reason: string };

export const ops = defineOps([
  op<CloneIn>({
    name: "services.clone",
    title: "Copy a service",
    description:
      "Creates a new ECS service in `env` as a copy of an existing one (`sourceEnv`/`source`, any environment of this region): registers a task-definition family named like the new service from the source's live revision (optionally with another image or, for Fargate, another CPU/memory size), then creates the service with the source's launch type or capacity providers. Networking comes from the source (same env) or from a service already in the target env (the plan says which). Environment variables, secret references and IAM roles are copied as they are — the copy talks to what the source talks to. Load balancers, Service Connect, service discovery and auto scaling are NOT copied. Tagged console:created=true so it can be deleted later with services.delete. Use it for canaries, test copies and one-off workers; create with desired 0 across environments and review variables first. Refuses: the console's own service, copying from a protected env into an unprotected one, names already used (or a task-definition family the console didn't create), invalid Fargate sizes, image references without a tag or digest, more than provisioning.maxTasks tasks, no donor network in the target env, missing capacity. Dry run first: the plan lists every change, warnings and a monthly list-price estimate. Returns the new service name and task-definition ARN.",
    risk: "danger",
    perm: "provision",
    input: obj(
      {
        env: { ...ENV, description: "Environment id to create the service in." },
        sourceEnv: { ...ENV, description: "Environment id of the service to copy (may equal env)." },
        source: { ...SERVICE, description: "ECS service name to copy." },
        name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$", description: "Name of the new service (also its task-definition family). Must be unused in env's cluster." },
        image: { type: "string", maxLength: 255, description: "Optional full image URI with a tag or digest for the main container, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/api:1.4.2. Default: the source's image." },
        desired: { type: "integer", minimum: 0, description: "Tasks to start: 0 (created stopped) up to provisioning.maxTasks (default 10)." },
        cpu: { type: "integer", enum: FARGATE_CPU, description: "Fargate only: task CPU units (1024 = 1 vCPU). Must form a valid Fargate size with memory." },
        memory: { type: "integer", minimum: 512, maximum: 122880, description: "Fargate only: task memory in MiB, valid for the CPU size (e.g. 256 CPU → 512, 1024 or 2048)." },
        confirm: CONFIRM,
        reason: REASON,
      },
      ["env", "sourceEnv", "source", "name", "desired", "confirm"],
    ),
    env: byEnv,
    plan: (i, ctx) => planClone(i, who(ctx)).then(toPlan),
    run: (i, ctx) => runClone(i, who(ctx)),
  }),
  op<CreateIn>({
    name: "services.create",
    title: "Create a service from an image",
    description:
      "Creates a new ECS service in `env` that runs one container from `image` on Fargate: its own security group in the environment's VPC (no inbound rules: nothing can reach it yet), a task-definition family named like the service, and the service on the subnets of a service already running in the environment (one with awsvpc networking, an execution role and CloudWatch logs; the plan names it). It borrows that service's execution role (to pull the image and write logs) and log group (stream prefix = the new name) — never its task role, variables or secrets: the new app gets no AWS permissions and no variables (add them afterwards with variables.update). Tagged console:created=true so services.delete removes it and its security group later. Use it to start something new; use services.clone to run a copy of something that exists. Refuses: names already used (or a task-definition family the console didn't create), image references without a tag or digest or outside provisioning.allowedImageRegistries, invalid Fargate sizes or ports, more than provisioning.maxTasks tasks, an environment with no service to borrow subnets, a role and a log group from (copy one instead). Dry run first: the plan lists every change, warnings and a monthly list-price estimate. Returns the service name, task-definition ARN and security group id.",
    risk: "danger",
    perm: "provision",
    input: obj(
      {
        env: { ...ENV, description: "Environment id to create the service in." },
        name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$", description: "Name of the new service (also its task-definition family and container). Must be unused in env's cluster." },
        image: { type: "string", maxLength: 255, description: "Full image URI with a tag or digest, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/api:1.4.2. Built for Linux/x86_64." },
        port: { type: "integer", minimum: 1, maximum: 65535, description: "The port the container listens on (TCP). Omit for a worker that listens on none." },
        desired: { type: "integer", minimum: 0, description: "Tasks to start: 0 (created stopped) up to provisioning.maxTasks (default 10)." },
        cpu: { type: "integer", enum: FARGATE_CPU, description: `Task CPU units (1024 = 1 vCPU). Default ${DEFAULT_SIZE.cpu}. Must form a valid Fargate size with memory.` },
        memory: { type: "integer", minimum: 512, maximum: 122880, description: `Task memory in MiB, valid for the CPU size. Default ${DEFAULT_SIZE.memory}.` },
        confirm: CONFIRM,
        reason: REASON,
      },
      ["env", "name", "image", "desired", "confirm"],
    ),
    env: byEnv,
    plan: (i, ctx) => planCreate(i, who(ctx)).then(toPlan),
    run: (i, ctx) => runCreate(i, who(ctx)),
  }),
  op<ScaleIn>({
    name: "services.scale",
    title: "Scale a service",
    description:
      "Sets a running service's desired task count to `desired` (1 to provisioning.maxTasks, default 10) without a new deployment. To stop a service use services.stop; to start a stopped one use services.start (scale refuses stopped services). Refuses the console's own service, services mid-rollout and a count equal to the current one. The plan warns when EC2 host networking or capacity limits how many tasks can be placed, when Application Auto Scaling manages the service (a count outside its min–max is overridden by the autoscaler — change the scalable target instead) and when the console's AWS identity probably can't make the change, and gives the monthly Fargate cost change. Returns the new desired count and the operation id.",
    risk: "change",
    perm: "provision",
    input: obj({ env: ENV, service: SERVICE, desired: { type: "integer", minimum: 1, description: "New desired task count (1..provisioning.maxTasks)." }, confirm: CONFIRM, reason: REASON }, ["env", "service", "desired", "confirm"]),
    env: byEnv,
    plan: (i, ctx) => planScale(i, who(ctx)).then(toPlan),
    run: (i, ctx) => runScale(i, who(ctx)),
  }),
  op<RunIn>({
    name: "tasks.run",
    title: "Run a one-off task",
    description:
      "Starts one task from a service's current task definition, outside the service (it isn't replaced when it exits), with the service's networking, launch type, variables, secrets and role — for a database migration, a smoke test or a maintenance script. Optionally overrides the command of one container (`command` as an argument list, exec form: [\"npm\", \"run\", \"db:migrate\"]; wrap in [\"sh\", \"-c\", \"…\"] only if you need a shell). A command override runs any code with the service's role, so for API tokens it always needs a person's approval, whatever the token's mode. Never put secrets in the command: it is recorded in the console's audit log and visible in ECS and CloudTrail. Refuses the console's own service and unknown containers. Returns the task ARN and id, and where its logs go (awslogs group and stream) — read them with the logs operations.",
    risk: "change",
    riskOf: (i) => (i.command?.length ? "danger" : "change"),
    perm: "act",
    input: obj(
      {
        env: ENV,
        service: SERVICE,
        container: { type: "string", pattern: "^[A-Za-z0-9_-]{1,255}$", description: "Container whose command to override (default: the service's main container)." },
        command: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4000 }, description: "Command override for that container, one argument per item. Omit to run the task definition's own command." },
        confirm: CONFIRM,
        reason: REASON,
      },
      ["env", "service", "confirm"],
    ),
    env: byEnv,
    plan: (i, ctx) => planRunTask(i, who(ctx)).then(toPlan),
    run: (i, ctx) => runRunTask(i, who(ctx)),
  }),
  op<AddHostIn>({
    name: "hosts.add",
    title: "Add EC2 capacity hosts",
    description:
      "Launches 1–3 EC2 instances like an existing container instance of the environment (`from`): from the same launch template and version when it was launched from one, otherwise with the same AMI, subnet, security groups, instance profile, key pair, IMDS settings and user data (which usually registers the instance into the cluster). Optionally another `instanceType`. Tagged console:created=true (terminate later with hosts.terminate). Use it when EC2 services lack room (pending tasks, host-networked services needing one host each). Refuses hosts in an Auto Scaling group (scale the group instead), more console-created hosts than provisioning.maxHosts per environment (default 3; hosts still booting and launches in flight count too), instance types outside provisioning.allowedInstanceTypes, and a second launch while one is being submitted for the same cluster (409). The plan gives a monthly on-demand estimate. Returns the new instance ids and the operation id; a host that hasn't joined the cluster 15 minutes later is reported as an issue.",
    risk: "danger",
    perm: "provision",
    input: obj(
      {
        env: ENV,
        from: INSTANCE,
        count: { type: "integer", minimum: 1, maximum: 100, description: "How many (the console allows up to provisioning.maxHosts console-created hosts per environment)." },
        instanceType: { type: "string", pattern: "^[a-z][a-z0-9-]*\\.[a-z0-9]+$", description: "Optional instance type, e.g. t3a.medium. Default: the source host's." },
        confirm: CONFIRM,
        reason: REASON,
      },
      ["env", "from", "count", "confirm"],
    ),
    env: byEnv,
    plan: (i, ctx) => planAddHost(i, who(ctx)).then(toPlan),
    run: (i, ctx) => runAddHost(i, who(ctx)),
  }),
  op<DeleteIn>({
    name: "services.delete",
    title: "Delete a console-created service",
    description:
      "Deletes a service the console created (tag console:created=true, e.g. from services.clone or services.create): sets its desired count to 0, then deletes it, and the security group the console made for it (when a stopping task still uses that group AWS keeps it: delete it later with services.deleteGroup — the result lists it as groupsLeft). Its task definitions are kept (harmless, they keep the history). Irreversible. Refuses every service without that tag and the console's own service. `confirm` must be the service name and `reason` is always required, on every environment. Returns the deleted service's name.",
    risk: "danger",
    perm: "provision",
    input: obj({ env: ENV, service: SERVICE, confirm: { ...CONFIRM, description: "The service name, exactly." }, reason: REASON_ALWAYS }, ["env", "service", "confirm", "reason"]),
    env: byEnv,
    plan: (i, ctx) => planDeleteService(i, who(ctx)).then(toPlan),
    run: (i, ctx) => runDeleteService(i, who(ctx)),
  }),
  op<DeleteGroupIn>({
    name: "services.deleteGroup",
    title: "Delete a security group a new service left behind",
    description:
      "Deletes a security group the console created for a service (services.create) after that service was deleted: AWS keeps a group while a stopping task still holds a network interface in it, so services.delete can leave it behind. Only groups tagged console:created=true and made for a service of `env`'s cluster, and only when no service there uses it; AWS refuses (DependencyViolation) while a task's network interface or another group's rule still refers to it — try again a minute later. `confirm` must be the group id and `reason` is always required. Returns the group id.",
    risk: "danger",
    perm: "provision",
    input: obj({ env: ENV, id: { type: "string", pattern: "^sg-[0-9a-f]{8,17}$", description: "Security group id (sg-…)." }, confirm: { ...CONFIRM, description: "The group id, exactly." }, reason: REASON_ALWAYS }, ["env", "id", "confirm", "reason"]),
    env: byEnv,
    plan: (i, ctx) => planDeleteGroup(i, who(ctx)).then(toPlan),
    run: (i, ctx) => runDeleteGroup(i, who(ctx)),
  }),
  op<TerminateIn>({
    name: "hosts.terminate",
    title: "Terminate a console-created EC2 host",
    description:
      "Terminates an EC2 host the console launched (tag console:created=true, e.g. from hosts.add). Tasks on it stop; ECS reschedules service tasks on the remaining hosts if they have room — the plan warns when no other host is running. Irreversible (its root volume is deleted). Refuses every instance without that tag. `confirm` must be the instance id and `reason` is always required. Returns the instance id.",
    risk: "danger",
    perm: "provision",
    input: obj({ env: ENV, id: INSTANCE, confirm: { ...CONFIRM, description: "The instance id, exactly." }, reason: REASON_ALWAYS }, ["env", "id", "confirm", "reason"]),
    env: byEnv,
    plan: (i, ctx) => planTerminateHost(i, who(ctx)).then(toPlan),
    run: (i, ctx) => runTerminateHost(i, who(ctx)),
  }),
]);
