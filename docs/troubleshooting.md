# Troubleshooting

Start at **Settings → Environments**: AWS errors, config-file problems and per-service warnings are listed there. The
server log (your terminal, `docker compose logs console`, or the `/ecs/deployment-console` log group) has the rest.

## Getting started

| What you see | Likely cause | Fix |
|---|---|---|
| `npm warn EBADENGINE … required: { node: '>=24' }` | Node.js older than 24 | install Node.js 24 or newer; the console uses its built-in SQLite and runs TypeScript tests natively |
| `No such built-in module: node:sqlite` | Node.js too old | as above |
| `ExperimentalWarning: SQLite is an experimental feature` | normal on Node.js 24 | nothing to do |
| `listen EADDRINUSE … :3200` | the port is taken | `npx next dev -p 3300` |
| "Console misconfigured": `AUTH_MODE=dev is refused when NODE_ENV=production` | `AUTH_MODE=dev` with `npm start` or the Docker image | use `npm run dev` for the demo, or set `AUTH_MODE=session` |
| "Console misconfigured": `AUTH_MODE "…" is not one of session, alb, dev` | a typo in `AUTH_MODE` | fix the value and restart |
| Changed `.env.local` but nothing happened | environment variables are read at start | restart the server |

## Connecting AWS

| What you see | Likely cause | Fix |
|---|---|---|
| The **Mock data** banner is still there | nobody connected AWS yet, or `CONSOLE_SOURCE=mock` is set | connect it in **Settings → AWS connection**; if the page says `CONSOLE_SOURCE` decides, unset it (or set `aws`) where the console runs and restart |
| Settings → AWS connection shows a part read-only, "set by …" | that environment variable (or `inventory.regions` in the config file) decides it | change or unset it where the console runs, then restart |
| `AWS didn't accept this connection: …` when saving | the sign-in can't reach AWS: an unknown or expired profile, a role whose trust policy doesn't name the console's credentials, or no credentials at all | **Test connection** shows the same error; run `aws sts get-caller-identity --profile <name>` with the same profile |
| `… change(s) still running; switch once they finish` | a restart, deploy or other change is in flight on the current account | wait for it (the service card shows it), then save again |
| `… agent run(s) haven't finished` when switching | an agent run is still going on the current account; its plan names that account's resources | cancel it in **Automation** or let it finish, then save again |
| `this console's AWS connection changed since the page loaded` | another admin (or another console sharing the database) switched the connection | reload the page: it shows the new account; make the change again if it still applies |
| `503 the console's database is unavailable, so its AWS connection isn't known yet` | the database couldn't be read at boot, and Settings holds the connection | bring the database back; the console reads the connection within 30 s (or pin it with `CONSOLE_SOURCE`) |
| `CONSOLE_SOURCE must be "aws" or "mock"` | a typo in `CONSOLE_SOURCE` (the console never falls back to the demo) | fix it and restart |
| "No environments found yet" | wrong home region, or no ECS clusters there | **Test connection** in Settings → AWS connection lists the clusters per region; pick that home region (or set `AWS_REGION`) |
| `Could not load credentials`, `ExpiredToken` | no credentials, or an expired SSO session | pick a profile in Settings → AWS connection (or set `AWS_PROFILE`); run `aws sso login` |
| `AccessDeniedException` at the top of Settings | the role lacks a permission | attach [the policy](connect-aws.md#step-1-create-the-read-only-policy); the message names the missing action |
| A button fails with `AccessDenied…` | the read-only policy, or a statement left out | add the feature's statements (see [Connect AWS](connect-aws.md#step-5-turn-on-more-one-feature-at-a-time)) |
| A cluster is missing | it isn't `ACTIVE`, it's tagged `console:ignore=true`, it's in `ignoreClusters` / not listed with `discoverClusters: false`, or it's an AWS Batch cluster (`AWSBatch-…`, skipped unless the config names it) | see [How discovery works](discovery.md) |
| An environment in `console.config.json` doesn't appear | the cluster it names isn't there: a typo, another region, not `ACTIVE`, ignored, or two entries name the same cluster | **Settings → Environments → Configured but not found** says which, with a "did you mean" and the region it looked in. Fix the name, set `environments.<id>.region` (and add the region to `CONSOLE_REGIONS` or `inventory.regions`), or remove the duplicate entry. Workloads declared for that environment still show on the cloud map |
| A configured database or cache isn't attributed | its id in `environments.<id>.databases` / `caches` matches nothing in that environment's region | the same card names the id and the closest real one; use the RDS instance id or the ElastiCache replication group / cluster id |
| An environment shows in the cloud map but not in Settings or the switcher | the map placed resources in it by tags or names, but no ECS cluster backs it | normal: it's listed under **Environments on the cloud map only** and has no overview, services or variables (see [Limitations](limitations.md)) |
| A production cluster isn't protected | its name has no production word | tag it `console:protected=true` |
| A config-file error under Settings | an unknown key or a wrongly typed value (`"protected": "yes"`): that value is ignored, the rest applies | fix the file; the error names the key. In AWS mode `/api/healthz` answers `degraded` until it's fixed |
| "still using the version read …" under Settings | the file became unreadable or invalid JSON after the console had read it | fix the file; until then the last good version stays in force |
| Every environment is protected and provisioning is off; Settings says the console "fails closed" | the config file couldn't be read when the console started (invalid JSON, or `CONSOLE_CONFIG` points at a missing file) | fix the file, or unset `CONSOLE_CONFIG`; the console picks it up on the next request |

## Services, logs and metrics

| What you see | Likely cause | Fix |
|---|---|---|
| A service shows no Logs tab | its main container doesn't use the `awslogs` driver | switch the log driver, or use FireLens → CloudWatch |
| Logs for a service are empty | stream prefix mismatch in a shared log group | check `awslogs-stream-prefix` in the task definition |
| Commit shows "unknown" | the image tag has no git sha (for example `latest`) | tag images with the commit in CI |
| No repo or no CI for a service | not mapped to a repository | tag `console:repo=owner/name` or set `GITHUB_OWNER` (see [GitHub & CI](github.md)) |
| The CI page says *Connect GitHub to see runs* | no GitHub token (the API answers 503 `not_configured`) | set `GITHUB_TOKEN` (CI only works with `CONSOLE_SOURCE=aws`; the demo simulates it) |
| A database sits under "Not attributed to any environment" | no tag, name or connection places it | tag it `console:env=<id>` or list it in the config file |
| A missing arrow | the dependency isn't visible (endpoint in Secrets Manager, external SaaS) | add it under `connections` in the config file |
| Request performance: "no request data" | no load balancer, and no reverse proxy with Caddy JSON access logs | put the services behind an ALB, or enable `log { format json }` in Caddy |
| A service is DEGRADED although it works | a failing `console:healthcheck` probe (it must answer HTTP 200 without redirects) or an unhealthy load-balancer target | open the service's panel: the reasons say which signal failed |
| "console:healthcheck tag … — not probed" under Settings | the tag isn't an `http://` or `https://` URL, has spaces or a password in it, or is longer than 2,048 characters | fix the tag; the console probes nothing else |
| Logs: "following 24 of N log streams" | the console tails at most 24 streams (the newest per service) and polls quiet streams every 10 s, to stay under CloudWatch's 25-per-second GetLogEvents quota | pick fewer services |
| Search: "No matches in the part scanned so far" | the search reads the range in time-bounded steps | **Continue scanning**, or use Logs Insights for wide ranges |
| Logs Insights answers 429 | at most 10 queries per person per 5 minutes, 5 running at once | wait for running queries to finish |
| UNKNOWN everywhere and an amber banner | the browser couldn't refresh the data for longer than it stays fresh | the banner names the time of the data and the error; **Retry** tries again. Nothing is shown as healthy from old data |

## Environment variables

| What you see | Likely cause | Fix |
|---|---|---|
| `… shared with production/api (protected) — needs operator role` | the parameter, secret or env file is also read by a service in a protected environment, so it follows that environment's rules | ask someone with the operator role, who confirms with the service name and a reason |
| `… also used by the console's own service` | the console's own service reads that parameter, secret or file | nobody changes or reveals it through the console; change it in AWS |
| `… an API token can change it only through an approved request` | an `act` token tried to change an object a protected service also reads | use a token in `propose` mode (a person approves the change), or make the change yourself |
| `couldn't check which other services use it … — needs operator role` | discovery couldn't read every environment, so the console can't rule out a protected (or its own) service sharing the reference | wait for discovery to recover (Settings → Environments shows the error), or ask an operator |
| `409 conflicting edits: …` | two changes in one save disagree about one object (two values for one parameter or JSON key, or a name set by one container and removed by another) | make one change per object |
| `409 env file changed since it was read` / `secret changed since it was read` | someone changed the object in AWS while the console was saving; nothing was overwritten | reload the variables and make the change again |
| `409 another change to … is in progress` | another save, action or deploy holds the service or a shared object | wait for it to finish and try again |

## Sign-in

| What you see | Likely cause | Fix |
|---|---|---|
| No setup token in the log | a user already exists, or `CONSOLE_ADMIN_EMAIL` created one | sign in as that user; with Docker check `docker compose logs console` |
| Can't find or lost the setup token | the log line scrolled away | restart the console: while there are no users, every start prints a new token (earlier unexpired ones still work). Or set `CONSOLE_ADMIN_EMAIL` and `CONSOLE_ADMIN_PASSWORD` (at least 10 characters) and restart |
| `CONSOLE_ADMIN_PASSWORD rejected` in the log | the password is shorter than 10 characters | choose a longer one and restart |
| `CONSOLE_ADMIN_EMAIL is set without CONSOLE_ADMIN_PASSWORD` in the log | no password, and neither OIDC nor `AUTH_MODE=alb` is set up, so nobody could sign in as that admin | set a password, configure SSO, or use the setup token printed next |
| Locked out after switching from `AUTH_MODE=dev` to `session` | the demo's dev user has no password | switch back to `dev`, set a password under **Account → Password**, then switch again; or start with an empty `CONSOLE_DATA_DIR` (see [Sign-in & roles](auth.md#first-run-create-the-first-admin)) |
| SSO: the provider says the redirect URI doesn't match | `CONSOLE_PUBLIC_URL` differs from what you registered | register `<CONSOLE_PUBLIC_URL>/api/auth/oidc/callback` exactly |
| No SSO button | `OIDC_ISSUER` isn't `https`, or `OIDC_CLIENT_ID` is missing | check the warning in the server log |
| "Not allowed": `… has not been invited to this console` | the user wasn't invited and their domain isn't allowed | invite them, or add the domain to `AUTH_ALLOWED_DOMAINS` |
| Signed out right after signing in, or redirected to the wrong host | `CONSOLE_PUBLIC_URL` doesn't match the address in the browser | set it to the exact address people use |
| `cross-site request refused` in the browser | the address in the browser isn't exactly `CONSOLE_PUBLIC_URL` (for example `127.0.0.1` instead of `localhost`, or another port) | open the console at `CONSOLE_PUBLIC_URL`, or set it to the address people use |
| `cross-site request refused` from a script | a `POST` without the `x-console-csrf: 1` header or with another site's `Origin` | normal: use an [API token](automation.md) instead of a session |
| `alb` mode: every request gets `401` | `ALB_ARN` is missing, or it isn't the ARN of the load balancer in front | set `ALB_ARN` to that load balancer's ARN |
| Buttons disabled with "needs operator role" | your role | ask an admin (**Settings → Users & roles**) |

## Running it

| What you see | Likely cause | Fix |
|---|---|---|
| "Console unavailable: the console database is unavailable" | the console can't reach Postgres | check `DATABASE_URL`, security groups and TLS |
| The deployment rolls back or the target never turns healthy; the log says `health check failed: misconfigured` | a fatal setting: an invalid `AUTH_MODE` or `CONSOLE_SOURCE`, a `DATABASE_URL` that isn't `postgres://…`, or a missing (with Postgres) or too short `CONSOLE_SECRET_KEY` | the same log line names the problem; fix it and deploy again |
| `self-signed certificate in certificate chain` connecting to RDS | `sslmode=require` checks the RDS certificate against Node.js's built-in authorities | use `sslmode=no-verify`, or the RDS bundle with `sslmode=verify-full&sslrootcert=…` (see [Deploy the console](deploy.md#step-2-prepare-the-database)) |
| "Console misconfigured": `CONSOLE_SECRET_KEY is required …` or `… at least 32 characters` | Postgres without a key, or a key shorter than 32 characters | set `CONSOLE_SECRET_KEY` (`openssl rand -base64 48`) |
| The ECS task stops with `ResourceInitializationError` | the execution role can't read a secret, or a secret in the task definition doesn't exist (for example an unused `GITHUB_TOKEN`) | create the parameter or remove it from `secrets`; check the execution role |
| `exec format error` when the task starts | the image was built for another CPU architecture | build with `--platform linux/amd64` (or set `ARM64` in the task definition) |
| Duplicate notifications | more than one console task is running | run exactly one task |
| Every service says "the console never acts on its own service" | on ECS, the task metadata endpoint didn't answer, so the console can't tell which service is its own and refuses changes everywhere (the log says `ECS task metadata unavailable`) | set `CONSOLE_SELF=<cluster>/<task family>` |
| Sign-in or token throttling seems to do nothing | per-address throttles need `X-Forwarded-For`, and are off with `CONSOLE_TRUSTED_PROXIES=0` | run the console behind a load balancer or reverse proxy that appends it, and set `CONSOLE_TRUSTED_PROXIES` to the number of proxies |
| The audit log shows a load balancer's or CloudFront's address instead of people's | `CONSOLE_TRUSTED_PROXIES` is lower than the number of proxies in front | set it to `2` for CloudFront → ALB |
| An integration test fails with `redirects aren't followed` or `link-local … not allowed` | the URL answers with a redirect, or points at a link-local (cloud metadata) address | use the final URL after redirects; see [Integrations](integrations.md#allowed-urls) |

## Agents and API

| What you see | Likely cause | Fix |
|---|---|---|
| `401` with a token | unknown, expired or revoked token, or its owner is disabled | create a new token |
| `403 API tokens are turned off on this console` | `CONSOLE_API_TOKENS` is set to something other than `true`, `1`, `yes` or `on` (a typo counts as off) | set it back to `true` (or remove it) and restart |
| `403 API tokens can only use the operations API …` | the token called a page or another route | use `/api/ops`, `/api/mcp`, `/api/approvals`, `/api/events` or `/api/me` |
| `403 Agent tokens can only use the operations API …` | an agent token (`da_`) called a page or another route | use `/api/ops`, `/api/mcp`, `/api/approvals`, `/api/events` or `/api/me` |
| `403 this token is read-only …` | a *read* token asked for a change | create a token in *propose* or *act* mode |
| `429` with `Retry-After` | a rate limit (120 requests per minute per token, or too many failed tokens from your address) | wait and retry |
| `202` instead of a result | the change needs a person | approve it under **Automation → Approvals**, then check `GET /api/approvals/<id>` |
| Approving answers `403 … requires a second person` | `CONSOLE_APPROVALS_TWO_PERSON=true`, and the request came from your own token | ask someone else with the permission to approve it |
| Approving answers `409 the token that asked was revoked …` | the token was revoked or expired, or its owner was disabled or deleted; the request is now rejected | have the agent ask again with a valid token |
| `503 agents are turned off on this console` | the agents switch is off (`CONSOLE_AGENTS`, or an admin's toggle; off by default against a real AWS account) | an admin turns agents on (`POST /api/agents/settings { "enabled": true }`), or set `CONSOLE_AGENTS=on` |
| `403 the agent's policy refuses this: …` | the agent's policy (the reason names the rule) | change the agent definition's policy (people only), or do it yourself |
| Approving answers `409 the plan changed since it was requested` | what the request would change is different now | the agent (or token) asks again |
| MCP client: `unknown tool` | tool names use `_`, or the token may not call it | use `services_restart`, not `services.restart`; check the token's role and mode |
| `alb` mode: agents are redirected to the identity provider | the load balancer authenticates token requests too | add the listener rule from [Agents & API](automation.md#alb-sign-in) |

## Useful endpoints

- `GET /api/healthz` — liveness, no sign-in needed; `500 misconfigured` when `AUTH_MODE` or `CONSOLE_SECRET_KEY` is
  wrong (the reason is in the server log); `degraded` (still `200`) in AWS mode while the config file has errors.
- `GET /api/discovery` — the full discovery result as JSON (signed in), with `warnings` for what the config file names
  that the account doesn't have.
- `GET /api/connection` — the AWS connection (admins): the account and identity AWS confirms, the sign-in, the home
  region and regions, and which environment variable decides each part; `POST /api/connection/test` tries a candidate.
- `GET /api/me` — who you are, your role and permissions (signed in, or with a token).
