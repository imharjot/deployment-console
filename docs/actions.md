# Actions & safety

The buttons that change running services: restart, stop/start, switch revision, and power for EC2 hosts and RDS
databases — and the cloud map's actions (see [Cloud map](cloud-map.md#actions)). Every action goes through the same
guard on the server that draws the button in the UI, so the two never disagree, and every action is written to the
audit log.

## What you can do

| Action | What it does | Refused when | Role (non-protected · protected) |
|---|---|---|---|
| **Restart** | a new deployment of the same revision (`forceNewDeployment`), replacing tasks in a rolling way | a rollout is in progress; the service is stopped | developer · operator |
| **Stop** | sets the desired count to 0 and remembers the previous count | the service is already stopped | developer · operator |
| **Start** | sets the desired count back to the remembered count (or 1) | the service isn't stopped; a rollout is in progress | developer · operator |
| **Switch revision** | rolls back or forward to any task-definition revision | a rollout is in progress; an essential container's image is no longer in ECR; database migrations changed between the two commits, or couldn't be checked (including image tags without a git sha), and you didn't acknowledge it | developer · operator |
| **Start/stop host** | powers an EC2 container instance | the environment is protected; the host is in an Auto Scaling group (the group would replace it) | operator |
| **Start/stop database** | powers an RDS instance | the environment is protected; the instance belongs to an Aurora cluster | operator |
| **Edit variables** | see [Environment variables](environment-variables.md) | | developer · operator |
| **Re-run CI** | *Redeploy* re-runs every job; *Re-run failed tests* only the failed ones | failed-only is refused for a workflow that deploys; a workflow bound to a protected environment, or an unbound one on its branch, counts as a deploy there | developer · operator |

Power actions are never available on protected environments, whatever your role. AWS starts a stopped RDS instance
again by itself after seven days. When Application Auto Scaling manages a service, it overrides a count outside its
min–max range: **Stop** and **Start** say so, and the service may come back to its minimum.

## Confirmations

- **Non-protected environment**: one click in a dialog.
- **Protected environment**: type what proves you mean it, plus a **reason** (at least 3 characters, stored in the
  audit log):

| Action on a protected environment | Type |
|---|---|
| Restart | the service name, for example `api` |
| Stop | `<environment>/<service>`, for example `production/api` |
| Switch revision | the target commit's short sha (or `switch` if the image tag has no commit) |
| Start | nothing to type; the reason is still required |

## Always true

- The console never acts on **its own** service, and the shipped IAM policy denies it too. If it runs on ECS but can't
  tell which service is its own (the task metadata endpoint doesn't answer and `CONSOLE_SELF` isn't set), it treats
  every service as possibly its own and refuses changes until it can tell.
- **One change per resource at a time, across every surface.** A restart, a variable save, a cloud-map action (deploy
  image, Lambda code, power…), a provisioning step or an agent's step on the same resource all take the same lock,
  whichever page or API they come from. A second change is refused with *another change to api is in progress
  (ecs-image.deploy-image by alice@acme.example)* until the first one finishes — not queued, and never interleaved (a
  deploy can't silently undo a variable edit made while it ran). The lock is also kept in the console's database, so
  two console tasks running side by side during an upgrade respect it too.
- Every change is an **operation**: an intent row in the audit log and an operation record are written together
  *before* AWS is called, and a result row after. If they can't be written, the change is refused. The audit log keeps
  ids, versions and sizes from the result — never a download link, a URL with a query string or a returned payload.
- **"AWS accepted" isn't "done".** A result says AWS accepted the request: **AWS accepted — verifying**. The background
  sampler then follows the service until it is steady on the new state (**verified**), or marks the change **did not
  stabilise** after 15 minutes. This applies to console actions, image deploys and provisioning's scale and delete;
  the toast, the service card and panel, `services.get` and the audit log show it, and every confirmation says what
  *done* means and how to undo it. When the console can't know whether AWS acted — the connection dropped after the request was sent, or the console
  restarted mid-change — the result is **outcome unknown**: *outcome unknown — check the resource before retrying*. The
  audit log records it as `unknown`. Check the resource before trying again: a retry is a new change, and for an action
  that isn't safe to repeat (sending a message, invoking a function, starting an execution) it could happen twice. An
  agent retrying the same request is refused until then, unless the action is safe to repeat.
- Task-definition `environment` values and `secrets` never appear in page data. There's no shell and no ECS Exec.
  The only free-text command is the optional command override of a one-off task
  ([Run task](provisioning.md#run-a-one-off-task)), which needs the same role as a restart, runs as a separate ECS
  task and is recorded in the audit log.
- **Read-only AWS access.** A header badge says so when the console's identity can't change ECS services; the actions
  are disabled and Settings → AWS permissions lists what is missing.
- Roles decide who may act (see [Sign-in & roles](auth.md)). Agents and scripts run the same actions through the
  operations API, behind the same guards, confirmations and audit log (see [Agents & API](automation.md)).

## Uptime

The uptime bar on a service measures its **operational state over the time the console observed it**: the share of
observed time it was up (or intentionally stopped). Time the console wasn't running or couldn't read the service is a
gap and is left out, and history survives a console restart. It is not customer availability — a service can be up
while requests fail, which is what the load balancer and probe signals are for.

## Cloud-map actions

Every action shows what it needs from AWS (IAM), how to undo it and how success is verified. Actions that would act
twice if repeated are sent once and never retried: Lambda's test invoke, SNS publish, SQS test messages (unless a FIFO
deduplication id lets SQS drop duplicates) and starting an EXPRESS Step Functions workflow. A purge whose outcome is
unknown is never repeated automatically. A STANDARD workflow started without a name gets
`console-<quarter-hour>-<hash>`, shown in the plan: the same request repeated within the quarter-hour can't start it
twice; give a name to start another. **Deploy image** refuses when the service's task definition changed since the dry
run: run the dry run again. Before any change, the resource's tags are read live; if that read fails, the change is
refused (below).

## Protection is checked again right before a change

Whether a resource counts as protected (see [Cloud map](cloud-map.md#which-resources-count-as-protected)) decides the
role, the confirmation and the reason. The map's copy of a resource can be minutes old, and a large account may not
have had every resource's tags read (a cap, a time budget, a refused read). So:

- A resource whose tags weren't read **counts as protected** until they are: its actions ask for the protected role,
  its name and a reason, and say why.
- Right before a cloud-map action changes anything — after taking the lock, before the audit intent — the console
  reads the resource's tags **live** (the service's own tag call; for a service without one, a fresh read of that
  service in that region). If they can't be read, the change is refused: *protection metadata unavailable — refusing to
  change orders*. If the live tags say it is protected now (`console:protected=true`), a change confirmed as
  unprotected is refused — the role check, then *run the dry run again*, which then asks for the name and a reason. If
  they say it is the console itself (`console:self=true`), it is refused.

## When the console's AWS identity can't do it

The console knows which AWS permissions its role has, from two sources: an IAM policy simulation of every write it uses
(console actions, variable edits, provisioning and every cloud-map action), refreshed every 10 minutes and needing
`iam:SimulatePrincipalPolicy`; and real calls — a refusal from AWS (`AccessDenied`) is remembered for 10 minutes, and
a success clears it. Each action is then in one of four states:

| State | What you see |
|---|---|
| **Allowed** | the button works as usual |
| **Denied** — the policy explicitly denies it, no statement allows it on any of the real resources it was simulated against (below), or AWS refused it in the last 10 minutes | the button is disabled with *The console's AWS identity lacks ec2:StopInstances — see Settings → AWS permissions*; the API refuses it with 409 before anything runs |
| **Probably denied** — the simulation found no statement allowing it | a warning (*AWS permission not verified — likely denied*) on the button and in the plan; you can still try, and AWS decides |
| **Not verified** — nothing simulated or observed yet | nothing is shown; AWS decides |

**Settings → AWS permissions** shows the result: an **Actions** tile (*N of M allowed*, *Read-only identity* when no ECS
write is allowed, or *Not verified*) and, per service, whether its actions are allowed. The simulation can't see
service control policies, resource policies or tag conditions (such as `console:power=allow` below), so a
simulated *allowed* can still be refused by AWS — that refusal then wins.

Actions that name a resource are simulated against real ones, not against `*`: a policy scoped to resource ARNs, like
the operator policy's `service/*/*`, allows nothing for `*`. ECS service actions (`ecs:UpdateService`,
`CreateService`, `DeleteService`) use one service in each cluster, and `ecs:RunTask` and `RegisterTaskDefinition` its
task definition. EC2 start, stop, reboot and terminate, RDS start and stop, Auto Scaling, Elastic Beanstalk, App Runner,
CloudFront, Step Functions, EventBridge, Lambda, SQS and SNS actions use the first resource of their type in each
environment and region of the [cloud map](cloud-map.md) (a type found in more than five places stays against `*`). Never
the console's own: not its service, nor anything tagged `console:self=true` or the `CONSOLE_SELF_INSTANCE` instance.
Denied on every one, with no tag condition left unchecked, is a denial; allowed on some only (a policy scoped to
`service/acme-staging/*` or to `acme-staging-*` names) stays *probably denied*. Lambda functions, SQS queues, SNS
topics and EventBridge buses can carry resource policies of their own, which the simulation doesn't read, so for their
actions a missing statement stays *probably denied* (an explicit deny still denies). Launching hosts
(`ec2:RunInstances`, `ec2:CreateTags`), `iam:PassRole`, S3 objects, API Gateway and EKS nodegroups are simulated against
`*`. The resources come from the cloud map's last build, which the simulation never starts itself: until the first
build only the ECS actions have real resources, and the simulation runs again once it exists.

## Turn it on

With the read-only policy AWS refuses these buttons: once the policy simulation has run they are disabled with the
missing permission as the reason. Add these
statements from `infra/iam-policy.json` to the console's role (see [Connect AWS](connect-aws.md#step-5-turn-on-more-one-feature-at-a-time)):

| Statement | Grants | What it risks |
|---|---|---|
| `ServiceActions` | `ecs:UpdateService` on every service in the region | anyone with the right console role can restart, stop or roll back services. Scope it to named clusters if you want less (see [Narrowing it further](connect-aws.md#narrowing-it-further)). |
| `NeverActOnTheConsoleItself` | a **Deny** of `ecs:UpdateService` and `ecs:DeleteService` on the console's own service | nothing: it stops the console from ever changing itself. Fill in `CONSOLE_CLUSTER` and `CONSOLE_SERVICE`. |
| `PowerNonProtectedHostsAndDatabases` | `ec2:StartInstances`, `ec2:StopInstances`, `ec2:RebootInstances`, `rds:StartDBInstance`, `rds:StopDBInstance`, only on resources tagged `console:power=allow` | a stopped host takes its tasks down; a stopped database takes its apps down. Only what you tag can be touched — by these buttons and by the cloud map's EC2 start, stop and reboot alike. |
| `NeverStopOrScaleTheConsolesOwnHost` | a **Deny** of `ec2:StopInstances`, `ec2:RebootInstances`, `ec2:TerminateInstances` and `autoscaling:SetDesiredCapacity` on anything tagged `console:self=true` | nothing: it stops the console from ever taking down the EC2 host it runs on. Tag that instance (and its Auto Scaling group, if any) `console:self=true`; on plain EC2, also set `CONSOLE_SELF_INSTANCE`. |

To let the console power a host or database, tag it `console:power=allow` in AWS.

Re-running CI uses your GitHub token, not AWS: it needs **Actions** read/write (see [GitHub & CI](github.md)).

## Create and scale

Copying a service, scaling it, one-off tasks (migrations, smoke tests), adding EC2 hosts like existing ones, and
deleting what the console created follow the same rules — a plan first, typed confirmation and a reason on protected
environments (and for every delete), and an audit intent before AWS. The console only deletes services and hosts it
created (tag `console:created=true`). See [Create & scale](provisioning.md).
