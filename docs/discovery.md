# How discovery works

Everything the console shows is read from AWS, every few seconds to every minute. Nothing about your company is
configured in code: `console:*` tags on your AWS resources, or a small optional [config file](configuration.md), fill
the gaps AWS can't answer. This page explains every rule, so you can predict what the console will show and fix it
when it guesses wrong.

## Environments come from ECS clusters

Every `ACTIVE` cluster in the region becomes an environment.

| Decided by (first match wins) | Example |
|---|---|
| Cluster tag `console:env` | `console:env=payments-prod` → env `payments-prod` |
| A stage word in the cluster name | `acme-prod-cluster` → **production**, `web-staging` → **staging**, `api-dev` → **dev** (full list below) |
| The cluster name itself | `data-pipeline` → `data-pipeline` |

If two clusters would claim the same stage (`eu-prod`, `us-prod`), both keep their full names instead. The same goes
for two clusters tagged with the same `console:env`; a tag still beats another cluster's stage word. A name that is
already some environment's id gets `-2`, `-3`… An id pinned in `console.config.json` wins over a discovered one, which
becomes `<id>-<region>`.

| Stage | Words in the cluster name (split on anything that isn't a letter or digit) |
|---|---|
| `dev` | `dev`, `develop`, `development` |
| `sandbox` | `sandbox`, `preview`, `demo` |
| `qa` | `qa`, `test`, `testing` |
| `uat` | `uat` |
| `staging` | `staging`, `stage`, `stg`, `preprod` |
| `production` | `production`, `prod`, `prd`, `live` |

| Property | Source |
|---|---|
| **Protected** (production-like: typed confirmations, reasons, operator role) | tag `console:protected` (`true`, `yes`, `on` or `1` = protected; anything else = not), else whether the cluster name's stage is **production**. The `console:env` tag doesn't change it. |
| **Order** (promotion order in Releases) | tag `console:order`, else dev/sandbox → qa → uat → staging → production; unrecognised names sit between uat and staging |
| **Branch** that deploys here | tag `console:branch` (or config) — used for CI filters, "behind branch" and deploy markers |
| **Label** | tag `console:label`, else the stage name, else the cluster name |

Ignore a cluster with the tag `console:ignore=true` or `ignoreClusters` in the config file. AWS Batch's own clusters (`AWSBatch-…`) are
skipped too, unless the config file names one. A cluster the config file names that isn't there (wrong name or region,
not ACTIVE, ignored, or named by two entries) is listed under **Settings → Environments → Configured but not found**,
with a guess at what was meant; it never becomes an environment. So are configured databases and caches that match
nothing. A `console:healthcheck` tag that isn't an http(s) URL of at most 2,048 characters is reported and never
probed.

### A docker compose box as an environment

Not everything runs on ECS yet. An environment can instead be one EC2 instance that runs its apps with docker compose:
name the instance in the config file and declare its apps as `workloads` of that environment.

```json
{
  "environments": { "staging": { "host": "i-0123456789abcdef0", "databases": ["acme-staging-pg"] } },
  "workloads": {
    "api-staging": { "name": "API", "env": "staging", "healthcheck": "https://api.staging.acme.dev/ready", "uses": ["rds:acme-staging-pg", "redis-staging"] },
    "redis-staging": { "name": "Redis", "env": "staging" },
    "caddy-staging": { "name": "Caddy", "env": "staging", "uses": ["api-staging"] }
  }
}
```

Each workload is a read-only tile: AWS can't see docker compose containers, so its state is the box's (a stopped box
parks every workload) and then its health check's (no health check: up while the box runs). Arrows come from `uses`
(`rds:` / `elasticache:` ids of the environment's own data stores, `external:<id>`, or another workload's id), and a
workload whose id starts with a reverse proxy's name (caddy, nginx, traefik, haproxy, envoy) is the entry point. The
box itself has start / stop and CPU charts; restarts, variables, logs, revisions and create & scale stay ECS-only.

## Services

Every ECS service in the cluster, with its deployments, tasks, events and task definition.

| What | Source |
|---|---|
| Display name | tag `console:name`, else the service name |
| Main container | tag `console:main=<container>`, else the container the service's load balancer (or service registry) targets. Otherwise a container whose image is in ECR, then any other app container, then a known sidecar (FireLens log routers; Datadog, X-Ray, OpenTelemetry, CloudWatch, Grafana and New Relic agents; the App Mesh Envoy) — in each, the essential one with port mappings first. Sidecars are listed separately |
| Logs | the main container's `awslogs` group and stream prefix — shared log groups are fine |
| Commit | a git sha anywhere in the image tag (`staging-1a2b3c4`, `v2-<sha>`, a bare sha). Moving tags like `latest` show "unknown". |
| Repository | tag `console:repo=owner/name`, config, or a name match under `GITHUB_OWNER` (see [GitHub & CI](github.md)) |
| Health probe (optional) | tag `console:healthcheck=https://…` — must answer HTTP 200 within 3 s (redirects aren't followed); checked at most every 10 s while someone is looking and every 30 s in the background. Two failures in a row mark the service DEGRADED, or DOWN if no task reports healthy |
| Migration paths (rollback warning) | tag `console:migrations=prisma/migrations/,db/migrate/`; default `prisma/migrations/`, `migrations/`, `db/migrate/`, `alembic/versions/`, `src/migrations/` |
| Infra vs app | tag `console:role=infra|app`; images that aren't in ECR (redis, caddy, nginx from Docker Hub…) default to infra — no repo, CI or releases |
| Hidden | tag `console:hidden=true` |

The console recognises **itself** through the ECS task metadata endpoint (or `CONSOLE_SELF=cluster/task-family`, or the
service tag `console:self=true`) and never acts on its own service, reveals its variables or copies it. If it runs on
ECS but the metadata endpoint doesn't answer and `CONSOLE_SELF` isn't set, it can't tell which service is its own, so
it treats every service as possibly its own — no actions, edits, reveals, copies or one-off tasks — until the
endpoint answers. Setting `CONSOLE_SELF` avoids that.

## EC2 hosts

For clusters with container instances (ECS on EC2), each instance is shown with power state, ECS agent connection
and CPU, the tasks running (and starting) on it, and (in its **Containers** tab) the services they belong to — from
where ECS placed each task (task → container instance → EC2 instance). Tasks whose placement couldn't be read — or
that ECS counts but the task listing didn't reach — are counted as unknown, never as absent: the host says so ("4+"
tasks) and lists their services under "may run here", and on the cloud map the cluster's other instances become "may
run on" candidates. A service with no live task runs nowhere and gets no host link. `localhost:<port>` in a
host-network service's variables links it to another host-network service unless every task of both is placed and
none share an instance; otherwise the link says the shared host isn't confirmed. Services on a stopped host show
**Box stopped**, not DOWN. Instances in an Auto Scaling group can't be
stopped from the console (the group would replace them).

## Databases and caches

RDS instances and ElastiCache clusters are account-wide, so each one is **attributed** to at most one environment:

1. listed in the config file under `environments.<id>.databases` / `caches`;
2. tagged `console:env=<id>` (or `Environment` / `environment` / `env` / `Env` / `stage` / `Stage`) matching the env id or one of its stage words — RDS only, ElastiCache tags aren't read;
3. **reachable** from exactly one environment's services (security groups or connection strings — see below);
4. its identifier contains the env's name or stage word (`acme-prod-pg` → production);
5. it's in a VPC used by exactly one environment (RDS only).

A tag that names a stage (`staging`, `prod`…) or says `shared` settles it even when no environment here matches: a
database tagged `env=staging` in an account whose only cluster is production stays out of production, whatever its VPC
or connections say, and shows on the cloud map under **Staging** instead. Anything else that can't be placed is listed
under **Settings → Environments → Not attributed**.

## Connections (the arrows)

| Evidence | Meaning | Shown as |
|---|---|---|
| **Load balancer target groups** | the ALB forwards to the service | `lb → service` |
| **Security groups** | the target's group allows traffic from the source's group | `inferred · security group …` |
| **Connection strings** in the task definition's `environment` (e.g. `DATABASE_URL=postgres://…@db-host:5432`) | the service is configured to call that endpoint; `localhost:<port>` counts on a shared host network | `inferred · task definition env DATABASE_URL` |
| **Config file** `connections` | anything AWS can't see: external SaaS, dependencies whose endpoints live in Secrets Manager | `console.config.json` |

Only **hostnames** are extracted from environment values — values themselves never leave the server, and variables
injected from Secrets Manager / SSM (`secrets:`) aren't visible to the console at all. When a service reads its
endpoints from secrets, declare the dependency in the config file.

Arrows mean **configured/allowed** paths, not measured traffic. Where a real metric exists (ALB request counts), the
arrow shows requests per minute.

## Freshness

| Data | Refreshed |
|---|---|
| Services, tasks, deployments | every 10 s on an open overview (the panel's events every 5 s), and every 30 s in the background |
| Hosts, databases, caches, target health | 5–15 s |
| Discovery (clusters, attribution, connections) | every 60 s, or **Re-scan now** in Settings |
| Metrics | 60 s |

## Tag reference

| Tag | On | Effect |
|---|---|---|
| `console:env` | cluster, RDS instance | environment id |
| `console:label` | cluster | display name |
| `console:protected` | cluster; any resource on the cloud map | `true`/`false` on a cluster; on the cloud map `true` protects that one resource, and nothing un-protects it ([Cloud map](cloud-map.md#which-resources-count-as-protected)) |
| `console:order` | cluster | promotion order (number) |
| `console:branch` | cluster | git branch that deploys here |
| `console:ignore` | cluster | `true` hides it |
| `console:name` | service | display name |
| `console:main` | service | the container that is "the service" (image, ports, logs, commit) |
| `console:repo` | service | `owner/name` on GitHub |
| `console:healthcheck` | service | URL to probe |
| `console:migrations` | service | comma-separated repo paths |
| `console:role` | service | `infra` or `app` |
| `console:hidden` | service | `true` hides it |
| `console:self` | service, EC2 instance, Auto Scaling group | `true` marks the console's own service or host (no actions on it; the shipped IAM policy's `NeverStopOrScaleTheConsolesOwnHost` denies stopping, rebooting, terminating or scaling it) |
| `console:power` | EC2 instance, RDS | `allow` lets the shipped IAM policy start/stop it (and reboot an EC2 instance) |
| `console:created`, `console:created-from` | resources the console created | set by the console: `true` marks what it may delete; `created-from` names the source (see [Create & scale](provisioning.md#tags)) |
