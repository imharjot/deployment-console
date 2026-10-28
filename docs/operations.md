# Operations reference

Every capability an agent or a script can use is an **operation**: a stable name (`<area>.<verb>`), a JSON Schema for
its input, a risk level and the permission it needs. Call one with `POST /api/ops/<name>` and `{ "input": { … } }`, or
as an MCP tool named with `_` instead of `.` (`services.restart` → `services_restart`). New to this? Start with
[Agents & API](automation.md), which covers tokens, modes and approvals. The live list, with input schemas and a
copyable curl example for each operation, is under **Automation → Operations**, and `GET /api/ops` returns it for the
caller.

**Risk**: *read* has no side effects · *change* alters what already runs and can be undone (restarts, scaling within
`provisioning.maxTasks`, variable edits, a one-off task with the task definition's own command) · *danger* can't be
undone, starts new resources you pay for, runs a command or code you chose, or reaches real consumers (deleting a
service, terminating a host, copying a service, adding hosts, a one-off task with a command override; on the cloud map,
deploying new Lambda code or a new ECS image, sending a test message to an SQS queue, publishing a test message to an
SNS topic…). With an API token, *danger* always needs a person's approval, whatever the token's mode. **Role** is the least role that may call it;
the second role applies on protected (production-like) environments. With an API token, a *change* or *danger*
operation may come back as an approval request instead of running — see
[the mode table](automation.md#tokens-and-modes).

Operations call the same server code as the UI's buttons, so every guard, lock, typed confirmation, reason and audit
row applies unchanged. Most change operations take `confirm` (and `reason`, required on protected environments); a dry
run (`"dryRun": true`) returns the plan, whose `confirm` field is the exact text to type. A *read* token can't dry-run
a change or *danger* operation: the mode applies to plans too. `hosts.power` and
`databases.power` take `confirm: "yes"` only (they never run on protected environments), and `costs.refresh` takes no
input.

## Environments and status

| Operation | Risk | Role | What it does |
|---|---|---|---|
| `envs.list` | read | viewer | Every discovered environment: id, label, protected, region, cluster, branch, worst state and per-state counts, and when the sampler last read it (`stale` when not sampled for 90 s: worst state unknown). |
| `envs.status` | read | viewer | One environment's services, hosts, databases, caches and load balancer: state, reasons, running/desired tasks, revision, image tag and sha, rollout in progress, what can be done now. Problems first. |
| `issues.list` | read | viewer | Everything down, degraded or unreadable across all environments, worst first, with reasons and since when; also stale environments and EC2 hosts that never joined their cluster. |

## Services

| Operation | Risk | Role | What it does |
|---|---|---|---|
| `services.get` | read | viewer | One service in detail: state, tasks, live revision, deployments and rollout reasons, recent tasks with stop reasons and exit codes, possible actions and why others are blocked. |
| `services.events` | read | viewer | Recent ECS service events, newest first. |
| `services.revisions` | read | viewer | Task-definition revisions with image, commit and CI result; an image check per essential ECR container (present, missing or unknown; public images are named, not checked), a warning when a moving tag (`latest`, `v1.2`) may now point elsewhere, and whether migrations changed (true, false or unknown — a tag without a git sha is unknown). |
| `services.restart` | change | developer · operator | New deployment of the same revision (rolling). Returns the operation id with `verification: accepted`; `services.get` shows it verified or failed (did not stabilise within 15 min). |
| `services.stop` | change | developer · operator | Desired count → 0; the count is remembered for start. Returns the operation id with `verification: accepted`. |
| `services.start` | change | developer · operator | Starts a stopped service with its remembered count (or 1). Returns the operation id with `verification: accepted`. |
| `services.switch` | change | developer · operator | Rolls back or forward to another revision; `migrationAck` required when migrations changed or couldn't be checked. Refused when an essential container's image is no longer in ECR. Returns the operation id with `verification: accepted`. |
| `services.scale` | change | operator · admin | Sets a running service's desired task count without a new deployment (up to the configured maximum). Warns when Application Auto Scaling would override the count. |
| `services.create` | danger | operator · admin | Creates a new Fargate service from an image, with its own security group, on the subnets, execution role and log group of a service already in the environment (never its task role or variables). |
| `services.clone` | danger | operator · admin | Creates a new service in an environment as a copy of an existing one (optionally another image or Fargate size). |
| `services.delete` | danger | operator · admin | Deletes a service the console created (tagged `console:created=true`), and the security group the console made for it. Irreversible; name as confirmation and a reason always. |
| `services.deleteGroup` | danger | operator · admin | Deletes a security group the console made for a service that is gone, once nothing uses it (AWS keeps it while the service's tasks stop). Group id as confirmation and a reason always. |
| `tasks.run` | change; **danger** with a `command` | developer · operator | Runs one task from a service's task definition outside the service (migrations, smoke tests), optionally with another command. With a command, a token's request always needs a person's approval. |

## Hosts and databases

| Operation | Risk | Role | What it does |
|---|---|---|---|
| `hosts.power` | change | operator | Starts or stops an EC2 container instance. Never on protected environments or Auto Scaling group members. |
| `hosts.add` | danger | operator · admin | Launches EC2 hosts like an existing container instance of the environment, up to `provisioning.maxHosts` (default 3) console-created hosts per environment. Hosts still joining the cluster and launches in flight count toward the cap; one launch per cluster at a time (409). |
| `hosts.terminate` | danger | operator · admin | Terminates a host the console launched. Irreversible; instance id as confirmation and a reason always. |
| `databases.power` | change | operator | Starts or stops an RDS instance. Never on protected environments or Aurora members. |

## Logs and metrics

| Operation | Risk | Role | What it does |
|---|---|---|---|
| `logs.recent` | read | viewer | Latest log lines of one or more services, optionally only lines containing some text. Capped at about 60 KB. |
| `logs.search` | read | viewer | Searches logs over the last N minutes (up to 24 h) literally or with a CloudWatch filter pattern. |
| `metrics.get` | read | viewer | CloudWatch metrics of a service, host, database or the load balancer, summarised per series with up to 30 points. |

## Environment variables

| Operation | Risk | Role | What it does |
|---|---|---|---|
| `variables.list` | read | viewer | Variable names and where each lives (task definition, SSM, Secrets Manager, S3 env file) — never values. A reference other services read lists them (`sharedWith`, as `env/service`), with `lockedWhy` when it can't be changed here; `protected` says whether a save follows the protected rules. |
| `variables.update` | change | developer · operator | Changes plain values (new revision + deploy), secret values or env files (then restart). Values are hidden in approvals and never echoed back. A save that changes a reference a protected service also reads follows the protected rules even on an unprotected environment: the operator role, the service name and a reason, and with an API token an approval. |
| `variables.compare` | read | developer · operator | Compares services' variables across environments against the first one: per name and environment `same`, `different`, `missing` or `unknown`, and whether a variable is stored differently. Values and their fingerprints (server-side keyed digests) never leave the console. Comparing with a protected environment needs the operator role. |

There is deliberately **no operation that reveals values**: an agent can write a value it was given, never read one. A
difference `variables.compare` finds is a task for a person in the Variables editor; agents can never change variables.

## CI and releases

| Operation | Risk | Role | What it does |
|---|---|---|---|
| `ci.runs` | read | viewer | Recent GitHub Actions runs of one repository, or of the repositories mapped to services (up to 10). |
| `ci.rerun` | change | developer · operator | Re-runs a completed run. `mode: "tests"` re-runs the failed jobs and is refused for a workflow that deploys; `"redeploy"` re-runs every job. A workflow bound to an environment (`ci.deployments`, the `console:deploy-workflow` tag), or an unbound one on a protected environment's branch, counts as a deploy there. Returns the operation id. |
| `releases.compare` | read | viewer | What each environment runs per service, and what the next environment in promotion order would receive (commits, migrations). |

## Costs

| Operation | Risk | Role | What it does |
|---|---|---|---|
| `costs.summary` | read | operator | Actual AWS spend from Cost Explorer: month to date, forecast, top services, per environment and ECS service, anomalies. |
| `costs.estimate` | read | operator | List-price estimate of what runs now, per environment and resource, in USD per month. |
| `costs.refresh` | change | operator | Takes a new Cost Explorer snapshot now (a few billed requests), then returns the summary. |

## Notes

| Operation | Risk | Role | What it does |
|---|---|---|---|
| `notes.list` | read | viewer | The notes people left on one resource (by its key: an ARN, or `ecs:service/<cluster>/<service>`, `rds:<id>`, …), pinned first, then newest. |
| `notes.search` | read | viewer | Searches every note by text, tag and environment, most recently written first; long bodies are cut. |
| `notes.add` | change | developer | Leaves a plain-text note (≤ 10,000 characters, ≤ 10 tags) on a resource, written as `<owner> via token "<name>"`. Audited without the text. See [Notes](notes.md). |

## Cloud map

Everything the console found in the account — ECS, load balancers, databases, and whatever the other providers list
(Lambda, queues, topics, DNS, CDN, buckets…) — with the connections between them. See [Cloud map](cloud-map.md).

`cloud.action` takes the provider action's own risk and role, and decides "protected" exactly like the map's runner:
any hint of a protected environment, the tag `console:protected=true`, or no environment at all (unless
`inventory.unassignedProtected` is `false`) — so with an *act* token, a change on such a resource waits for a person
too. Lambda `deploy-code`, ECS `deploy-image`, SQS `send-test-message` and SNS `publish-test` are *danger*.

| Operation | Risk | Role | What it does |
|---|---|---|---|
| `cloud.map` | read | viewer | Counts by kind, AWS service, map layer, environment (and region with several regions); resources with problems, idle resources, resources pending deletion confirmation, and providers that were denied; with `env`, `kind`, `service`, `region`, `layer` or `q`, also the matching resources (keys for the calls below). Hidden AWS-managed resources aren't counted. |
| `cloud.get` | read | viewer | One resource: properties, environment and why, health, idle mark, notes count, and every connection with its kind, confidence and evidence. |
| `cloud.actions` | read | viewer | Actions for one resource with their input schemas, risk, permission, whether you may run them and why one is blocked. |
| `cloud.action` | the action's own (change or danger) | the action's own role | Runs one of those actions through the same guarded runner as the map: dry run first, the plan's `confirm` text (the resource name for dangerous actions and protected environments, plus a `reason`), lock, audit log. |

## Runs, workflows and outcomes

Agent and workflow runs, and what happened to the changes they (or anyone) made. An agent sees only its own run and
that run's operations; an API token sees its owner's runs and its own operations; people see the runs they started
(admins: all) and every operation. See [Agents & API](automation.md).

| Operation | Risk | Role | What it does |
|---|---|---|---|
| `runs.start` | change | developer | Starts a published workflow by id (with its `inputs` and an optional `resourceKey`) or an assistant run with a `goal` and the `connectionId` that pays, acting for the caller with their current role. Refused when the workflow has no manual trigger, is disabled, or one of its limits (concurrent runs, cooldown, attempts per resource) holds. Agents can never start runs. |
| `runs.get` | read | viewer | One run: state, steps with their state and errors, the operations it made with outcome and verification, and approval requests still waiting for a person. |
| `runs.list` | read | viewer | Recent runs, newest first: kind, title, state, workflow and version, the resource it is about. |
| `workflows.list` | read | viewer | Workflows: newest version, state (draft, published, disabled), triggers, mode and when it was published. |
| `operations.get` | read | viewer | One change by its operation id: action, target, environment, who, state (`outcome_unknown` = AWS may have acted — check before trying again), verification and times. Never its parameters, hashes or raw result. Use it instead of sending a change again. |
| `operations.list` | read | viewer | Recent operations with the same safe fields, optionally by `state` or `runId`. |

## Audit and approvals

| Operation | Risk | Role | What it does |
|---|---|---|---|
| `audit.recent` | read | viewer | The audit log, newest first, optionally for one environment or action prefix. |
| `approvals.list` | read | viewer | Approval requests and their state. A token sees only its own; people without a request's permission see only its summary. |
| `approvals.get` | read | viewer | One approval request: status, and once it ran, the result or error; a rejection's reason is in `detail`. |

Deciding an approval is not an operation: only a person signed in to the console can approve or reject.
