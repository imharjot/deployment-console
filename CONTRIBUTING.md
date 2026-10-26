# Contributing

Thanks for helping. This guide covers setup, a tour of the code, the conventions reviewers look for, and how to add
the things people most often add (an integration, a discovery rule, an AWS call).

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as
described in [SECURITY.md](SECURITY.md), never in a public issue.

## Setup

You need **Node.js 24 or newer** (`node -v`) and npm. The console uses Node's built-in `node:sqlite`, and `node --test`
runs the TypeScript tests directly, so older versions don't work even though `npm install` only warns about them.

```bash
npm install
cp .env.example .env.local   # CONSOLE_SOURCE=mock, AUTH_MODE=dev
npm run dev                  # http://localhost:3200, signed in as an admin
```

`CONSOLE_SOURCE=mock` runs everything against a simulated AWS account for **Acme**, a fictional online shop:
`acme-staging` (one ECS-on-EC2 host with host networking, Caddy in front, Redis in a container) and `acme-production`
(Fargate behind an ALB, RDS, ElastiCache), with rollouts, a failed rollout rolled back by the circuit breaker, an
expired image, migrations in some compares, CI runs with JUnit results and high-volume logs. `AUTH_MODE=dev` signs you in
as an admin. You never need AWS credentials to work on the console.

Because `AUTH_MODE=dev` makes every caller an admin, `npm run dev` listens on **127.0.0.1 only** (`next dev -H
127.0.0.1`), and in dev mode the console answers only requests addressed to `localhost`, `127.0.0.1`, `[::1]` or a
`*.localhost` name — anything else gets `403 "dev mode is only reachable on localhost"`. Don't start it with
`-H 0.0.0.0`; to try the console from a phone or another machine, use `AUTH_MODE=session` and sign in. If you start a
second dev server (say against a real account), bind it to `127.0.0.1` too.

## Before you open a pull request

```bash
npm test            # unit tests (node:test), a few seconds; ends with "ℹ fail 0"
npm run test:pg     # DB and coordinator suites on a throwaway Postgres 16 (see below)
npm run typecheck   # next typegen + tsc --noEmit
npm run lint
npm run build
npm run smoke       # end-to-end, against the running `npm run dev`; ends with "all checks passed"
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, the unit tests, the build and the Postgres suites on every pull
request; run the smoke suite yourself.

**Postgres suites.** `npm test` runs the DB and coordinator suites on in-memory SQLite. `npm run test:pg`
(`scripts/pg-test.mjs`) runs them again on a real Postgres 16, where transactions, advisory-lock migrations and
`ON CONFLICT … WHERE` behave differently: it needs Docker and a local `postgres:16` image (it never pulls; `docker pull
postgres:16` once), starts a container on 127.0.0.1 and always removes it. Without Docker or the image it prints
"skipped". With `PG_TEST_URL` set it uses that server instead (a role that may create databases). Two tests read the docs: `src/lib/iam-policy.test.ts` (every AWS action in the code must be in
the IAM policies and in `docs/connect-aws.md`) and `src/lib/ops-docs.test.ts` (every operation must be in
`docs/operations.md`).

**`npm ci` fails with `Missing: … from lock file`?** That happens in Linux (Docker, CI) when `package-lock.json` was
generated on macOS and lacks Linux-only optional packages. Regenerate the lockfile inside Linux and commit it:

```bash
docker run --rm -v "$PWD:/x" -w /x node:24-alpine npm install --package-lock-only
```

CI runs `npm ci` on Ubuntu, so it catches this in the pull request.

### The smoke suite

`scripts/smoke.mjs` calls every API route and every server-side guard of a running console in the demo
(`BASE=http://localhost:3200` by default; `BASE=http://localhost:3300 npm run smoke` for another port). Mutating calls only touch staging, and only restart a service that is running
(it comes back by itself); every production mutation must be refused. It runs every check and exits non-zero if any
failed. It refuses to start (exit 2) unless the console reports the simulated account `123456789012`, so it can never
act on a console connected to real AWS. When you change the simulated account (`src/lib/server/mock.ts`), update the script's expectations in the
same change — and restart `npm run dev` first: the background sampler keeps the module it started with.

## A tour of the code

```
src/proxy.ts                  every request: CSRF check, identity (session / ALB / dev), x-console-user-* headers
src/app/api/**/route.ts       thin handlers: parse + validate input, check the role, call src/lib/server, return JSON
src/lib/server/               server-only code (imports "server-only")
  sources.ts                  the Cloud and Ci interfaces — the only doors to AWS and GitHub
  aws.ts · github.ts          real implementations
  mock.ts                     the simulated Acme account (CONSOLE_SOURCE=mock)
  discovery.ts                clusters → environments, region-wide inventory, per-env catalog (cached 60 s)
  console.ts                  views (overview, revisions, metrics), guarded + audited actions, background sampler
  logs.ts · observe.ts        logs; metrics, request performance, activity, releases
  db.ts · secrets.ts · audit.ts  the console's own database, sealed secrets, audit log
  auth/                       sessions, users, invites, OIDC flow, bootstrap
  events.ts · notify.ts       notification delivery and what triggers it
  provision.ts                create & scale: copy, scale, run task, add/remove hosts (guards in src/lib/provision.ts)
  billing*.ts                 costs: the Billing interface, Cost Explorer source, simulated numbers, snapshot cache
  ops/                        the operations registry: every capability for agents, approvals, the token-mode gate
  auth/api-tokens.ts          API tokens for agents (hash only, role capped by the owner)
src/lib/*.ts                  pure logic shared by server and UI, unit-tested next to the file (*.test.ts)
  discover.ts                 discovery rules: env naming, image parsing, connection inference, attribution
  status.ts · actions.ts      state precedence table; action and power guards (the UI's buttons use the same functions)
  logpaging.ts · logstore.ts · logquery.ts   log cursors and merging; the browser's log buffer; the query language
  console-config.ts           console.config.json parser (lenient: keeps valid parts, reports the rest)
  rbac.ts · authn.ts · oidc.ts · auth.ts     roles; session/token helpers; OIDC; ALB header verification
  plugins/                    integrations (Slack, webhook, GitHub Issues, Jira, Linear, ClickUp, Asana)
  costs.ts · spend.ts         list-price estimates; spend analysis (forecast, spikes, tag → env mapping)
  ops-schema.ts · automation.ts · mcp.ts   input validation + tool definitions; token modes and gate; MCP JSON-RPC
src/app/**/page.tsx, src/components/   the UI (Next.js App Router, React 19, Tailwind 4)
docs/                         user documentation, also rendered in-app at /docs
infra/                        IAM policies and an ECS task definition for running the console
examples/                     demo config, a GitHub Actions deploy workflow and a reference agent (examples/agent)
```

`CODEX.md` has the architectural decisions and the gotchas that have bitten people before — read it before larger
changes.

## Conventions

- **Nothing company-specific.** No names, hosts, account ids or branch names of a real organisation in code, tests,
  fixtures or docs. Use the fictional Acme (`acme-staging`, `api.staging.acme.dev`, account `123456789012`,
  documentation IPs such as `203.0.113.10`). What a real deployment needs goes in its own `console.config.json` or tags.
- **Discovery over configuration.** Prefer reading a fact from AWS (or a `console:*` tag) to adding a config key. If
  you add a key, update `console-config.ts`, `console.config.schema.json`, its tests and `docs/configuration.md`.
- **Pure logic in pure modules.** Anything with rules (parsing, guards, precedence, merging) goes in a module without
  `server-only`, imported with a relative `.ts` path, so `node --test` can run it. Server modules stay thin.
- **One guard, two callers.** Action/power checks live in `src/lib/actions.ts` and are used both to draw buttons and to
  gate the API. Never re-implement a check in a component or a route.
- **Errors.** Throw `HttpError(status, message)` (`src/lib/server/errors.ts`) for anything the caller should see; wrap
  every route in `handle()` (`src/lib/server/http.ts`), which turns `HttpError` into JSON and logs the rest. Use
  `errText()` to describe third-party errors; never leak secrets or environment values into messages.
- **Validate at the edge.** Routes validate every input (`envOf`, `readJson`, `parseActionBody`, …) and check the role
  with `requirePerm` before calling into `src/lib/server`. Client-supplied names must resolve through discovery
  before they reach AWS.
- **TypeScript strict, no `any`.** Prefer precise types from `src/lib/types.ts`; narrow `unknown` input explicitly.
- **Comments say why.** Explain intent, trade-offs and non-obvious constraints; don't narrate the code, and don't
  reference private documents or ticket ids. No `TODO`/`FIXME` in merged code — open an issue instead.
- **Environment variables** are read in one place, documented in `.env.example` and `docs/configuration.md` (or
  `docs/auth.md`), and an empty value behaves like an unset one.
- **Database migrations are append-only** (`MIGRATIONS` in `db.ts`): add a new entry, never edit a shipped one, and
  keep statements idempotent and portable between SQLite and Postgres.
- **Style:** match the surrounding code — 2-space indent, double quotes, semicolons, lines up to ~150 characters.
  `npm run lint` must be clean.
- **Docs travel with code.** A change in behaviour, an endpoint, a tag, an env var or an IAM permission updates
  `docs/` in the same pull request. Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).

## How discovery rules are tested

1. **Rules** (`src/lib/discover.ts`) are pure functions over raw describes: `envsFromClusters`, `parseImageRef`,
   `shaFromTag`, `hostsFromEnv`, `inferEdges`, `attribute`. Add a case to `src/lib/discover.test.ts` for every new rule
   or edge case — a cluster naming scheme, an image tag format, a connection-string shape.
2. **The engine** (`src/lib/server/discovery.ts`) runs for real against the simulated account, whose tags, security
   groups and connection strings are chosen so each rule has something to find (staging edges come from connection
   strings on a shared host network, production edges from security groups, RDS/ElastiCache attribution from
   reachability and names).
3. **End to end**, `npm run smoke` asserts what discovery must produce: two environments with the right protection,
   security-group and connection-string edges, one database per env and a cache in production, every topology edge
   joining two nodes, and every clickable node resolving to a resource.

## Adding an integration

Integrations are small, self-contained plugins; the settings UI, storage, secret sealing, test button, notification
routing and ticket creation pick them up automatically.

1. Create `src/lib/plugins/<id>.ts` exporting a `Plugin` (`src/lib/plugins/types.ts`): `id`, `name`, `description`,
   `icon` (a lucide icon name), `capabilities` (`notify` and/or `tickets`), the settings `fields`, `test()`, and
   `notify()` and/or `createTicket()`.
2. Build each HTTP request in an exported pure function that returns a `Req`, and perform it with `send()` from
   `src/lib/plugins/http.ts`. Mark every credential (tokens, URLs that embed tokens) `type: "secret"`.
3. Add the plugin to `PLUGINS` in `src/lib/plugins/registry.ts`.
4. Test the request builders in `src/lib/plugins/plugins.test.ts` (no network): URL, auth header, body shape, escaping.
5. Document it in `docs/integrations.md` (table row and what the admin provides).

## Adding an AWS call

1. Add the method to `Cloud` in `src/lib/server/sources.ts`, implement it in `aws.ts` (always pass the timeout signal
   `t()`) and in `mock.ts` so the demo keeps working.
2. Grant the IAM action in `infra/iam-policy-readonly.json` (reads) and `infra/iam-policy.json`, and explain it in the
   permission table of `docs/connect-aws.md`. `src/lib/iam-policy.test.ts` fails until all three agree with the SDK
   commands `aws.ts` imports — and also when a permission is granted but no longer used.
3. Writes must go through a pure guard (`src/lib/actions.ts`, `src/lib/provision.ts`, …) and through `audited()` in
   `console.ts` (audit intent before the call, result after).

## Adding an operation (for agents and the API)

1. Put the logic in `src/lib/server/` as usual, with its guards pure and tested; the UI route and the operation both
   call it, so they can never disagree.
2. Declare the operation in `src/lib/server/ops/<area>.ts` (see `ops/types.ts`): a stable `<area>.<verb>` name, a
   description written for a language model (what it does, when to use it, what it returns, what it refuses), a JSON
   Schema input, `risk` (`read` / `change` / `danger`, plus `riskOf()` when some inputs make it riskier), the `perm`
   it needs, `env()` when it touches an environment, a `plan()` for dry runs, and `secretFields` for inputs that must
   never be echoed.
3. Return compact JSON, not UI view models. Never return secret values.
4. Add a row to `docs/operations.md`; `src/lib/ops-docs.test.ts` fails until you do.

## Changing the docs

The pages in `docs/` are rendered on GitHub and inside the app at `/docs/<page>`, so a few rules keep both working:

- Link between pages with plain sibling links (`[Costs](costs.md#what-it-costs)`); the app rewrites them. Refer to
  other repository files as code (`infra/iam-policy.json`) rather than links, which the app can't serve.
- Keep headings plain — letters, digits, spaces, and at most colons and commas — so GitHub and the app produce the
  same anchors.
- A new page needs an entry in `src/app/docs/nav.ts` (its order is the reading order), and every entry needs a page.
- Keep the fictional Acme names, `123456789012` and `example.com`; write for someone trying the console for the first
  time.

Run `npm run dev` and open `/docs` to check how a page renders.

## Pull requests

Keep them focused: one change, its tests and its docs. Describe what changed, why, and how you verified it (the
template asks). Screenshots help for UI changes — the demo data makes them reproducible.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the same
license as the project.
