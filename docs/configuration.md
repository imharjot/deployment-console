# Configuration

Two layers:

- **Environment variables** decide how the console runs: where it reads from, where it stores its data, how people
  sign in.
- An optional **`console.config.json`** tells it facts AWS can't: friendly names, repositories, external systems,
  hidden dependencies. Most teams start without one.

## Environment variables

Locally they go in `.env.local` (copy `.env.example`, which lists every variable with a comment); in a deployment,
in the task definition or `docker run -e`. Restart after changing them. An empty value counts as unset.

Mistakes that would break every request fail loudly instead of half-working: a bad `AUTH_MODE`, a `CONSOLE_SECRET_KEY`
shorter than 32 characters, or Postgres without one makes every request answer `500` with the reason and
`/api/healthz` fail, so a bad deployment rolls back instead of going healthy.

| Variable | Default | Meaning |
|---|---|---|
| `CONSOLE_SOURCE` | Settings → AWS connection, else `mock` | `aws` for your AWS account; `mock` for the simulated demo account. Unset: an admin chooses in **Settings → AWS connection**, without a restart (below). Any other value is an error, so a typo never quietly runs the demo |
| `AWS_REGION` | `AWS_DEFAULT_REGION`, else Settings → AWS connection, else `us-east-1` | the console's home region: ECS environments and global services are read here first |
| `AWS_PROFILE` | Settings → AWS connection, else the SDK's default chain | the profile in `~/.aws/config` the console signs in with. Keys in the environment (`AWS_ACCESS_KEY_ID`, …) pin the sign-in the same way |
| `CONSOLE_REGIONS` | the config's `inventory.regions`, else Settings → AWS connection, else the home region alone | regions to read, comma-separated (the home region is always included and comes first), or `all-enabled` for every region enabled in the account (asked once a day through `ec2:DescribeRegions`). At most 30 |
| `CONSOLE_AWS_CONCURRENCY` | `16` | the most AWS calls in flight at once (1–256), across discovery, the cloud map and actions. Each service also has its own cap per region: 4, or 2 for CloudWatch Logs, CloudFormation and Cloud Control, 1 for IAM and Route 53. `GET /api/diagnostics/aws` (operators and admins) shows requests, retries, throttles and queued calls per service and region |
| `CONSOLE_ACTIVITY_BUDGET` | `5000` | CloudWatch metrics the cloud map may read per hour for idle marks (0–1,000,000; 0 turns them off). A series is read once an hour (support resources once a day); what doesn't fit waits for the next hour, and those resources aren't marked idle meanwhile. Settings → AWS permissions shows the last hour's count and its monthly cost ($0.01 per 1,000) |
| `CONSOLE_CONFIG` | `./console.config.json` if it exists (with the simulated account: `examples/demo.console.config.json`) | path to the config file, relative to the working directory |
| `CONSOLE_PUBLIC_URL` | the request's origin (`http://localhost:3200` in notification links) | the console's public URL — used in notification links, invite links, SSO redirects, for `Secure` cookies, and as the only origin allowed to send changes (the CSRF check). Set it in production. |
| `CONSOLE_TRUSTED_PROXIES` | `1` | how many proxies in front of the console append to `X-Forwarded-For`; the client's address (for the audit log and per-address throttles) is that many entries from the end. `1`: one load balancer or reverse proxy; `2`: CloudFront → ALB; `0`: nothing in front — the header is ignored and per-address throttles are off (per-email and per-token limits still apply) |
| `DATABASE_URL` | — | `postgres://…` or `postgresql://…` to store users, sessions, audit log and integrations in Postgres. Unset = SQLite. Any other value is refused (the console answers 500 and fails its health check) rather than quietly falling back to SQLite |
| `CONSOLE_DATA_DIR` | `./data` | where the SQLite file (and its generated key) live |
| `CONSOLE_SQLITE_PATH` | `<CONSOLE_DATA_DIR>/console.db` | the SQLite file itself (`:memory:` for throwaway runs) |
| `CONSOLE_SECRET_KEY` | generated into `<CONSOLE_DATA_DIR>/secret.key` (SQLite only) | at least 32 characters; encrypts integration secrets and agents' approval inputs at rest and seals the SSO state cookie. **Required when `DATABASE_URL` is a `postgres://` or `postgresql://` URL** (`openssl rand -base64 48`) |
| `GITHUB_TOKEN` | — | enables CI, commits, release diffs and migration checks (see [GitHub & CI](github.md)) |
| `GITHUB_OWNER` | — | organisation or user used to match services to repositories by name (or `github.owner` in the config file) |
| `CONSOLE_SELF` | the ECS task metadata endpoint | `cluster/task-family` of the console itself, for example `acme-tools/deployment-console`. Recommended on ECS: without it, if the metadata endpoint doesn't answer, the console refuses every change until it does |
| `CLOUDFLARE_API_TOKEN` | — | a Cloudflare API token (`Zone:Read`, `DNS:Read`; `Cache Purge` for the purge action) to put Cloudflare zones and their records on the cloud map. Unset = Cloudflare is left off. See [Permissions setup](permissions.md#4-cloudflare-optional) |
| `CLOUDFLARE_ACCOUNT_ID` | — | limits the map to one Cloudflare account's zones (unset: every zone the token can read) |
| `CONSOLE_EKS_SYSTEM_NAMESPACES` | `false` | `true` also lists Kubernetes workloads in kube-system, kube-public and kube-node-lease |
| `CONSOLE_SELF_INSTANCE` | — | when the console runs on a plain EC2 instance (not ECS): that instance's id, so it never stops or reboots itself (or tag the instance `console:self=true`). Tag it as well, and its Auto Scaling group if it has one: the IAM deny `NeverStopOrScaleTheConsolesOwnHost` goes by the tag (see [Connect AWS](connect-aws.md#what-each-permission-is-for)) |
| `AUTH_MODE` | `session` | `session`, `alb` or `dev` — see [Sign-in & roles](auth.md) |
| `CONSOLE_API_TOKENS` | `true` | unset, `true`, `1`, `yes` or `on` = on. Anything else (`false`, `0`, a typo) refuses every API-token request and blocks new tokens — see [Agents & API](automation.md) |
| `CONSOLE_APPROVALS_TWO_PERSON` | `false` | `true`: nobody may approve a request made with their own API tokens, so a second person must (rejecting your own is allowed). Off by default so a one-person team can use agents — see [Approvals](automation.md#approvals) |
| `CONSOLE_AGENTS` | unset | `on` / `off` (also `true`/`1`/`yes`, `false`/`0`/`no`): turns the agent platform (agent tokens, runs, the worker) on or off, overriding the admin's toggle. Unset: the toggle under Automation → Agents, else on with the simulated account and off against a real AWS account. Anything else set fails closed (off) — see [Agents & API](automation.md#agent-identities-policies-and-the-emergency-stop) |
| `CONSOLE_CLAUDE_BIN` | `claude` on `PATH`, then `~/.local/bin/claude` | absolute path of the `claude` binary for the local Claude Code runtime ([Model connections](automation.md#model-connections)). Needs Claude Code 2.1.263 or newer, signed in as the user the console runs as |
| `CONSOLE_GEMINI_BIN` | `gemini` on `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin` | absolute path of the `gemini` binary for the local Gemini CLI runtime. Needs Gemini CLI 0.11.0 or newer (`npm install -g @google/gemini-cli@latest`), signed in |
| `CONSOLE_RUNTIME_CONCURRENCY` | `1` | how many local runtime CLIs may run at once (1–16); further runs wait in a queue |
| `CONSOLE_CHATGPT_PLAN` | off | `eligible` turns on ChatGPT-plan connections. Only for installations that meet OpenAI's plan-usage conditions (open-source or personal use, running locally); sign-in works only on `http://127.0.0.1:<port>` |
| `CONSOLE_CHATGPT_ISSUER`, `CONSOLE_CHATGPT_AUTHORIZE_URL`, `CONSOLE_CHATGPT_TOKEN_URL`, `CONSOLE_CHATGPT_REVOKE_URL`, `CONSOLE_CHATGPT_JWKS_URL`, `CONSOLE_CHATGPT_API_BASE` | `https://auth.openai.com`, its endpoints, `https://api.openai.com/v1` (revocation and key set from the issuer's discovery document) | override the ChatGPT-plan endpoints, for a test provider. `https` only, or `http` on a loopback host |
| `NEXT_MANUAL_SIG_HANDLE` | `true` in the Docker image | `true`: on SIGTERM or SIGINT the console stops accepting changes and waits up to 25 seconds for the ones in flight before it exits. Give the container at least 30 seconds to stop (ECS `stopTimeout`, compose `stop_grace_period`) |
| `MOCK_LOG_RATE_MULT` | `1` | demo only: multiplies the simulated log volume (for load-testing the log viewer) |

Sign-in variables (`OIDC_*`, `AUTH_*`, `CONSOLE_ADMIN_*`, `CONSOLE_ALLOWED_EMAILS`, `ALB_ARN`, `DEV_USER_EMAIL`,
`SESSION_TTL_HOURS`) are listed in [Sign-in & roles](auth.md#reference).

Also used:

- **Postgres limits** (with `DATABASE_URL`): at most 5 connections per console, 5 seconds to connect and 15 seconds
  per query. A database that doesn't answer in time fails the request instead of hanging it. Migrations run on start
  on a separate connection without those limits.
- **AWS credentials** come from the standard SDK chain: `AWS_PROFILE`, `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`, an instance profile or an ECS task role.
- **`NODE_ENV`** is set by Next.js: `development` for `npm run dev`, `production` for `npm run build` / `npm start`
  (and in the Docker image). `AUTH_MODE=dev` is refused in production.
- **`VERSION`** (Docker build argument, `--build-arg VERSION=<git sha>`) is shown in the sidebar. Outside Docker, set
  `NEXT_PUBLIC_VERSION` when you run `npm run build`.

### The AWS connection: environment or Settings

**Settings → AWS connection** (admins) chooses the account, the sign-in (a profile from `~/.aws`, the default
credentials, or a role to assume), the home region and the regions to read, and switches without a restart. An
environment variable that is set always decides its part: `CONSOLE_SOURCE`; `AWS_REGION` or `AWS_DEFAULT_REGION`;
`AWS_PROFILE` or keys in the environment; `CONSOLE_REGIONS`. `CONSOLE_SOURCE=aws` pins the sign-in too: the console
signs in as its environment says (a task role, IRSA) and an admin can't pick another identity the machine can reach.
The page shows each pinned part read-only and names the variable, so a deployment can pin its connection in its task
definition or compose file. The config file's `inventory.regions`
comes before Settings too. The choice is stored in the console's database, never AWS keys. Several consoles sharing one
database follow a switch within the sampler's next tick (30 s), and refuse a change planned before it. A switch waits for
changes in flight and is refused while any console has a change or an agent run going. If the database can't be read
at boot, the connection is unknown: pages answer `503` until it can be, never the simulated account in its place.
[Connect AWS](connect-aws.md) has the steps.

## console.config.json

Everything in it is optional. Invalid parts (unknown keys, or wrongly typed values such as `"protected": "yes"`) are
never applied and are reported under **Settings → Environments**; in AWS mode `/api/healthz` also answers `degraded`.
Unknown keys are reported in every section, including `services`, `workloads`, `pricing`, `costs` and `provisioning`.
So a typo never takes the console down. If the file becomes unreadable or invalid JSON, the last version read stays in
force. If it can't be read when the console starts, the console fails closed: every environment is protected,
provisioning is off and unassigned map resources are protected until the file is fixed. The file is re-read when it changes (discovery picks it up within a minute, or at once
with **Re-scan now**); no restart needed. Point `$schema` at `console.config.schema.json` for completion in your
editor.

```json
{
  "$schema": "./console.config.schema.json",
  "environments": {
    "staging": {
      "cluster": "acme-staging",
      "branch": "main",
      "databases": ["acme-shared-pg"],
      "routes": [{ "host": "api.staging.acme.dev", "service": "api", "port": 3000 }]
    },
    "production": { "cluster": "acme-prod", "protected": true, "branch": "release" }
  },
  "ignoreClusters": ["legacy-batch"],
  "services": {
    "api": { "name": "Public API", "repo": "acme/api", "healthcheck": { "staging": "https://api.staging.acme.dev/health" } },
    "worker": { "repo": "acme/api", "migrations": ["db/migrate/"] }
  },
  "externals": {
    "stripe": { "label": "Stripe", "sub": "payments API", "side": "destination" }
  },
  "connections": [
    { "from": "service:api", "to": "ext:stripe", "label": "charges", "kind": "api" },
    { "from": "service:worker", "to": "db", "label": "SQL", "kind": "sql" }
  ],
  "github": { "owner": "acme" }
}
```

`examples/demo.console.config.json` is the file the demo uses, with externals and connections for the Acme shop.

### Keys

| Key | Meaning |
|---|---|
| `environments.<id>` | pin an environment id (lowercase letters, digits and dashes) to a cluster |
| `environments.<id>.cluster` | the ECS cluster name (an entry needs this or `host`) |
| `environments.<id>.host` | instead of a cluster: the EC2 instance id of a box that runs the environment with docker compose. Its apps are the `workloads` whose `env` is this id: each shows as a read-only service whose state is the box's, then its health check's (no health check: up while the box runs). The box gets power actions and metrics; restart/deploy, variables, logs, revisions and create & scale stay ECS-only |
| `environments.<id>.region` | the region of that environment's cluster (default: home). Needed when the same cluster name exists in two regions |
| `…label`, `…protected`, `…branch`, `…order` | override what discovery decided |
| `…databases`, `…caches` | attribute these RDS / ElastiCache ids to this environment; the first one found is what the `db` / `cache` connection aliases point at |
| `…routes` | `[{ host, service, port? }]`: host → service for environments without a load balancer (a reverse proxy such as Caddy); used for the routing view and per-service request metrics |
| `discoverClusters` | `false` = only clusters listed under `environments` |
| `ignoreClusters` | cluster names to skip |
| `services.<ECS service name>` | `name`, `repo` (`owner/name`), `healthcheck` (a URL, or a map of environment id → URL), `migrations` (paths), `infra`, `hidden` |
| `externals.<id>` | a system outside AWS, shown on the map: `label` (required), `sub` (a subtitle), `note` (shown in its panel), `side` (`source` on the left, `destination` on the right) |
| `connections[]` | an arrow: `from` and `to` are `service:<name>`, `database:<id>`, `cache:<id>`, `ext:<id>`, or the aliases `ingress` (the environment's load balancer or reverse proxy), `db` (the first of its `databases` that was found, else its first attributed database) and `cache` (likewise from `caches`, else a redis/valkey/memcached service). Optional `label`, `kind` (`http`, `sql`, `cache`, `stream` or `api`) and `envs: ["staging"]` to limit it to some environments. A declared arrow replaces an inferred one between the same pair. |
| `github.owner` | like `GITHUB_OWNER` (and takes precedence over it): match services to `owner/<name>` repositories |
| `pricing.fargateVcpuHour`, `pricing.fargateGbHour`, `pricing.multiplier` | overrides for the [Costs](costs.md) estimate (defaults: on-demand list prices of each resource's region); `multiplier` scales every estimate, for example `0.8` for a 20 % discount |
| `costs.tagKey` | the cost allocation tag that splits spend by environment (default `aws:ecs:clusterName`; a tag of your own may hold the environment id, label or cluster name) |
| `costs.spikePercent` | flag AWS services whose last-7-day average is this much above the 21 days before (default `30`, 1–1000) |
| `costs.cacheHours` | hours a Cost Explorer snapshot is reused, 1–168 (default `6`); each snapshot is about 4 billed requests |
| `provisioning.enabled`, `…maxTasks`, `…maxHosts`, `…allowedInstanceTypes`, `…allowedImageRegistries` | [Create & scale](provisioning.md): `false` turns off copy, scale, run task and add host (deleting what the console created stays possible); most tasks per service (default `10`, 1–1000); most console-created EC2 hosts per environment (default `3`, 0–100); instance types new hosts may use; registries (hosts or host/path prefixes, such as your ECR registry) a copy's replacement image, and an image deployed from the cloud map (**Deploy image**), may come from — unset, **Deploy image** accepts only the registry the container already uses |
| `inventory.idleDays` | [Cloud map](cloud-map.md#idle-resources): days without activity before a resource is marked idle (default `14`, 1–365) |
| `inventory.unassignedProtected` | [Cloud map](cloud-map.md#which-resources-count-as-protected): `true` (default) = resources in no environment follow the protected rules for actions (the protected role, their name and a reason); `false` = treat them like an unprotected environment. Resources a hint or the `console:protected` tag protects stay protected either way |
| `inventory.regions` | Regions the cloud map and discovery read, home (`AWS_REGION`) first: a list of up to 30 region codes, or `"all-enabled"` for every region enabled in the account (`ec2:DescribeRegions`, checked daily). `CONSOLE_REGIONS` wins over it. Default: the home region only. An environment in another region whose id is taken by a home one is shown as `<id>-<region>`, labelled "Production (eu-west-1)" |
| `inventory.providers` | `{ "include": [...], "exclude": [...] }` — provider ids (Settings → AWS permissions) to run only / never. Excluded providers show as turned off |
| `inventory.catchAll` | [Cloud map](cloud-map.md#other-aws-resources): `{ "config": true }` also reads AWS Config's resource inventory in each region (relationships become network fields and links); with `"cloudControlTypes": ["AWS::Glue::Database"]` those types are listed through Cloud Control — each type also needs its own list permission (for this one `glue:GetDatabases`) |
| `ci.deployments` | [GitHub & CI](github.md#which-workflows-deploy): `[{ "repo": "owner/name", "workflow": ".github/workflows/deploy.yml", "env": "<environment id>", "inputs"?: { … } }]` — the workflow files that deploy, and where. A re-run of a bound workflow is a deploy to that environment whatever the workflow is called; or tag the cluster `console:deploy-workflow` |
| `workloads.<id>` | [Cloud map](cloud-map.md#apps-aws-cant-see-declared-workloads): apps AWS can't see as services (docker compose on EC2, another platform) — `name` (required), `env`, `host` (EC2 instance id), `platform`, `healthcheck` (an http(s) URL of at most 2,048 characters), `url`, `repo`, `note`, `uses` (references) |

Tags on your AWS resources can say most of the same things without a file; see
[How discovery works](discovery.md#tag-reference).
