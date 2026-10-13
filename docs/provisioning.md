# Create & scale

For testing and growth: copy a service (a canary, a load-test copy, a worker for a one-off job), scale it, run a
one-off task such as a migration, and add EC2 capacity like the hosts you already have — then remove what you created.
The console only ever deletes what it created itself.

These features need write permissions the read-only policy doesn't have; see [Turn it on](#turn-it-on).

| Action | Where | Role (unprotected · protected env) | Confirmation |
|---|---|---|---|
| **Copy a service** | overview → **New**, or a service's **Copy** | operator · admin | one click · new name + reason |
| **Scale** | a service's **Scale** | operator · admin | one click · service name + reason |
| **Run task** | a service's **Run task** | developer · operator | one click · service name + reason |
| **Add EC2 host** | overview → **New**, or a host's **Add host like this** | operator · admin | one click · environment id + reason |
| **Delete service** | a console-created service's **Delete** | operator · admin | service name + reason, always |
| **Terminate host** | a console-created host's **Terminate** | operator · admin | instance id + reason, always |

Every action is two steps: fill in the form, then **Review plan** shows what will happen — every change, warnings and a
monthly cost estimate — computed by a dry run of the same server code that then acts. Confirm there. The overview
**New** menu also lists everything the console created in the environment, so cleanup is one click away.

## Copy a service

Pick any service of any environment in the target environment's region, name the copy (the name is also its task-definition family), and
optionally give it another image (a full URI with a tag or digest; limited to `provisioning.allowedImageRegistries`
when set) or — on Fargate — another CPU/memory size (only valid Fargate sizes are offered). Start with 0 tasks to
create it stopped.

| Copied | Not copied |
|---|---|
| the live task definition: containers, image (unless replaced), variables, secret references, env files, task and execution roles, health checks, volumes, runtime platform | load balancers / target groups — the copy gets no load-balancer traffic |
| launch type or capacity provider strategy, platform version, placement constraints and strategy | Service Connect and service discovery |
| ECS Exec setting | auto scaling policies |
| the source's own task-definition tags, and its `console:repo`, `console:role`, `console:migrations` service tags | `console:name`, `console:healthcheck`, `console:self` (the copy isn't at the source's URL) |

- **Logs** go to the same log group as the source, with the stream prefix set to the new name, so the two never mix.
- **Networking** (awsvpc): in the same environment, the source's subnets, security groups and public-IP setting. Into
  another environment, those of a service already running there — one with the source's name if there is one, else
  one with the same launch type — and the plan names it. Never the console's own service. If no service there uses
  awsvpc, the copy is refused. Host and bridge networking have nothing to choose.
- **Deployment**: the circuit breaker is on (a copy that can't start rolls back instead of looping).
- **Variables are the source's.** A copy talks to whatever the source talks to — its database, queues, APIs. Copying
  across environments, create it with 0 tasks, check its **Variables** tab, then start it.

Refused: the console's own service (the copy would carry the console's role); copying **out of a protected environment
into an unprotected one** (its variables and secret references would become readable by developers); a name already
used in the cluster; a task-definition family of that name that the console didn't create (a new revision there could
change what another service or a deploy pipeline runs); EC2 services into a cluster without container instances;
capacity providers the target cluster doesn't have; more than `provisioning.maxTasks` tasks.

## Scale

Sets a running service's desired count to 1…`provisioning.maxTasks` (default 10) without a new deployment. Stop and
start stay in the regular [actions](actions.md) (a stopped service is refused: start it first). Refused during a
rollout and for the console's own service. The plan warns when host networking limits placement (each task binds the
same host ports, so one task per EC2 host), when EC2 capacity may run out, and, when Application Auto Scaling manages
the service, that a count outside its minimum–maximum is overridden by the autoscaler — its next scaling activity sets
the nearest bound (change the scalable target instead) — or that its policies may change the count again. The estimate
is the monthly Fargate change.

## Run a one-off task

Starts one task from the service's current task definition with the service's launch type, networking, variables,
secrets and role — for a migration, a smoke test or a script. It runs outside the service and isn't replaced when it
exits. Optionally override the command of one container: one line, split into arguments like a shell would (quotes
group words, nothing is expanded — start with `sh -c '…'` if you need a shell). The result gives the task id and where
its logs go (the container's `awslogs` group and `<prefix>/<container>/<task id>` stream); **Open logs** in the toast
goes to the service's logs.

- The task can change whatever the service can: that's the point, and why it needs the same role as restarting.
- The command is recorded in the console's audit log (up to 2,000 characters), and it is visible in the task's
  details in ECS and in CloudTrail — don't put secrets in it.
- A one-off task **with a command** counts as a *dangerous* operation for agents: an API token's request for one
  always needs a person's approval, even in *act* mode, and a *read* token can't ask at all (see
  [Agents & API](automation.md#tokens-and-modes)).
- With host networking, the task binds the same host ports as the service and can't be placed on a host where the
  service already runs.
- Refused for the console's own service and for containers not in the task definition.

## Add an EC2 host

Launches one or more instances like an existing container instance of the environment — at most
`provisioning.maxHosts` (default 3) console-created hosts per environment, counting the ones in the cluster, instances
launched for it that haven't joined yet and launches still in flight. A launch is reserved before EC2 is called; a host
that hasn't joined the cluster 15 minutes after launch is reported as an issue and its operation is marked failed:

- **Launched from a launch template** (the instance carries `aws:ec2launchtemplate:id` / `version`): the same template
  and version, in the source's subnet unless the template defines network interfaces. The template decides the AMI,
  security groups, instance profile and user data.
- **Otherwise**: the same AMI, subnet, security groups, IAM instance profile, key pair, IMDS settings and user data (read
  on the server, never shown). Extra EBS volumes, the root volume size, Elastic IPs and a public IP are not copied.

Optionally another instance type (limited to `provisioning.allowedInstanceTypes` when set). New hosts are named
`<source name>-<n>` and join the cluster if their user data (or AMI) registers them there — usually within a few
minutes. A host in an **Auto Scaling group** is refused: scale the group instead.

## Remove what the console created

**Delete service** sets the desired count to 0 and deletes the service. Its task definitions are kept — harmless, and
they keep the history; deregister the family in AWS if you want it gone. **Terminate host** terminates the instance;
tasks on it stop and ECS places service tasks on the remaining hosts if they have room (the plan warns when no other
host is running).

Both work **only on resources tagged `console:created=true`** — never on anything discovered, never on the console's
own service — and always ask for the name (or instance id) and a reason, even on unprotected environments. They stay
available when `provisioning.enabled` is `false`, so a team can always clean up.

## Always true

- Everything is validated before any AWS call; unknown fields in a request are rejected, not ignored.
- Roles are checked on the server (`provision`: operator, `provision:protected`: admin; run task uses `act` /
  `act:protected`). Buttons are drawn with the same guards and say why they're disabled.
- **For agents:** copying a service, adding hosts, deleting, terminating and a one-off task with a command are
  *danger* operations — an API token's request always waits for a person's approval, even in *act* mode. Scaling and a
  one-off task with the task definition's own command are *change*: an *act* token runs them on unprotected
  environments. See [Agents & API](automation.md#tokens-and-modes).
- Every run goes through the mutation coordinator: one change per service at a time (shared with restart, stop, start,
  switch, variable edits and map actions), one host launch or termination per cluster at a time; a second request gets
  409. Under that lock the console reads the service or hosts again and re-runs every check (including
  `provisioning.maxHosts`) before the audit intent, so launches started together can't pass the cap. Runs answer 202
  with an `operationId`; one-off tasks and host launches carry an idempotency token derived from it, so a retried
  request can't start them twice. Scale and delete are then verified like the other actions ([AWS accepted isn't
  done](actions.md#always-true)).
- Buttons are disabled when the console's AWS identity can't make the change, with a warning when it probably can't
  (Settings → AWS permissions); plans say the same.
- Every change writes an audit **intent** before calling AWS and a **result** after; no intent, no change. Audit
  parameters hold names, ids and counts, plus a one-off task's command — never variable values or user data.
- The shipped IAM policy enforces the tag too: services, one-off tasks and instances can only be created carrying
  `console:created=true`, and only such resources can be deleted or terminated.

## Tags

| Tag | On | Meaning |
|---|---|---|
| `console:created=true` | copied services (and their tasks, via `propagateTags`), their task definitions, one-off tasks, new instances and their volumes | made by the console; the only resources it will delete |
| `console:created-from` | the same | the source: `<env>/<service>` or the source instance id |

## Cost estimates

Plans show a monthly list-price estimate from the same tables as [Costs](costs.md) (us-east-1 on-demand, adjustable
with `pricing` in `console.config.json`): Fargate tasks by vCPU and memory (ARM 20 % less), EC2 hosts by instance type
(EBS not included). Services on EC2 capacity cost nothing extra until the cluster needs another host. One-off Fargate
tasks show an hourly figure. Estimates ignore Savings Plans, Spot and credits.

## Configuration

All optional, in `console.config.json`:

```json
{
  "provisioning": {
    "enabled": true, "maxTasks": 10, "maxHosts": 3,
    "allowedInstanceTypes": ["t3a.medium", "t3a.large"],
    "allowedImageRegistries": ["123456789012.dkr.ecr.us-east-1.amazonaws.com"]
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `provisioning.enabled` | `true` | `false` turns off copy, scale, run task and add host (delete and terminate stay available) |
| `provisioning.maxTasks` | `10` | most tasks a service may be created or scaled to (1–1000) |
| `provisioning.maxHosts` | `3` | most console-created EC2 hosts per environment (0–100; `0` means no new hosts) |
| `provisioning.allowedInstanceTypes` | any | instance types new hosts may use, for example `["t3a.medium"]` |
| `provisioning.allowedImageRegistries` | any (for **Deploy image** on the cloud map: the registry the container already uses) | where the image of a copy may come from when you replace it, and a new image deployed from the [cloud map](cloud-map.md#actions): registry hosts or host/path prefixes, matched on whole path segments (`ghcr.io/acme` allows `ghcr.io/acme/api`, not `ghcr.io/acme-evil/api`). Recommended: your own ECR registry |

## API

Agents and scripts use the same code through the operations `services.clone`, `services.scale`, `tasks.run`,
`hosts.add`, `services.delete` and `hosts.terminate`, with an API token — see [Operations reference](operations.md)
and [Agents & API](automation.md). For example, the plan for scaling `api` in staging to 3 tasks:

```bash
curl -sS -X POST "$CONSOLE_URL/api/ops/services.scale" -H "Authorization: Bearer $CONSOLE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":{"env":"staging","service":"api","desired":3,"confirm":"yes"},"dryRun":true}'
```

The UI itself calls `POST /api/provision/<action>` (a signed-in session only; API tokens can't reach it) with a JSON
body; `?dryRun=1` (or `"dryRun": true`) returns the plan without touching AWS. It fails safe: any `dryRun` other than
an explicit `false` or `0`, in the query or the body, means plan only. (The operations API is stricter: its `dryRun`
must be a boolean.) A run also takes `confirm` (the plan's `confirm.expected`) and, when `confirm.needReason` is true,
a `reason`.

| Action | Body |
|---|---|
| `clone` | `{ env, sourceEnv, source, name, desired, image?, cpu?, memory? }` |
| `scale` | `{ env, service, desired }` |
| `run-task` | `{ env, service, container?, command?: ["npm", "run", "db:migrate"] }` |
| `add-host` | `{ env, from: "i-…", count, instanceType? }` |
| `delete-service` | `{ env, service }` |
| `terminate-host` | `{ env, id: "i-…" }` |

The plan: `{ action, env, summary, changes[], warnings[], estimate?: { monthlyUsd, note }, confirm: { expected,
needReason }, risk }`. `GET /api/provision?env=<id>` returns what the UI needs to draw these buttons (limits, role
gates, services and hosts with the facts the guards read; `&sources=1` adds every service in the region that may be
copied).

## Turn it on

Add these statements from `infra/iam-policy.json` to the console's role (see
[Connect AWS](connect-aws.md#step-5-turn-on-more-one-feature-at-a-time)). The read-only policy has none of them.

| Statement | Grants | What it risks |
|---|---|---|
| `CreateServicesTaggedByTheConsole` | `ecs:CreateService`, only with the request tag `console:created=true` | new services that run your images with your services' roles and variables, and cost money |
| `DeleteOnlyConsoleCreatedServices` | `ecs:DeleteService`, only on services tagged `console:created=true` | deleting copies the console made; never anything else |
| `RunOneOffTasks` | `ecs:RunTask` on your task definitions, only with the request tag `console:created=true` | a one-off task can do whatever the service it copies can do (that's the point of a migration) |
| `LaunchHostsTaggedByTheConsole`, `LaunchHostsFromExistingSettings`, `TagHostsAtLaunchOnly` | `ec2:RunInstances` (the instance and its volumes must carry `console:created=true`), using existing AMIs, subnets, security groups, key pairs and launch templates; `ec2:CreateTags` only at launch | new EC2 instances, which cost money |
| `TerminateOnlyConsoleCreatedHosts` | `ec2:TerminateInstances`, only on instances tagged `console:created=true` | terminating hosts the console launched; never anything else |
| `ReadHostUserDataToCopyIt` | `ec2:DescribeInstanceAttribute` | reading hosts' user data, which often holds secrets (it never leaves the server) |
| `PassInstanceProfileRolesToNewHosts` | `iam:PassRole` to `ec2.amazonaws.com` | new hosts get the same instance profile as the host they copy |

Copying and scaling also use `ServiceActions` (`ecs:UpdateService`) and `EditVariablesNewRevision`
(`ecs:RegisterTaskDefinition`) with `PassTaskRolesToNewRevisions`. Keep the denies at the end of the policy:
`NeverActOnTheConsoleItself` (no update or delete of the console's own service), `NeverRunTheConsolesTaskDefinition`
and `NeverCreateAServiceFromTheConsole` (no task or service from the console's task family),
`NeverPassTheConsolesOwnRole` (nothing else gets the console's role) and `NeverStopOrScaleTheConsolesOwnHost` (no
stop, reboot, terminate or scaling of anything tagged `console:self=true`). `NeverRunTheConsolesTaskDefinition`,
`NeverCreateAServiceFromTheConsole` and `NeverPassTheConsolesOwnRole` use the names in `infra/task-definition.json`
(`deployment-console`, `deployment-console-task`); change them if yours differ.

To cap what people can create, set `provisioning.maxTasks`, `provisioning.maxHosts`,
`provisioning.allowedInstanceTypes` and `provisioning.allowedImageRegistries` in the config file. To turn the feature off, set `provisioning.enabled` to `false`
and leave these statements out; the rest of the console keeps working.

## Limitations

- Copies stay in one region: the source must be in the target environment's region (a copy across regions is refused).
- No load balancer, Service Connect, service discovery or auto scaling for copies — add those in your infrastructure
  code if a copy should take real traffic.
- A copy keeps the source's roles and variables; the console doesn't create IAM roles, secrets or log groups.
- EC2 hosts copied without a launch template don't copy extra volumes, the root volume size or Elastic IPs.
- Task definitions of deleted copies stay registered (by design).
