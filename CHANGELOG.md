# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will use
[Semantic Versioning](https://semver.org/) from its first release.

## [Unreleased]

First public version (0.1.0). What the console can do today:

### Latest additions
- **Docker compose environments**: `environments.<id>.host` (an EC2 instance id) makes a box that runs its apps with
  docker compose an environment of its own. Its declared `workloads` become read-only service tiles judged by the box's
  state and their health checks, drawn on the overview map from their `uses`; the box gets power actions and metrics.
- **Settings, reorganised**: grouped side navigation (General, Cloud, Team, Notifications), an overview of every section
  with its live state, a new **Interface** page (theme including *System*, effects, sidebar), *Your account* under
  Settings, and **AWS permissions** in three tabs (Services with filters and search, Coverage, Policy builder).
- **Look and feel**: Manrope, JetBrains Mono and Bricolage Grotesque; higher-contrast text and larger type throughout;
  cascading arrivals for card grids and a hover lift on clickable cards.
- **Lite effects** for weak hardware: detected before first paint (≤ 4 CPU threads, ≤ 4 GB memory, Save-Data or
  reduced motion) or chosen in Settings → Interface — no background blur or looping animations, fades instead of
  movement, and polling at half the rate.
- **Fixed after a first run against a real account** (read-only role, no config file):
  - The generated policies grant `cloudformation:ListStacks`: AWS authorizes the stack listing (`DescribeStacks`
    without a name) as that action, so the read-only policy left CloudFormation empty and flagged as denied.
  - Cloud map: a VPC takes the environment of the workloads in it (shared when they disagree), and children placed by
    their VPC keep it. One security-group rule from production's database to the default VPC's CIDR no longer made the
    default VPC — with its subnets and the security groups named `*-staging-*` — production.
  - A database tagged with a stage that has no ECS cluster here (`env=staging`, only production discovered) is no longer
    placed in another environment by its VPC or name, and isn't listed as unattributed with advice to tag it.
  - Costs: when AWS's forecast assumes a daily spend over twice (or under half) the last 7 days' average, the forecast
    tile also shows the 7-day run-rate month end.
  - `npm run parity` confirms "more on the map than AWS reports" with the service's own list call: Resource Explorer
    doesn't index AWS-managed KMS keys and aliases, Cloud Map namespaces or private hosted zones.
- **Fixed after a second run against a real account** (set up as a newcomer would: read-only role, no config file):
  - Resource Explorer rows that the type's own provider no longer lists (released Elastic IPs it still indexes) are left
    out with a note when the provider matched the rest of that type, instead of being flagged as a key-format bug. A
    Systems Manager managed-instance record folds into its EC2 instance instead of showing as a second resource.
  - A certificate that failed validation is a warning even when unused ("safe to delete"), not unknown.
  - ECS service actions are simulated against a real service in each cluster, and `ecs:RunTask` against its task
    definition: against `*`, a policy scoped to `service/*/*` looked as denied as a read-only one. Denied in every
    cluster now disables the buttons with the reason; allowed in some clusters only stays a warning.
  - The deploys and rollbacks widget counts ECS rollouts that completed, not only deploy runs and console actions.
  - The logs status facet lists HTTP status codes only; `status:` queries still match any field.
  - Cost estimates use the list prices of each resource's region (the AWS Price List for 34 regions in
    `src/lib/list-prices.ts`, refreshed by `scripts/list-prices.mjs`). The run rate also counts environments known only
    from tags, EC2 instances outside a cluster, and databases or caches in no environment.
  - CI says when no repository is mapped yet, instead of "No runs on this branch".
  - `npm run smoke` refuses to run unless the console reports the simulated account, and retries a GET once after a
    dropped connection.
  - Every write that names a resource is simulated against real ones, not only ECS's: EC2 power, RDS start and stop,
    Auto Scaling, Elastic Beanstalk, App Runner, CloudFront, Step Functions, EventBridge, Lambda, SQS and SNS against a
    resource of their type in each environment and region of the cloud map, `ecs:RegisterTaskDefinition` against a
    task definition. A read-only role now sees EC2, RDS and Auto Scaling buttons disabled with the reason; Lambda, SQS,
    SNS and EventBridge stay a warning, as their resources can carry policies of their own.
  - Cloud map labels keep the real name at every zoom: inside environment lanes the overview level dropped the
    environment's word, so `acme-production-pg` and `acme-staging-pg` both read `acme-pg`.
  - Dashboards and the Incident view read `/api/envs` and `/api/issues` from the shell's polls instead of fetching
    each a second time in the same second.

### Cloud map — the whole account
- **Cloud map** (`/map`): every resource the console can find, with the connections between them, grouped by
  environment and laid out Edge & DNS → Compute → Messaging → Databases → Storage → External, across every region the
  console reads. 56 providers: ECS, load balancers, RDS (instances, clusters and proxies), ElastiCache (and Serverless),
  MemoryDB, OpenSearch, Redshift, EFS, EBS, EC2, Auto Scaling, EKS (clusters, nodegroups and Kubernetes workloads), App
  Runner, Elastic Beanstalk, Lambda, SQS, SNS, EventBridge (and Scheduler, Pipes), Step Functions, Kinesis, DynamoDB,
  MSK, Amazon MQ, Data Firehose, SES, API Gateway, S3, CloudFront, Route 53, Cloudflare; the network (VPCs, security
  groups, Cloud Map), security & identity (IAM, KMS, Certificate Manager, Secrets Manager and Parameter Store metadata),
  monitoring (log groups, alarms, Synthetics, CloudTrail, Glue, Athena) and build & delivery (ECR, CloudFormation,
  CodeBuild, CodePipeline, CodeDeploy) layers; a Resource Explorer catch-all for everything else; and **declared
  workloads** (apps AWS can't see as services — docker compose on EC2, another platform — with live health checks, from
  `console.config.json` `workloads`). Cross-resource health rules show an alarm, a dying KMS key, an expiring
  certificate, internet exposure or a stale backup on what it affects; an All-resources table (`/resources`) lists every
  row.
- **Connections with evidence**: read from AWS configuration (event source mappings, subscriptions, rule targets,
  notifications, origins, DNS records, API routes, state machine definitions), allowed by security groups, or named by
  a setting (never showing the value). Environments are assigned from provider hints, tags, names, VPCs and
  connections; resources nobody uses are marked **idle** from CloudWatch activity.
- **Actions on any resource**, each planned (dry run) before it runs, role-checked, locked per resource and audited:
  Lambda deploy code / publish / shift and roll back aliases / invoke / concurrency / variables; SQS send, redrive,
  purge; SNS publish; EventBridge enable/disable; Step Functions start; S3 upload, delete, 5-minute download links;
  CloudFront invalidations; Cloudflare cache purge; EC2 start/stop/reboot; Auto Scaling desired count; EKS nodegroup
  scaling, rollout restart and replica scaling; App Runner deploy/pause/resume; Beanstalk deploy version and restart;
  ECS deploy image. Also available to agents (`cloud.*` operations).
- **Notes** on any resource (tags, pinning, search, `/notes`), audited without their text.
- **Settings → Permissions**: live status per provider (working, missing permissions with the exact actions, not set
  up) and a policy builder; `npm run iam:policy` generates the IAM statements from what each provider declares.
- **Safety**: protection fails safe (any hint of a protected environment, `console:protected`, or no environment at
  all → the careful rules; tags can add protection, never remove it); code/image deploys and test messages are
  *danger* (tokens always need a person); the generated IAM never widens a hand-written scope; the console never
  stops, reboots or scales the instance it runs on (`CONSOLE_SELF_INSTANCE`, tag `console:self=true`, IAM deny).

### Security review (before release)
A code audit, a live attack run against the production image with every role, and an edge-case sweep of every
feature found and fixed:
- **The console never reveals its own variables** (its database URL, `CONSOLE_SECRET_KEY`, GitHub token), admins
  included; reveals return nothing if their audit row can't be written.
- **Self-protection fails closed:** if the console can't tell which service is its own, nothing is changed. The IAM
  policy also denies running or copying the console's task definition and passing its role; one-off tasks must carry
  the `console:created` tag; KMS grants cover customer-managed keys for SSM, Secrets Manager and SSE-KMS env files.
- **Agents:** copying a service, adding hosts and one-off tasks with a command are *danger* — a token's request
  always waits for a person. Approval details are shown only to people who could decide; a stray confirmation can't
  use a request up; requests from revoked tokens or disabled owners are rejected; approving is audited first; optional
  two-person rule (`CONSOLE_APPROVALS_TWO_PERSON`). MCP batches are capped at 20 and every call counts against the
  rate limit. `CONSOLE_API_TOKENS` fails closed on typos.
- **Requests:** a Content-Security-Policy; the CSRF origin check uses `CONSOLE_PUBLIC_URL` when set; client IPs are
  read through `CONSOLE_TRUSTED_PROXIES` hops; valid tokens are never throttled by others' bad attempts; per-address
  limits only apply to known addresses; `Retry-After` on every 429; unknown API routes answer JSON.
- **Inputs:** the schema validator and provisioning parser reject inherited names (`constructor`, `__proto__`); a line
  break in an env-file value is refused (it could smuggle variables past the plan); env files are shown and edited
  literally, untouched lines byte for byte; any provisioning `dryRun` other than `false` only plans; duplicate edits in
  one request are refused; the host cap is re-checked under the lock; optional `provisioning.allowedImageRegistries`.
- **Integrations** never reach link-local (cloud metadata) addresses and don't follow redirects.
- **Accessibility and resilience:** dialogs and sheets trap focus, make the page behind inert and give focus back
  when they close; the service map fits every node on a phone; the Automation tabs are linkable (`#tokens`, …); a
  styled 404; a non-JSON reply from a proxy shows an error instead of crashing a page.
- **Setup:** `package-lock.json` now installs with `npm ci` on Linux (the Docker build failed before); the health
  check fails on fatal misconfiguration (bad `AUTH_MODE`, missing `CONSOLE_SECRET_KEY` with Postgres) so bad deploys
  roll back; a setup token is printed at every boot until the first admin exists; the dev user can set a first
  password before switching to `AUTH_MODE=session`; `CONSOLE_SOURCE` rejects typos; the task-definition template sets
  `CONSOLE_SELF`.

### Agent platform (agents, workflows, assistant)
Off by default against a real account (`CONSOLE_AGENTS`, or the admin switch under Automation → Agents); on with the
simulated account.
- **Agents act as agents, never as you.** Every agent call runs as a server-issued agent principal under a policy
  (read / propose / bounded-act) the model can't change. Hard denials for every policy (variables, approvals, tokens,
  users, integrations, the console itself, IAM). A person's approval is a grant bound to the exact plan hash; the run
  then makes that change as the agent. **Emergency stop** (admins, with a reason): every agent change is refused or
  held at once; reads and verification go on.
- **Durable runs**: steps with leases and fencing survive restarts; budgets (turns, tool calls, time, cost — child
  runs reserve from their parent) pause a run instead of overspending; evidence is cited (E1, E2, … with source and
  age); outcomes keep *AI completed*, *AWS accepted* and *verified healthy* apart — accepted is never reported as
  healthy. `GET/POST /api/agents/runs`, `/api/agents/runs/<id>` (`/cancel`), `/api/agents/metrics`, and
  `/api/events?run=` with replay after a reconnect.
- **Model connections** with who pays: Anthropic, OpenAI, OpenAI-compatible endpoints, Ollama, Amazon Bedrock, your own
  `claude`/`gemini` CLI as an MCP client (the ChatGPT plan behind a flag), and a built-in scripted demo model (no
  provider, no cost). Secrets are write-only.
- **Workflows**: six templates (incident investigator, approved remediation, non-production schedule, daily digest,
  cost review, configuration drift); typed steps, cron in a time zone, state and alarm triggers deduped; publishing
  needs the preview; versions never change.
- **Embedded assistant**: Ask from the header (`g i`), or "Explain this" / "Why is this unhealthy?" on a resource; the
  answer streams with citations and at most one proposed change, approved inline. `POST /api/assistant`; secret-looking
  questions are refused. `/assistant` keeps your history.
- **Automation page**: Approvals, Runs (timeline and release metrics), Workflows, Agents, Connections, Connect your
  agent (token + config for Claude Code, Gemini CLI or any MCP client), API tokens, Operations.
- **Also in this release:** multi-region reads, a mutation coordinator for every change, 60 built cloud-map providers plus
  a Resource Explorer catch-all, dashboards, regenerated IAM policies (they deny the console's own parameters, secrets
  and env file; `--regions`, `--principal`), and `npm run parity` to compare a running console with Resource Explorer.

### Agents & API
- Every capability is a typed **operation** (`GET /api/ops`, `POST /api/ops/<name>`) with a JSON Schema, a risk level
  (read / change / danger), a required role and a dry-run plan; `?format=anthropic|openai|mcp` returns ready-made tool
  definitions. 32 operations: status, services, logs, metrics, variables (names only), CI, audit, releases, costs and
  create & scale. Operations call the same code as the UI, so every guard, lock, confirmation and audit row applies.
- **API tokens** (`dc_…`, only a hash stored) with three modes — *read*, *propose* (default: changes become approval
  requests) and *act* (routine changes run; protected environments and dangerous operations still need a person) —
  capped at the creator's current role, limited to the agent routes, rate-limited, managed under **Automation**.
  `CONSOLE_API_TOKENS=false` turns the whole surface off.
- **Approvals**: agent-requested changes wait for a person, run as the approver, and are audited as
  `<approver> approving token "<name>"`; transitions are atomic, inputs sealed at rest, requests expire after 24 h.
- **Live events** (`GET /api/events`, Server-Sent Events): state changes, action results and approvals.
- **MCP endpoint** (`POST /api/mcp`) so Claude Code or any MCP client can operate the console, and a zero-dependency
  reference agent in `examples/agent/`. No operation can reveal variable values; tokens never manage users, tokens,
  integrations or settings, and never approve.

### Costs & usage
- **Costs** page (operator and up): month to date, month-end forecast, last month, change vs the same point last month,
  30 days of daily spend, and spend by AWS service, environment and ECS service, from AWS Cost Explorer.
- **Extra usage**: Cost Anomaly Detection anomalies plus a built-in spike check (last 7 days vs the 21 before).
- **Free run-rate estimate** per environment and resource at list price (Fargate incl. ARM, EC2, RDS incl. Multi-AZ,
  ElastiCache), independent of Cost Explorer; rates configurable under `pricing`.
- Cost Explorer's $0.01/request is respected: one 4-request snapshot at most every `costs.cacheHours` (6 h), only when
  someone looks, persisted in the console DB; manual refresh limited to once per 5 minutes and audited.

### Create & scale
- **Copy a service** into any environment (another image or Fargate size; networking from the source or a service
  already there), **scale** it, **run a one-off task** with an optional command, and **add EC2 hosts** like existing
  ones — each with a plan (warnings, monthly estimate) before anything happens.
- **Deletes only what it created**: services and hosts tagged `console:created=true` (enforced by the IAM policy too);
  deleting always needs the name and a reason. Never copies the console itself or out of a protected environment.
- New permissions `provision` (operator) / `provision:protected` (admin) and `costs` (operator); caps via
  `provisioning.maxTasks`, `maxHosts`, `allowedInstanceTypes`.

### Setup
- `docker compose up --build` runs the console (simulated account by default; optional Postgres profile).

### Environment variables
- A **Variables** tab per service lists every variable — plain (task definition), SSM, Secrets Manager (incl. one key
  of a JSON secret) and S3 env files — masked until revealed; reveals are audited by name.
- Edit, add and remove with a names-only review: plain changes register a new revision and deploy it; secret values
  and env files are rewritten (keeping type, KMS key and encryption) and the service restarts. Stale edits, rollouts,
  invalid or duplicate names and the console's own service are refused; protected envs need typed confirmation +
  reason. New permissions `env` / `env:protected` (developer / operator).

### Discovery
- Every `ACTIVE` ECS cluster in the region becomes an environment; id, label, protection, promotion order and deploy
  branch come from `console:*` cluster tags, stage words in the cluster name, or an optional `console.config.json`.
- Services, tasks, task definitions (main container, sidecars, ports, health checks, `awslogs` groups), EC2 container
  instances, RDS instances, ElastiCache clusters and the ALB (listeners, rules, target groups, target health).
- RDS and ElastiCache attributed to one environment each (config, tags, reachability, name, VPC).
- Connections inferred from security groups, hostnames in task-definition environment values (values never leave the
  server) and load-balancer target groups, plus declared external systems and dependencies.
- The console recognises its own service and never acts on it. Settings → Environments shows what was found, why,
  and what needs attention.
- Task placement: each live ECS-on-EC2 task's host (task → container instance → EC2 instance). A host shows the
  tasks running and starting on it and their services (stat, Capacity, Containers tab); tasks whose placement wasn't
  read, or that the task listing didn't reach, count as unknown, not absent. The cloud map draws a service "runs on"
  only the instances its tasks are on (candidates while placement is unread, nothing for a service with no live
  task); `localhost:<port>` connects two host-network services unless complete placement shows they never share an
  instance, and says so when that isn't confirmed.
- Main container: tag `console:main`, else the container the load balancer or service registry targets, else an ECR
  image before a public one and both before known sidecars. A task's health check counts any essential container's.
- Fixed: two home-region clusters tagged with one `console:env`, a discovered cluster with a config-pinned id, or a
  generated `<id>-<region>` that another cluster already uses no longer share an environment id (one replaced the
  other's catalog); on the cloud map, a resource whose connections disagree once every hop is placed stays shared
  instead of keeping the environment it was given first.

### Status and overview
- One precedence table turns deployments, task health, target health, optional HTTP probes and EC2 host state into
  UP / DEGRADED / DOWN / DEPLOYING / STOPPED / BOX_STOPPED / UNKNOWN — never UP while any signal fails.
- Background sampler every 30 s: uptime bars for the last 2 hours, a cross-environment issues list, notifications.
- Draggable, zoomable dependency map per environment (or a grid), ⌘K command palette, one resource panel for services,
  hosts, databases, caches and the load balancer.

### Actions
- Restart, stop/start (remembers the desired count), switch to any task-definition revision, start/stop EC2 hosts and
  RDS instances, re-run GitHub Actions runs.
- Guards shared by the UI and the API: no rollback onto an expired image, acknowledgement when migrations changed,
  typed confirmation plus a reason on protected environments, one in-flight action per service, no power actions on
  protected environments. Every action is audited (intent before the AWS call, result after).

### Logs, metrics and CI
- Live tail across services merged by time, gap-free history paging, a query language (fields, ranges, regex,
  wildcards, boolean logic), histogram, facets, CloudWatch filter patterns, Logs Insights, view-in-context.
- CPU/memory, database and host metrics with deploy markers; request performance (RPS, avg, p50/p90/p99, 5xx) from
  the ALB or from Caddy JSON access logs.
- GitHub Actions runs with steps, job logs and JUnit results; commits behind each revision; a promotion chain showing
  what each environment runs and what the next one would get.

### Teams and integrations
- Email + password and OIDC SSO sign-in (or an ALB `authenticate-oidc` action), invites and password-reset links,
  four roles (viewer, developer, operator, admin), session management, rate-limited logins.
- Own database: SQLite built into Node 24, or Postgres; integration secrets encrypted at rest.
- Notifications to Slack and signed webhooks; tickets in GitHub Issues, Jira Cloud, Linear, ClickUp and Asana from
  resource panels, log lines and CI runs.

### Project
- Simulated AWS account for a fictional shop ("Acme") so every screen and action works without AWS.
- Unit tests (`node:test`), an end-to-end smoke suite, IAM policies checked against the SDK calls in use, in-app
  documentation at `/docs`, a Dockerfile, an ECS task definition and an example GitHub Actions deploy workflow.
