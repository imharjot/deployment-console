# Deployment Console

One place for your team to see and operate everything you run on **Amazon ECS**, without the AWS console, SSH or
tribal knowledge. Point it at an AWS account and it **discovers** your environments, services, databases, caches and
load balancers and how they connect. Your team signs in to the console, and each person gets the buttons their role
allows.

These docs are for the people who try it, run it and use it: developers, platform engineers and whoever looks after
the AWS account.

## Start here

| I want to… | Page | Time |
|---|---|---|
| See it working, no AWS account needed | [Quickstart](quickstart.md) | 2 min |
| Connect my AWS account, read-only first | [Connect AWS](connect-aws.md) | 10 min |
| Run it for my team on ECS, with HTTPS and sign-in | [Deploy the console](deploy.md) | 1 hour |
| Invite people and pick their roles | [Sign-in & roles](auth.md) | 5 min |
| Let people restart services and roll back | [Actions & safety](actions.md) | |
| Let people see and edit environment variables | [Environment variables](environment-variables.md) | |
| Copy, scale and add capacity | [Create & scale](provisioning.md) | |
| See what AWS charges | [Costs & usage](costs.md) | |
| Connect an AI agent or a script | [Agents & API](automation.md) | 10 min |
| Know what it can and can't do to my account | [Security model](security.md) | |
| Fix something that doesn't work | [Troubleshooting](troubleshooting.md) | |
| Get quick answers | [Common questions](faq.md) | |

## What it does

- **A live map** of every environment: services, data stores, ingress and external systems, with arrows for real dependencies.
- **Status you can trust**: one set of rules turns ECS deployments, task health, load-balancer targets and optional HTTP probes into UP, DEGRADED, DOWN, DEPLOYING or STOPPED. A service is never shown UP while any of those signals fails.
- **Safe actions**: restart, stop/start, roll back or forward to any revision, start/stop EC2 hosts and databases. Each one is guarded, confirmed, role-checked and written to an audit log.
- **Environment variables**: every variable of a service wherever it lives, masked until someone with the right role reveals it.
- **Fast logs**: live tail across services, a query language, a histogram, facets, CloudWatch filter patterns, Logs Insights and view-in-context.
- **Metrics & performance**: CPU and memory, requests per second with p50/p90/p99 latency and 5xx rate, database and host metrics, deploy markers.
- **Create & scale**: copy a service into any environment, scale it, run one-off tasks and add EC2 hosts, with a plan and a monthly estimate first. It only ever deletes what it created.
- **Costs & usage**: month to date, forecast, daily spend by service and environment, anomalies, and a free estimate of what runs now.
- **CI & releases**: GitHub Actions runs with steps, test results and logs, and what each environment runs compared with the next.
- **Teams and integrations**: passwords or your SSO, four roles, notifications to Slack or webhooks, tickets in GitHub Issues, Jira, Linear, ClickUp or Asana.
- **Ready for AI agents**: typed operations, API tokens, an approvals inbox, a live event stream and an MCP endpoint.

## Getting around

Press **g** then a letter to jump: **o** Overview, **h** Dashboards, **g** Cloud map, **e** Resources, **m** Metrics,
**l** Logs, **c** CI, **a** Activity, **r** Releases, **n** Notes, **b** Costs, **u** Audit, **t** Automation, **s**
Settings, **d** Docs. ⌘K (Ctrl+K) opens the palette; **Save this view** (the bookmark in the header, or the palette)
keeps the page with its filters under a name you can find again with ⌘K. The home page can be a dashboard or the
Incident view ([Dashboards](dashboards.md)); the sidebar's Overview always opens the environments overview.

## What you need

| Need | Why |
|---|---|
| Services on **Amazon ECS** (Fargate, EC2, or both) | The console's unit of work is an ECS service. |
| An **IAM role or credentials** with the read-only policy that ships in the repo | That policy can only read, so the console can't change anything until you add write permissions — one feature at a time. |
| The **awslogs** log driver on your containers | Logs are read from CloudWatch Logs. |
| Optional: a **GitHub token** | CI runs, commits, release diffs and migration checks. |

Nothing is installed in your services, and nothing about your company is hardcoded: the same build runs against
anyone's account.

## Words used in these docs

| Term | Meaning |
|---|---|
| **Environment** | One ECS cluster, for example *staging* or *production*. See [How discovery works](discovery.md). |
| **Service** | An ECS service in an environment. |
| **Host** | An EC2 container instance in an ECS-on-EC2 cluster. |
| **Protected environment** | A production-like environment. Changes there need a typed confirmation, a reason and a higher role. Production is protected by default. |
| **Action** | A change made through the console, such as a restart. Every action is guarded and audited. |
| **Role** | What a person may do: *viewer*, *developer*, *operator* or *admin*. See [Sign-in & roles](auth.md). |
| **Operation** | One capability with a stable name, such as `services.restart`, that agents and scripts can call. See [Operations reference](operations.md). |
| **API token** | A key that lets an agent or script act on behalf of the person who created it. |
| **Approval** | A change an agent asked for, waiting for a person to accept or reject it. |
