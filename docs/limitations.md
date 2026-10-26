# Limitations & roadmap

What the console doesn't do today, so you can decide before you invest time in it.

## Not supported

| Area | Status |
|---|---|
| Compute other than ECS | EKS, Lambda, App Runner, Elastic Beanstalk and EC2 appear on the [cloud map](cloud-map.md) with their actions, but the environment pages (overview, logs, metrics, releases) cover ECS services only. Apps AWS can't see (docker compose on EC2, other platforms) show only when [declared as workloads](cloud-map.md#apps-aws-cant-see-declared-workloads); a docker compose box can also be an environment (`environments.<id>.host`), with read-only workload tiles judged by box state and health checks. |
| Several AWS accounts in one console | One account per console; run one console per account. Several regions are supported (`CONSOLE_REGIONS` or `inventory.regions` in the [config file](configuration.md)). An environment in another region whose id collides with a home one is shown as `<id>-<region>`, labelled "Production (eu-west-1)". |
| Copying services across regions | [Create & scale](provisioning.md) copies a service only within one region. |
| More than one running copy | Run one task per console. Action locks, notifications, sign-in rate limits and uptime history live in the process, so a second copy would send duplicate notifications and couldn't see the first one's locks. |
| CI other than GitHub Actions | GitLab CI, CircleCI and Buildkite are not integrated. |
| Measured service-to-service traffic | Arrows show configured or allowed paths (security groups, connection strings, declarations). Real traffic would need VPC Flow Logs or X-Ray — not implemented. |
| Log sources other than CloudWatch | FireLens to other destinations, Datadog and Loki are not read. |
| Request metrics without a load balancer | Only from Caddy's JSON access log; nginx and Traefik formats are not parsed. |
| Load balancing for copies | [Create & scale](provisioning.md) copies services without load balancers, Service Connect, service discovery or auto scaling, and doesn't create IAM roles, secrets or log groups; scaling is manual (1 to `provisioning.maxTasks`). |
| Email delivery | Invites and password resets produce links to copy; no email is sent. |
| A bundled AI model | The Assistant and agent runs call a model through a connection you add (Anthropic, OpenAI, Bedrock, an OpenAI-compatible or local Ollama server); none is bundled and nothing is sent anywhere until you add one. [Agents & API](automation.md) covers connections, tokens, approvals and MCP; `examples/agent/` shows a terminal agent. |
| Cost data per account | In an AWS Organizations management account, Cost Explorer covers every member account and the console doesn't filter by account. Estimates use the list prices of each resource's region, as of the date in `src/lib/list-prices.ts`. |
| Uptime history across restarts | Uptime bars cover the last two hours and live in memory; they start empty after a restart. |

## Verified vs. assumed

- The discovery engine, guards, logs and actions are covered by unit tests and an end-to-end smoke suite against the
  built-in simulated AWS account.
- Real-AWS calls use the official SDK with the documented request shapes; try them in a staging account first.
- Integrations are verified against their documented APIs; each has a test button (**Send test** or **Test
  connection**) to confirm your credentials before you rely on it.
