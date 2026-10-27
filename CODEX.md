# deployment-console — durable context

Orientation for maintainers and coding agents. Contributor workflow: [CONTRIBUTING.md](CONTRIBUTING.md). User docs: [`docs/`](docs/).

**What:** a self-hosted, company-agnostic console for teams on Amazon ECS. It discovers environments (one per ECS
cluster, or a docker compose EC2 box pinned in config with `environments.<id>.host` — kind `compose`: cluster "", no ECS
services (`servicesAt("")` answers []), its `workloads` become read-only service tiles judged by `deriveWorkloadState`,
`workloadGraph` draws them, provisioning refuses it), services, EC2 hosts, RDS, ElastiCache, ALBs and their connections from AWS, and provides status, logs,
metrics, CI, releases, guarded actions, environment variables, create & scale, costs, sign-in with roles, an audit
log, notifications, ticketing and an agent-ready operations API (tokens, approvals, events, MCP). Nothing about
any company lives in the code; an optional `console.config.json` fills the gaps AWS can't answer.

**Status:** early product (0.1.0). Verified with unit tests, the end-to-end smoke suite (`npm run smoke`) and browser
checks against the simulated account. Real-AWS calls use the SDK's documented request shapes; try a staging account
first. License: Apache-2.0 (LICENSE).

**How it's organised:**
- Discovery rules are pure and tested: `src/lib/discover.ts` (env naming from clusters, image/sha parsing, connection
  inference from security groups and connection strings, attribution of RDS/ElastiCache to envs).
- The engine `src/lib/server/discovery.ts` builds a per-region inventory every 60 s across the console's regions
  (`src/lib/server/regions.ts`: `CONSOLE_REGIONS`, else config `inventory.regions`, else home; ids unique across regions
  via `regionalIds` in `src/lib/regions.ts`, a colliding non-home env becomes `<id>-<region>`) (`listEnvs`, `envInfo`,
  `catalog`, `metaOf`, `knownRepos`). Every `EnvInfo` has a `region`; its services, hosts, databases and caches are read
  there (`cloudFor(env)`). Everything else reads it.
- AWS calls: every SDK client goes through `limitedClient` (`src/lib/server/aws-limiter.ts`: a per service × region
  slot, then a global cap of 16 (`CONSOLE_AWS_CONCURRENCY`); `withCallSignal` carries a provider's deadline into nested
  calls; `awsCallStats()` → `GET /api/diagnostics/aws`). The wrapper also reports each call to `capability.ts`
  (`observeCalls`, registered at boot from `instrumentation.ts`) and flags a write aborted after it was sent as outcome
  unknown. `src/lib/server/sdk-clients.test.ts` fails on an unwrapped `new …Client(`. Writes use separate no-retry
  clients with `LIMITS.awsWriteTimeoutMs`; a write cut off after it was sent throws `OutcomeUnknownError`. `aws.ts`
  caches target health per ARN (10 s), load-balancer config (10 min) and scalable targets (5 min); its pure response
  mapping lives in `src/lib/aws-mapping.ts`. The simulated account's launched hosts join ECS 90 s after launch.
- `console.config.json` (optional, schema in `console.config.schema.json`, parser `src/lib/console-config.ts`) only
  fills gaps. It is loaded by `src/lib/server/config-check.ts`: the last good version stays on
  `globalThis.__consoleConfigFile`; a file that can't be read at boot fails closed (`FAIL_CLOSED_CONFIG`: every
  environment protected, provisioning off), and in AWS mode config errors make `/api/healthz` answer `degraded` (200).
  Config-vs-account warnings are pure in `src/lib/discovery-rules.ts`. The demo uses
  `examples/demo.console.config.json` (with `ci.deployments` bindings); a real deployment keeps its own file outside the
  repo (`CONSOLE_CONFIG`). The parser reports unknown keys in every section the schema closes (`console-config.test.ts`
  walks the schema to keep it so).
- `Cloud` and `Ci` (`src/lib/server/sources.ts`) are the only doors to the outside: `aws.ts` / `github.ts` are the
  real implementations, `mock.ts` a complete simulated account for a fictional shop ("Acme": clusters, tags, security
  groups, connection strings, rollouts, logs, CI) so discovery runs for real in the demo. `CONSOLE_SOURCE` picks one,
  else Settings → AWS connection (below), else the simulated account.
- The AWS connection switches at runtime (`src/lib/server/connection.ts`, rules in `src/lib/connection-rules.ts`): an
  admin picks the account, the sign-in (a profile from `~/.aws`, the default chain, or a role assumed from it:
  `connection-credentials.ts`), the home region and the regions. Every env var that is set decides its part
  (`CONSOLE_SOURCE`, `AWS_REGION`/`AWS_DEFAULT_REGION`, `AWS_PROFILE` or keys, `CONSOLE_REGIONS`; `inventory.regions`
  too). The choice is settings key `connection` (with a `rev`), loaded by `instrumentation.ts` before anything reads AWS;
  other consoles on the same database pick up a new `rev` in the sampler's tick. No keys are ever stored.
- A switch retires a *generation* instead of hunting down state (`connection-state.ts`):
  - `bumpGeneration()` aborts every AWS call in flight (`ctrl`), drops the stores read through globalThis (its
    `DROPPED` list), and runs each module's `onConnectionChange` hook. A hook clears, in place, a store the module
    holds in a constant; the other bundle's copy holds the same object.
  - Old SDK clients refuse to send (`limitedClient` stamps a generation), and old Clouds and CIs refuse calls
    (`retire()`).
  - A cache fill started earlier is never stored (`cache.ts`).
  - Background writers compare the generation they started with: the sampler, overview history, the inventory's
    plan and `publish()`, the capability refresh, the costs snapshot.
  - Module-level clients are `perGeneration()` and `perRegion()` maps start over. Every client config carries
    `connectionCredentials`, which asks the current generation's provider.
  - The barrier: `mutate()` refuses while a switch runs (`switching`), and counts the changes in flight (`writes`)
    before its first await. The switch waits for them, then refuses while any console has an operation `running` or an
    agent run unfinished. It writes the connection row compare-and-swap, together with the scope and the forget, in one
    audited transaction. `mutate()` also refuses (409) when the database holds a newer `rev` than this console applied.
  - The switch signal is never put in `AbortSignal.any` (Node keeps a composite per call alive on a long-lived source):
    `limitedClient` follows it with a per-call controller and removes its listener when the call settles.
  - New account or home region (`ensureScope`, settings key `connection:scope`): `forgetAccountData()` drops what would
    act on or describe the new account's same-named services. That is `desired:*`, `observed:*`, `state_changes`,
    `costs:snapshot`, pending host reservations (→ `released`), pending approvals (→ `expired`) and unused grants. The
    first scope ever recorded keeps what is there. Operation verification, recent operations and host issues ignore rows
    from before the scope, and the sampler re-checks the scope with AWS until it is confirmed for the generation.
- Look and feel: tokens, type scale and motion utilities in `src/app/globals.css` (Manrope / JetBrains Mono / Bricolage
  Grotesque via next/font in `layout.tsx`; body 14px, `text-xs` = 13px, nothing under 11px; `stagger` and `lift` for
  arrivals and hover). Effects level `<html data-perf>` is set before paint (`layout.tsx`: saved choice, else lite on
  ≤ 4 threads / ≤ 4 GB / Save-Data / reduced motion): lite drops blur and looping animations, `MotionConfig` keeps
  fades only, and the `slowerWhenLite` SWR middleware doubles polling (`src/lib/client/perf.ts`). Settings sections
  and their grouping live in `src/app/settings/sections.ts` (the layout's side nav, section headers and the overview
  cards); `/account` redirects to `/settings/account`; Settings → Interface holds theme, effects and sidebar.
- Views, guarded actions and the background sampler: `src/lib/server/console.ts`; the guards themselves are pure
  (`src/lib/actions.ts`, `src/lib/status.ts`, view rules in `src/lib/overview-rules.ts`) and shared with the UI so
  buttons and server never disagree. Console actions answer "AWS accepted" with an operation id; the sampler marks ECS
  operations verified (or "did not stabilise" after 15 min), shown on the cards, `services.get` and the audit log.
- Variables: `src/lib/server/envvars.ts` over the pure rules in `src/lib/envvars.ts`. Saves run on `mutate()` with the
  ECS key, every backing object (`ssm:`, `secret:`, `s3:`) and other readers' ECS keys; shared references follow their
  strongest reader (the `vars:refs` index, which includes the console's own service even when its cluster isn't an
  environment — `selfOutsideEnvs`). `variables.update` declares `protectedOf` (`varsProtected()`), so an API token's
  save that changes a reference a protected service reads becomes an approval. Value fingerprints use
  `derivedKey("var-fingerprint")` (`secrets.ts`).
- Logs: `src/lib/server/logs.ts` over the pure rules in `src/lib/logpaging.ts` (cursors, merge, stream cap
  `pickStreams`, idle backoff in the client cursor, a process-wide GetLogEvents `TokenBucket` on
  `globalThis.__consoleLogLimits`, the search loop `scanPages` with `LIMITS.logSearchBudgetMs`); Insights ownership and
  rate limits on `globalThis.__consoleInsights`. The browser keeps a mutable `LogStore` (`src/lib/logstore.ts`, bounded
  by lines and bytes) and filters with `src/lib/logquery.ts`. Metrics rules are pure in `src/lib/observe-rules.ts` /
  `src/lib/perf.ts` (per-minute scaling, own-ALB attribution, markers); CI deployment binding (`ci.deployments`, the
  `console:deploy-workflow` tag) and migration checks in `src/lib/ci-rules.ts`; `rerunCiRun()` (`server/ci.ts`) is the
  only re-run path.
- Console DB: SQLite built into Node 24 by default, Postgres with `DATABASE_URL`. Holds users, sessions, one-time
  links, audit, integrations (secrets sealed by `secrets.ts`), deliveries, settings (incl. remembered desired counts),
  operations, leases, host reservations, inventory runs and the workspace/agent tables (schema v7: migrations 4–7, which
  are frozen; add 8+). Adapters, schema and migrations are in `src/lib/db-core.ts` (pure; tested on SQLite and, via
  `npm run test:pg` = `node scripts/pg-test.mjs`, a throwaway Postgres 16); `src/lib/server/db.ts` keeps one
  connection/pool per process on `globalThis.__consoleDb`. SQLite serialises every statement behind an open transaction
  (an AsyncLocalStorage on `globalThis.__consoleDbAls` routes calls made inside `tx()` to its handle); Postgres has
  connection/query/statement timeouts (pool of 5, 5 s connect, 15 s query) and runs migrations under an advisory lock on
  a dedicated connection without those timeouts. Migrations are append-only arrays of statements (`{sqlite, postgres}`
  where they differ).
- Changes: the mutation coordinator (`src/lib/server/mutations.ts` over the pure `src/lib/mutation-core.ts`; every AWS
  or integration change runs on `mutate()` — console actions and power, provisioning, variable saves and reveals, map
  actions, CI re-runs, integration saves and tickets; `lockService()` and `audited()` are gone): canonical keys
  (`src/lib/mutation-keys.ts`), in-process mutexes plus fenced DB leases, an operations row and audit intent committed
  together before any side effect, `outcome_unknown` when AWS may have acted, idempotency keys, reconciliation and
  SIGTERM drain (`NEXT_MANUAL_SIG_HANDLE=true`, set in the Dockerfile). Operation records:
  `src/lib/server/operations.ts`. Errors reach clients as `{ error, code?, setup?, operationId? }` (`errorBody()` in
  `src/lib/server/errors.ts`).
- Auth: `src/proxy.ts` + `src/lib/server/auth/`; pure helpers in `src/lib/authn.ts`, `src/lib/oidc.ts`,
  `src/lib/auth.ts` (ALB: `exp` comes from the signed header); roles in `src/lib/rbac.ts` (viewer < developer < operator
  < admin). Dev mode is loopback-only (`src/lib/dev-host.ts`), checked first in `proxy.ts` and again where first
  passwords and tokens are minted. SSO accounts are bound to their first `sub` (`/login?error=sso_mismatch` otherwise);
  `email_verified` is required by default (`OIDC_REQUIRE_EMAIL_VERIFIED`).
- Integrations: one file per plugin in `src/lib/plugins/` + a line in `registry.ts`; `emit()` in
  `src/lib/server/events.ts` (5 s timeout, one retry, 60 s dedupe, deliveries kept 14 days); `src/lib/server/notify.ts`
  turns sampler transitions and actions into events; the CI watcher starts from `src/instrumentation.ts`. Outbound URLs
  go through `safeFetch` / `checkTarget` in `src/lib/plugins/http.ts`: the host is resolved once, every address is
  checked and pinned for the socket (the TLS name is kept), the signal bounds the DNS lookup, link-local is refused in
  every IPv6 spelling and private addresses unless `allowPrivate`; a 2xx with a cut-off body is outcome unknown (the
  error carries `outcomeUnknown: true`). Integration writes and tickets run through `mutate()` with
  `console:integration/<id>` and `console:ticket/<plugin>`, and are never posted back to integrations as actions.
  Verified against each vendor's documented API with a local mock server.
- Create & scale: pure guards, input parsing and plans in `src/lib/provision.ts`; `src/lib/server/provision.ts` runs
  parse → discovery → role → guard → plan → confirm → `mutate()` on canonical keys (ECS service; cluster hosts + EC2
  instance) → re-read and re-check under the lock → audit intent → AWS (RunTask/RunInstances client token
  `dc-<operationId>`). Host launches are reserved in `host_reservations` first and reconciled by the sampler
  (`reconcileHostReservations`, 15 min to join); the cap counts registered, joining and reserved hosts. Everything it creates is tagged
  `console:created=true`; delete/terminate refuse anything without that tag (and the IAM policy enforces it too).
- Costs: `Billing` (`src/lib/server/billing.ts`) is a third door beside `Cloud` and `Ci`, with its own globalThis
  singleton; `billing-aws.ts` always calls Cost Explorer in us-east-1 ($0.01 per request), so a 4-request snapshot is
  cached in memory and in `settings` (`costs:snapshot`) for `costs.cacheHours`. List-price estimates are pure
  (`src/lib/costs.ts`, analysis in `src/lib/spend.ts`) and priced in each resource's region from
  `src/lib/list-prices.ts`, which `scripts/list-prices.mjs` regenerates from the AWS Price List (a region missing from it
  falls back to us-east-1; `RunRateEnv.regions` says whose prices were used). The run rate prices discovery's ECS
  environments, then what the resource inventory places elsewhere (`leftovers()`: tag-only environments, EC2 instances
  outside a cluster, databases and caches in no environment), skipping anything already priced.
- Agents & API: every capability is an `Operation` (`src/lib/server/ops/types.ts`) in `ops/core.ts`, `ops/costs.ts` or
  `ops/provision.ts`; `ops/index.ts` validates input (`src/lib/ops-schema.ts`), checks the role, applies the token-mode
  gate (`gate()` in `src/lib/automation.ts`) and creates approvals (`ops/approvals.ts`, atomic transitions, sealed
  inputs). API tokens: `src/lib/server/auth/api-tokens.ts` (hash only; effective role = min(token, owner now)); the
  proxy accepts `Authorization: Bearer dc_…` only on the agent routes (`tokenRoute`). `/api/events` is SSE,
  `/api/mcp` a JSON-only MCP server over the same registry (`src/lib/mcp.ts`).
- Agent identity and policy (agent platform, wave C, C1): an agent acts as a server-built `AgentPrincipal`
  (`src/lib/agents/types.ts`; read back by `parsePrincipal` in `identity.ts`) for one person — never their session —
  with that person's *current* role (`delegatorOf` in `src/lib/server/agents/principals.ts`) and its run's stored policy
  (hash-checked). The policy engine `src/lib/agents/policy.ts` is pure: `evaluate()` decides hard denials (`HARD_DENY`:
  `variables.update`, admin perms, changes in the administrative areas
  `users|tokens|integrations|settings|approvals|agents|workflows|definitions|connections|runs|policies`, IAM and
  console-self targets) → tool lists (`deny` wins) → scope → security metadata (R01: a change on a `tagsUnread` target
  is always denied; other unread enrichment, `unreadMetadata`, only with `requireCompleteSecurityMetadata`) → mode
  (observe / propose / bounded-act; danger and protected always ask a person; autoscaled scale/start and rollbacks
  across migrations too) → limits; `narrow()`, `policyHash()`, `parsePolicy()` and `DEFAULT_POLICIES` for the six
  templates. `ops/index.ts` `invoke()` sends `via: "agent"` callers through `invokeAsAgent`: agents switch (503) → hard
  deny → validation (agents may not send `migrationAck`) → role → emergency stop for changes (423) → `targetsFor()`
  (resolved keys, self, autoscaler, migrations; `resolveTargets()` exported) → `evaluate()` with the run's counters →
  allow (run inside `runWithMutationContext` with run/step/grant and the step's idempotency key, and `withAgentContext`)
  / approve (`requestGrant`) / deny; with a `grantId` it re-plans and `verifyAndConsumeGrant`s first. Every agent call
  fires `onAgentInvoke` (listeners on `globalThis`). While an agent context is set, a non-agent caller gets 500 (the
  session bypass). Grants (`src/lib/server/agents/grants.ts`) bind run, principal, operation, targets, input hash and
  plan hash (`grantHashes`: human-only fields `confirm`/`migrationAck`/`reason` excluded), policy hash and expiry; a
  person's approval (`decide()` → `decideAgentRequest` → `decideGrant`) re-plans as the agent, records the decision and
  enqueues an `execute` step — it never runs as the approver. Every approval (API tokens too) stores `plan_hash`;
  approving re-plans as the requester and answers 409 `plan_changed` on any difference. Agent tokens (`da_`,
  `src/lib/server/auth/agent-tokens.ts`): run tokens end with their run, external ones (`/api/agents/tokens`) bind a
  stored definition or a template and own an `external` run; the proxy sets `x-console-auth-via: agent`,
  `x-console-agent-principal` (token id), `x-console-agent-run` and refuses them with 503 while agents are off;
  `agentCallerOf()` / `resolveCaller()` load the principal and policy. `resolveCaller()` re-reads the delegator, the run
  (live, same delegator — `policyForRun`) and its policy on every agent call, even for a caller the runner built
  earlier. Targets carry tags and the account (ECS: the service's tags and the cluster ARN's account; inventory: the
  resource's, its ARN's or its environment's); a `console:protected` tag makes an ECS service, host or database
  protected; an unreadable self/meta becomes `tagsUnread`; an unknown account or region under an account/region scope
  refuses a change. `decideGrant` withdraws a request whose run ended or whose policy changed; `decideAgentRequest` one
  whose delegator can no longer make the change. `verifyAndConsumeGrant` never touches another run's grant. The agent
  context (`withAgentContext`) closes when the wrapped call settles; long-lived work starts with
  `outsideAgentContext(fn)` (the worker arms its timers so), and `mutate()` refuses (500 `agent_bypass`) a change made
  inside an agent's call outside that agent's own mutation context.
- Durable runs (wave C, C2): `src/lib/server/agents/store.ts` (runs with state-machine-checked `updateRun` — the
  transitions are pure in `src/lib/agents/run-state.ts`; a run that ends revokes its run tokens and, when it succeeded
  or failed, queues an outbox row in the same transaction; steps; sealed, redacted model calls; `claimTriggerFire`),
  `worker.ts` (one loop per process on `globalThis.__consoleAgentWorker`; `claimStep` is one conditional UPDATE with a
  fence; the claim window holds only kinds with a handler in active runs, so nothing starves; `finishStep` is fenced;
  retries only retry-safe non-execute steps with backoff; an execute step's outcome is decided by its `operations` rows
  (`settleExecute` in run-state.ts) — running/unknown → `outcome_unknown` + run `waiting_external` + a verify step,
  never a retry; a kind without a handler stays queued; execute steps wait while the emergency stop is on; nothing is
  claimed while agents are off, but the outbox and reconciliation still run; a run that ends or is being cancelled
  aborts its interruptible steps' signal (`cancelInflight` at once on this instance); `registerTickTask` for the
  workflow scheduler; it loads `runner.ts` and `steps.ts`), `reconcile.ts` (lapsed leases: an execute step is settled
  through `operations` found by step id or idempotency-key prefix — none → requeue, running/unknown → `outcome_unknown`,
  run `waiting_external` and a verify step, in one transaction; a records-settled step always gets a verify step; a
  lapsed step that has been claimed `MAX_ATTEMPTS` (6) times fails instead of being requeued; deadlines; orphaned steps
  of ended runs), `stop.ts` (`agentsEnabled`, the emergency stop; 2 s cache on `globalThis`; a switch change commits its
  audit intent before the change, then the setting, its `action` event and the `ok` result together, or an `error`
  result), `events.ts` (persisted events with a `seq` cursor, 7-day retention; `event-bridge.ts` feeds sampler
  transitions, actions and operations) and `outbox.ts` (agent notifications to integrations, retried per integration,
  rebuilt from current records). `/api/events` replays by `Last-Event-ID`/`?after=` (500 events, 1 h) then streams from
  the DB in seq order, looking again for skipped seqs for 15 s (`SeqCursor`: Postgres commits out of seq order); a
  cursor beyond the newest event resets (`reset: true`); audiences are pure in `src/lib/agents/events-cursor.ts`.
  Routes: `/api/agents/{settings,emergency-stop,tokens}`; `GET /api/agents/settings` also reports `workerStatus()`
  (`worker.started` proves instrumentation ran both reconciliations and started the loop; smoke checks it).
- Model connections (agent platform, wave C): `src/lib/server/agents/credentials.ts` is the credential broker.
  Connections live in `agent_connections`, sealed by `secrets.ts` (`key_version` is an id derived from the sealing key,
  so an old key gives 409 `credential_key_changed`, not a decryption error). Rules are pure in
  `src/lib/agents/connection-rules.ts` (`decideUse`, endpoints, secrets, payer, `ConnectionView`); routes and the
  service are `src/app/api/agents/{connections,models}/` over `src/lib/server/agents/connections.ts`.
  `resolveConnection(id, purpose)` checks revocation, `needs_auth`, the person (re-read, not disabled), owner (personal:
  owner only, never shared, not even with an admin) or `minRole` (org), the org policy (settings
  `agents:connection-policy`), the admin endpoint registry (settings `agents:endpoints`), the run's own `connection_id`
  (no fallback, delegator must match) and background use; it audits `credential.use` (a failed audit write refuses) and
  returns the inference `ResolvedConnection` plus `fetch(path)` (egress-pinned, `src/lib/server/agents/egress.ts`) and
  `scrub()`. `secret()`, `fetch()` and `tokens.read()` re-run every `decideUse` check per request, so a demotion,
  cancel, unregistered endpoint or tightened policy stops a held connection mid-run (`CredentialError` → the run
  pauses `paused_auth`). Registered endpoints are organisation-only unless an admin marks them `personal: true`; the
  egress class is the stricter of the stored class and the registry's current one. A revoke pauses the connection's
  runs (`paused_auth`), then signs out at the provider where a revoker is registered (`registerRemoteRevoke`;
  `revoke_confirmed` is 1 only on the provider's confirmation, always 0 for API keys). With the simulated account a
  built-in, never-stored `scripted:demo` connection exists (aws mode: 404). Redaction, minimisation and the untrusted
  wrapper (`prepareEvidence`) are `src/lib/agents/redact.ts`. Broker listeners (`onConnectionChange`), remote revokers
  and the use-audit de-duplication live on `globalThis`.
- Model inference: `src/lib/agents/inference/` is pure (the §3.4 interface in `types.ts`, wire formats per provider,
  the versioned capability map `capabilities.ts`, SSE parsing, `recoveryFor`, the scripted model and its
  `incident-demo` script); `src/lib/server/agents/inference/registry.ts` has `adapterFor`, `generateWith` and
  `inferenceRecovery` over the Anthropic, OpenAI Responses, OpenAI-compatible/Ollama, Bedrock and scripted adapters,
  plus the ChatGPT-plan adapter only with `CONSOLE_CHATGPT_PLAN=eligible`. Endpoints come only from the connection
  (built-in default or admin-registered), redirects are refused, local connections are pinned to loopback/private
  addresses, and Ollama cloud models are refused on local connections before anything is sent. Bedrock uses the
  connection's own keys (or a role assumed with them), never the console role. No fallback: an unknown provider is
  refused, never mapped to a similar one; auth failures pause `paused_auth`, quota `paused_budget` (a reset time only
  when the provider gave one), rate limits/outages/broken streams retry the same request a bounded number of times.
  Newer Claude models (4.7+) refuse `temperature` and a thinking budget, and the 5.5 family refuses a forced tool
  choice: `checkRequest` drops the temperature and refuses a forced tool choice before any network call, and the
  builders send adaptive thinking where the capability map says so. Bedrock `in.`/`global.` (and other geography)
  inference profiles can process requests outside the connection's region and are flagged cross-region.
- Agent runner (wave C, C6): `src/lib/server/agents/runner.ts` (`startRun`, the model/tool/propose/execute/verify
  handlers, `settleRun`, `cancelRun`, `runMetrics`, run views) over `tools.ts` (tool specs from the registry only,
  per-run `tools_hash`, `checkRunTools` — also on a run token's MCP `tools/list` — and evidence) and `context.ts`
  (each turn rebuilt from durable steps; assistant messages sealed with provider natives unchanged). Pure:
  `src/lib/agents/{evidence,budget,prompts}.ts`. A run's scope is the template's policy narrowed to the resource's
  cloud-map neighbourhood. Child runs reserve budget from the parent (`agent_runs.reserved`): a parent and its children
  together stay within the parent's budget (the parent's own turns and calls exclude what its children reserve). A
  model turn's calls are validated first and run all or none (reads → tool steps, changes → propose steps); call
  arguments are stored redacted. Calls without a step (a run token's CLI, an external `da_` client) are recorded
  through `onAgentInvoke`. Outcomes keep AI completed / AWS accepted / verified healthy apart; a change refused before
  AWS fails the run, and unhealthy fails it too (the escalation). Executing a person-approved change (a grant) and the
  run's `execute`/`verify` steps don't count run time or model turns (`countersFor` in `ops/index.ts`): an approval
  stays open longer than `runtimeSeconds`.
- Workflows (agent platform, wave C, C7): pure rules in `src/lib/agents/workflows.ts` (typed steps with `when`
  gates and `forEach: "targets"`, a safe expression language — no eval, own properties only — `{{path}}`
  templates, `validateWorkflow`, `workflowHash`, `buildPreview`/`previewHash`, `selectTargets`), `cron.ts` (5-field
  cron in an IANA zone: a time DST skips fires at the jump, a repeated one once) and `templates.ts` (six templates,
  `buildReport`). `src/lib/server/agents/workflows.ts` stores versions (a draft is edited in place; publish needs
  the preview's hash, freezes the resolved targets into the version and its bounded-act `scope.keys`, makes the
  publisher the delegator of scheduled and event runs and replaces the previous version's schedules; disable turns
  every version off) and starts runs (concurrency, cooldown and attempts per resource checked in the creating
  transaction). `steps.ts` runs a workflow one step at a time (each step appends the next in `next`; the last ends
  the run): reads are `tool` steps, changes `execute` steps through `invoke()` as the run's agent principal, a
  `model` step is a child run of the runner; reviews and approval steps wait with the run `waiting_external` until
  `result.review.expiresAt` and are answered by `PATCH /api/agents/workflows/[id] { action: "review" }` (the run view
  shows the prompt). `scheduler.ts` rides the worker loop: one run per schedule slot
  (`wf:<id>:<version>:<fireTimeIso>` in `trigger_fires`, claimed with the run; slots missed by 15 min are skipped),
  state events from `onTransition` and alarm changes from the cloud map, deduped per resource, state and 5-minute
  bucket. Definitions: `definitions.ts` (immutable versions, `config_hash`). Operations (`runs.*`, `workflows.list`,
  `variables.compare`, `operations.get/list`): `src/lib/server/ops/agents.ts`, registered in `ops/index.ts`.
- Automation UI: `src/app/automation/` (hash-routed tabs; `#runs/<id>`, `#workflows/<id>`) over shared, reusable
  components in `src/components/agents/` (`RunView`, `PlanCard`, `EvidenceList`, `BudgetMeter`, `ConnectionForm`,
  `OutcomeBadges`, used by the assistant too). All wording and UI logic is pure in `src/components/agents/rules.ts`
  (tested in `rules.test.ts`); "AI completed", "AWS accepted" and "verified healthy" are always separate badges.
- Embedded assistant (wave C, C9): `src/components/assistant/` (drawer, composer, connection picker, `ask()` store
  with the thread in sessionStorage — secret-looking text is never sent or kept, and `POST /api/assistant` refuses it
  too with `secret_in_question` — inline approve/reject from the approval's `canDecide`, `RunBoundary`) embeds the
  Automation UI's `<RunView compact>`. The shell's Ask button and `g i` open it; the ECS and map resource panels add
  "Explain this" / "Why is this unhealthy?" (scoped by `resourceKey`); `/assistant` lists my runs (`?kind=assistant`).
  The emergency-stop banner shows read-only for everyone outside /automation.
- Local runtimes and the ChatGPT plan: `src/lib/server/agents/runtime/` (`runtimeFor`, `runtimeForProvider`,
  `consoleMcpUrl`) runs the person's own `claude` (≥ 2.1.263, `CONSOLE_CLAUDE_BIN`) or `gemini` (≥ 0.11.0,
  `CONSOLE_GEMINI_BIN`) CLI as an MCP client of the console, with the exact restricted argv in
  `src/lib/agents/runtime/claude-args.ts` (never `--bare` or a permission bypass), a 0700 temp dir, a minimal env and a
  run-scoped `da_` token; any tool outside `mcp__deployment-console__*` (plus the three MCP-resource helpers) stops the
  run. Pure flags and stream parsing are in `src/lib/agents/runtime/`; process groups, slots
  (`CONSOLE_RUNTIME_CONCURRENCY`, default 1) and the availability cache live on `globalThis.__consoleRuntimes`. The
  ChatGPT plan is `src/lib/server/agents/chatgpt-plan.ts` over `src/lib/agents/chatgpt/` (PKCE sign-in on 127.0.0.1
  only, tokens sealed by the broker, refresh locks on `globalThis.__consoleChatgptPlan`); everything 404s/refuses
  unless `CONSOLE_CHATGPT_PLAN=eligible`. The inference registry imports it either way, which registers its revoker;
  the broker also loads it on demand when revoking a plan connection.
- Workspace: dashboards, pins, saved views/log queries and prefs (home page) — pure rules `src/lib/dashboards.ts`,
  stores `src/lib/server/dashboards.ts` / `workspace.ts` (migration-6 tables; optimistic `version`, 409 on stale; only
  sharing is audited, in the same transaction), UI `src/components/dashboards/`, pages `/dashboards`, `/dashboards/[id]`,
  `/incident`. `/` follows the `home` pref, but `?r=`, `?env=` and `?view=overview` always show the Overview (the
  sidebar's Overview links there). Widget SWR keys are namespaced `["dash", url]` so they never share a cache entry with
  components that read the same URL into another shape (the palette's `/api/dashboards`, the stars' `/api/pins`). The
  exceptions are `/api/envs` and `/api/issues`, which the shell polls on every page: `useApi` reads the shell's entry
  (`SHELL_POLLED` in `src/lib/client/env.tsx`: same key and fetcher, no polling or first fetch of its own; `loadedAt` /
  `failedAt` give its times) — namespaced, each went out twice in the same second on dashboards and the Incident view.
  Such a passive reader keeps focus revalidation on: SWR hands focus and reconnect to a key's first-subscribed hook
  only, and a page's hooks subscribe before the shell's.
- Cloud map: every AWS service (and Cloudflare, and declared workloads) is a **provider** in
  `src/lib/server/providers/*.ts` (contract in `providers/types.ts`, groups `ecs.ts`, `compute.ts`, `serverless.ts`,
  `edge.ts`, simulated data under `providers/mock/`, names in `mock-names.ts`). `src/lib/server/inventory.ts` plans
  provider × region runs (pure rules in `src/lib/inventory/schedule.ts`: scopes, two phases — home + global first, other
  regions merged within 120 s — deadlines with checkpoints, completeness), persists each run (`inventory-store.ts`,
  encoding in `src/lib/inventory/snapshot.ts`, mentions sealed) and after a restart serves the persisted map, labelled
  stale, read from the same AWS account only. It runs them,
  `src/lib/inventory/{infer,assign,idle,propagate}.ts` merge, link, place, apply the cross-resource health rules
  (R1–R9; R10 hides an untouched default VPC with its subnets, internet gateway and default security group — nothing
  else in it, no network interface on that group) and mark idle (pure, tested), the UI is `/map` (`src/components/map/*`, layout in
  `src/lib/inventory/layout.ts`); `/resources` is the All-resources table (`components/map/table.tsx`, rules in
  `table-rules.ts`). Pan and zoom live outside React in `components/map/viewport.ts` (frames move the plane through
  refs; React renders when a gesture ends); filters, pass-through edges and the URL are pure in
  `components/map/filter.ts`. Every provider action runs through `src/lib/server/inventory-actions.ts` (validate → role
  × protection → self/when → capability → plan → typed confirmation → `mutate()` with the resource's canonical keys →
  live tag read (`authoritative()`, else a forced re-discovery; refused when unread) → protection/self re-decided →
  intent → run; rules pure in `src/lib/inventory/action-rules.ts`). A plan may carry `echo` — fields the confirmation
  sends back in `input` (ecs-image's `expectedRevision`); a schema field marked `"x-echo": true` is filled from it, never
  typed (`title`, `x-group` / `x-groups` are form hints, in `JsonSchema`). Per-run reconciliation (resources pending
  deletion confirmation), slim rows, the ETag and coverage freshness are pure in `src/lib/inventory/vanish.ts`; idle
  evidence (R20) and the hourly activity budget (`CONSOLE_ACTIVITY_BUDGET`) in `src/lib/inventory/idle.ts`. Provider groups run in this order: `ecs`, `compute`, `serverless`, `edge`, `network`, `security`,
  `observability`, `delivery`, `databases`, `platforms`, `ml`, then `catchall.ts` last. A provider declares `kinds`,
  `scope` (`regional` | `global` + `homeRegion` | `home`) and `covers` — Resource Explorer types, checked against
  `src/lib/inventory/aws-resource-types.json`. Keys of the coverage kinds are ARNs from `arnOf`
  (`src/lib/inventory/arn.ts`; the global builders take the home partition); the console keys (`ecs:service/…`, `elb:`,
  `rds:`, `elasticache:`, `ec2:`) get `@<region>` outside the home region (the bare EC2 key and the ARN are aliases; EKS
  workload keys get `@<region>` too). Environment ids renamed for a region (`production-eu-west-1`) also catch that
  region's resources whose tags or names say `production` (`regionalEnv` in `assign.ts`). Security-group "allowed"
  edges into data stores are port-aware (`ruleReaches` in `discover.ts`; `listenPorts` in `infer.ts`). ECS services
  alias their task-definition family ARN, which EventBridge Scheduler and Pipes targets name. A catch-all row of a type
  its provider covers that matched nothing is a stale Resource Explorer entry when other rows of that type and region
  did match (left out with a note); when none matched it stays hidden and flagged as a key-format bug (`foldGenerics`
  in `infer.ts`). Systems Manager managed-instance rows fold into their EC2 instance (their ARN becomes one of its
  aliases). Rule 4 of `assign.ts` (stage words in an id) never reads a `default…` name: AWS gives those to what it creates
  in every region (`default.memorydb-redis7.search.preview` made a "sandbox" environment). Several listener rules into
  one target group share one label, the first rule's hosts plus `+N` (`lbLinks`). Generic resources take labels, categories
  and map visibility from `src/lib/inventory/aws-services.ts` (UI code uses `categoryOf` / `kindLabelOf` / `serviceOf`
  and `iconOf` / `shortOf`, never `KIND_INFO[r.kind]` for a resource). Mock names for every provider live in
  `mock-names.ts` (frozen). Registered-but-unbuilt providers answer `NOT_IMPLEMENTED` (`src/lib/permissions.ts`) and
  show as "coming soon", outside the counts. IAM statements for providers are generated (`npm run iam:policy`; also
  `-- --print … --regions --set --principal`); the test fails when a provider calls an undeclared AWS action or the
  policy files are stale. `infra/iam-policy.json` also denies the console's own SSM parameters, secrets and env file
  (placeholders `CONSOLE_PARAM_PREFIX`, `CONSOLE_SECRET_PREFIX`, `CONSOLE_ENV_FILE`; F34). `forRegions()` widens
  `REGION` to `*` for a multi-region console (the CLI and Settings → AWS permissions), and `withPrincipal()` names the
  role `SimulateOwnPermissions` may simulate (`--principal`; the Policy builder's ROLE field).
  `src/lib/inventory/covers.test.ts` checks provider covers against the snapshot. `npm run parity`
  (`scripts/parity.mjs`) compares a running console's inventory with Resource Explorer and an expectations file
  (read-only AWS CLI calls); where the two disagree, either way, the service's own list call settles it.
- Docs: `docs/*.md`, rendered in-app at `/docs`.

**Boundaries:** reads every service a provider declares (`read` lists; the read-only policy grants exactly those),
plus Cost Explorer and GitHub. Writes: the actions providers declare (`write` lists — Lambda, SQS, SNS, EventBridge,
Step Functions, S3 objects, CloudFront invalidations, EC2 power, Auto Scaling, EKS, App Runner, Beanstalk, ECS
image deploys), `ecs:UpdateService` / `RegisterTaskDefinition` (actions, variable edits), SSM / Secrets Manager / S3
env-file values (only through the audited Variables editor), `ecs:CreateService` / `RunTask` and `ec2:RunInstances`
(tagged `console:created=true`), `ecs:DeleteService` / `ec2:TerminateInstances` only on resources carrying that
tag, GitHub re-runs, Cloudflare cache purges and its own DB. Never touches application databases; never acts on its
own service or host (IAM denies by ARN and by tag `console:self=true`). Variable values reach a browser only through
an audited reveal and never reach an API token; S3 file actions refuse env files. Outbound HTTP only to AWS, GitHub,
`api.cloudflare.com` (when a token is set), EKS cluster endpoints (their own CA), configured health-check URLs, the
OIDC provider and configured integrations. `src/lib/iam-policy.test.ts` keeps `infra/iam-policy*.json`,
`docs/connect-aws.md` and `docs/services.md` equal to the AWS SDK commands the server imports and the providers'
declarations; `src/lib/ops-docs.test.ts` keeps `docs/operations.md` equal to the declared operations.

**Commands:** `npm run dev` (port 3200, demo), `npm test`, `npm run test:pg` (DB and coordinator suites on a throwaway
Postgres 16: Docker with a local `postgres:16` image, never pulled; or an existing server via `PG_TEST_URL`),
`npm run typecheck` (runs `next typegen` first), `npm run lint`, `npm run build`, `npm run smoke` (needs the dev server;
feature suites in `scripts/smoke.d/`: `agent-runs.mjs` drives a scripted:demo assistant run end to end — evidence,
proposal → approval, nothing runs before the grant, the emergency stop holds it, then executed as the agent and
verified — and takes about a minute), `npm run iam:policy` (`-- --check` in CI), `npm run parity`. Agent platform status
(wave C): implemented and smoke-tested on the simulated account; agents are off by default with a real account and no
real-account agent run has been made.

**Gotchas:**
- Next bundles `instrumentation.ts` (the sampler) and the routes separately. Anything they share — the TTL cache,
  history, the sampler's latest overviews and listeners — must live on `globalThis`, or routes see empty state. The
  flip side: in `next dev`, the sampler keeps the module versions it started with, so after editing `mock.ts` restart
  the dev server before trusting `/api/envs`, the issues list or `npm run smoke` (Re-scan now only refreshes discovery
  until the stale sampler's next pass writes the shared cache again).
- A connection string outranks a security-group rule for the same pair; host-network services share the host's SGs,
  so SG-only edges from them are dropped for display but still used for attribution.
- Route `RouteContext` types are generated: `npm run typecheck` runs `next typegen` before `tsc`.
- Lib files use relative `.ts` imports so `node --test` can run them; files importing `server-only` can't be tested
  that way, so keep logic pure and put it in a module without that import.
- The log viewer's `LogStore` is intentionally mutable; merged log paging is time-based and gap-free; `append` merges
  overlapping batches. Don't return to per-stream backward tokens.
- Grid items holding a ResizeObserver chart need `min-w-0`.
- A new capability should also be an operation (`src/lib/server/ops/*.ts`) with a row in `docs/operations.md`
  (the docs test fails otherwise). Keep outputs compact JSON for a model, never UI view models, and never add an
  operation that returns secret values.
- Security invariants (each has a test or smoke check — keep them): the console never reveals, edits, copies, runs or
  acts on its own service (`meta.self`, which fails closed when ECS metadata is unreachable, plus IAM denies); every
  write writes an audit intent first and refuses when it can't; API tokens never see secret values and *danger*
  operations always need a person; validators use own-property checks; env-file values can't contain line breaks;
  outbound calls to configured URLs go through `safeFetch`, never reach link-local addresses and never re-resolve the
  host after the check; SSO accounts are bound to their first `sub`, and `email_verified` is required by default.
  `CONSOLE_TRUSTED_PROXIES` decides which X-Forwarded-For entry is the client.
- `onTransition` / `onAction` listeners run inside the sampler and inside the coordinator's `onMutation` (one bridge per
  process on `globalThis.__consoleShared`; integration and ticket mutations are skipped): they must never throw, and
  they return an unsubscribe function (the SSE stream relies on it). Approval events, the token cache and usage
  counters live on `globalThis` for the same bundling reason as the sampler.
- Uptime history is persisted (`state_changes` transitions + `settings` `observed:<env>` spans) and restored per env
  before the first record. The sampler re-arms with `setTimeout`, samples 4 envs at a time and verifies ECS operations,
  filtered in SQL (`VERIFIED_ACTION_SQL`) so other operations can't crowd them out. Probe flap-guard counts live on
  `globalThis.__consoleProbeFailures` (`{ n, at }`, reset after 60 s).
- Never call `mutate()` inside `db.tx()` (refused), and never await another request's DB work inside a `tx()` callback
  (SQLite would wait for your own transaction). Coordinator state (key mutexes, draining flag, boot id, process
  heartbeats, the mutation-context AsyncLocalStorage, listeners) lives on `globalThis.__consoleMutations`.
- Reconciliation (at boot and every minute) only gives up on a console whose `process:<boot id>` liveness row in
  `mutation_locks` has lapsed (90 s), so the two tasks of a rolling upgrade don't cancel each other's changes. After a
  crash, its in-flight changes show as *outcome unknown* within about 2½ minutes; a graceful stop releases the row so
  the next console reconciles at once.
- The TTL cache (`src/lib/server/cache.ts`) is bounded: entries are swept once older than max(2 × (ttl + staleMs),
  10 min), at most 5,000 TTL entries and 5,000 `memo()` entries. `cached(key, ttl, fn, { staleMs })` serves stale data
  only inside ttl + staleMs, with the original `at`; callers whose `at` feeds `deriveState` keep ttl + staleMs ≤ 20 s.
  Joiners get their own fetch's `{ value, at }`, so `invalidate()` during a fetch is safe. Freshness of every view is
  modelled in `src/lib/freshness.ts` (stale or unknown age → show unknown); `<FreshnessBanner>` / `<StaleBadge>`
  render it.
- What the console's AWS identity may change: `src/lib/server/capability.ts` (store on `globalThis.__consoleCapability`,
  `GET /api/capability`), fed by a policy simulation and by real calls: the SDK wrapper reports every call through
  `observeCalls`, and only the actions console writes and reveals need are remembered (`noteDenied` / `noteAllowed`).
  The observer is registered when `capability.ts` loads, so `instrumentation.ts` imports it at boot. `errText` hides
  session and user ARNs, the caller named in a refusal and the caller's own role, but keeps other role ARNs (the role a
  PassRole needs is what the person has to fix). Provider write actions are registered with `watchActions()`
  (inventory-actions, the capability and permissions routes) and simulated too; an empty simulation means not verified,
  and a role under an IAM path (NoSuchEntity: its session ARN doesn't show the path) is explained as such. Against `*`
  an action allowed only on resource ARNs is an implicit deny too, so actions with a resource type are simulated against
  real ones (`simulationTargets`, `simulationTargetsNow`): ECS service actions against one service per cluster,
  `ecs:RunTask` / `RegisterTaskDefinition` against its task definition, and `RESOURCE_TYPED_ACTIONS` (EC2 power, RDS
  power, Auto Scaling, Beanstalk, App Runner, CloudFront, Step Functions, EventBridge, Lambda, SQS, SNS) against the
  first resource of their ARN type per environment and region of the cloud-map inventory's last build
  (`cachedInventory()`, handed in by `capability.ts`, which simulates again once the first build exists; never
  `console:self` / `CONSOLE_SELF_INSTANCE`, unread tags or other accounts; a type in more than 5 places stays on `*`).
  Denied on every sample with no missing context values is `resourceDeny` (denied) only for services without resource
  policies (`denialIsFinal`: Lambda, SQS, SNS, EventBridge stay implicit); a mix stays implicit (`combineTargets`).
  Launches (`RunInstances`, `CreateTags`), `iam:PassRole`, S3 objects, API Gateway and EKS nodegroups stay on `*`.
- `iam-policy.test.ts` skips `src/lib/server/agents/inference/` and `runtime/` (connection credentials, not the console
  role) and fails if `@aws-sdk/client-bedrock-runtime` is imported anywhere else.
- Agents: never call `op.run()` or a Cloud method directly from agent code — go through `invoke()` with
  `agentCaller(principal, { stepId, grantId })` (principals.ts) inside `withAgentContext`. A `currentAgentContext()` set
  while a person's caller reaches `invoke()` is a 500 by design. Plans of change operations must not contain values that
  drift on their own (running counts, timestamps): an approval binds the plan's hash, so such a plan would invalidate
  every request (the restart plan names the desired count for this reason). `onAgentInvoke` also fires for calls refused
  before the identity checked out (ended run, borrowed principal) when the runner handed in a principal, and for MCP
  calls of tools the policy hides: subscribers must skip runs that already ended. Timers and loops armed inside
  `withAgentContext` inherit it while the call runs: arm long-lived ones with `outsideAgentContext`.
  Workflow steps carry `input.wf`; `steps.ts` wraps the runner's `tool`/`execute`/`verify`/`model` handlers (found with
  `stepHandlerOf`) and sends every step without `wf` to them — never put a `wf` key in a runner step's input.
  `redactDeep` removes long values under fields named …Key/…Token: never store resource keys a later step reads through
  it (`steps.ts` keeps facts and targets out of it).
- A local `next build` traces files the server opens: the data-dir paths in `db.ts` / `secrets.ts` carry
  `/*turbopackIgnore: true*/` so data/ (the console DB and `secret.key`) never lands in `.next/standalone`. Keep the
  comments on any new path under `dataDir()`.
- The worker runs in the instrumentation bundle and imports `src/lib/server/agents/runner.ts` / `steps.ts` statically
  (a bundler can't import a missing file): keep both files, even as placeholders. Persisted events are published
  inside the caller's transaction when it has one (`publish(…, { db })`, in a savepoint where it could fail).
- The real-CLI runtime test is opt-in (`CONSOLE_RUNTIME_SMOKE=1 CONSOLE_CLAUDE_BIN=… node --test
  src/lib/server/agents/runtime/claude-smoke.test.ts`) because it uses the machine's Claude Code login.
- Providers drop secret-bearing fields in their own field pickers, before the mapper, mentions or checkpoint see them
  (Amplify `basicAuthCredentials`/`buildSpec`, Lightsail `pendingModifiedValues` and container commands, AppSync HTTP
  auth config, Transfer banners); AppSync never calls `ListApiKeys`. Keep new providers to the same rule.
- Multi-region: cache keys holding a cluster, family or repository name go through `inRegion(name, region)`
  (`discovery.ts`; the plain name in the home region, `name@region` elsewhere). The home region is `homeRegion()`
  (`sources.ts`; us-east-1 for the simulated account whatever `AWS_REGION` says), never `config.ts` `REGION`. The home
  Cloud keeps the `globalThis.__consoleCloud` slot, other regions are in `__consoleClouds`.
- Don't add imports to `src/lib/server/sources.ts` lightly: importing `../regions.ts` plus `./errors.ts` there broke
  turbopack hot reload of `discovery.ts`'s dependents ("inRegion is not a function"); `getCloud` repeats
  `REGION_CODE` locally for that reason. The same goes for `aws-limiter.ts` and `cache.ts`: all three read the AWS
  connection's generation from `globalThis.__consoleConnection` inline rather than importing `connection-state.ts`.
- A new module that keeps AWS-derived state must reset on a connection switch. Keep it on globalThis and add its key to
  `DROPPED` in `connection-state.ts`, or register an `onConnectionChange` hook. A new SDK client goes through
  `perRegion`, `perGeneration` or a Cloud (with `connectionCredentials` in its config), or it keeps signing in as the
  previous connection.
- Per-item enrichment in providers goes through `enrich()` (`providers/serverless-util.ts`): the time budget is checked
  when an item starts, and the list so far is kept. `ctx.limit` is a deadline guard, not a slot (the SDK-call limiter
  owns the slots): never hold anything around a provider.
- A shared fetch started inside `withCallSignal` would inherit that caller's deadline and fail every joiner with it.
  `cached()` runs its fetches outside any call signal, and the inventory's rebuild and restore use
  `outsideCallSignal()`; start any other shared or background work the same way.
- Browser checks of animations: some embedded browser panes freeze `requestAnimationFrame` while hidden — use headless
  Chrome over CDP.
- `<Sheet modal={false}>` / `<Overlay modal={false}>` keep the page live (no inert, no Tab trap); Escape closes only the
  top modal layer, and handlers that act on Escape call `preventDefault` so one press closes one thing.
- The map's inventory fetcher (`components/map/data.ts` `fetchInventory`) reuses the previous build's resources/edges
  arrays when `signature.ts` says nothing shown changed (F51), so memos keyed on `view.resources` stay stable across
  polls while `generatedAt`, providers and completeness come from the newest build. Anything else reading
  `INVENTORY_KEY` through SWR (the command palette) uses the same fetcher.
- The region filter lives in the URL and localStorage; every `useRegionFilter()` instance follows a change made
  anywhere (`setRegion` dispatches `REGION_EVENT` = `console:region`; each instance re-reads on it and on `popstate`).
