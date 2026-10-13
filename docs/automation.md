# Agents & API

Everything you can do in the console, an agent can do too: a chat assistant, a CI job, a script, or any
[MCP](https://modelcontextprotocol.io) client such as Claude Code. The console doesn't ship an agent; it ships what one
needs: a typed **operations API**, **API tokens** with modes, **approvals** so a person stays in charge of changes, a
**live event stream** and an **MCP endpoint**. A small [example agent](#example-agent) shows them working together.

This page is for developers connecting an agent or a script. The quick start takes about ten minutes, and works
against the demo too.

## Concepts

| | |
|---|---|
| **Operation** | One capability with a stable name (`services.restart`), a JSON Schema for its input, a risk level (*read*, *change*, *danger*) and the permission it needs. Operations call the same code as the UI's buttons, so every guard, lock, confirmation and audit row applies. List: [Operations reference](operations.md). |
| **API token** | `dc_…`, created by a person under **Automation → API tokens**. It acts as that person, with at most the role you pick for it (never above your own), in one **mode**. |
| **Mode** | What a token may do with changes: *read* (none), *propose* (every change becomes an approval request) or *act* (routine changes run; protected environments and dangerous operations still need approval). |
| **Approval** | A change an agent asked for, waiting for a person under **Automation → Approvals**. Approving runs it as the approver. |
| **Event stream** | `GET /api/events`: state changes, action results and approval updates as Server-Sent Events. |
| **MCP endpoint** | `POST /api/mcp`: the same operations as MCP tools, for any MCP client. |

## Quick start

### 1. Create a token

In the console, open **Automation → API tokens → New token** and fill in:

| Field | Choose |
|---|---|
| **Name** | something you'll recognise in the audit log, such as `release-bot` (letters, digits, spaces and `. _ : @ / -`, up to 60 characters) |
| **Role** | the highest role the token may use; never more than yours |
| **Mode** | **Propose** (the default) for a first try: every change waits for your approval. **Read only** if the agent should only look. |
| **Expires** | 7, 30 (the default) or 90 days, or never |

Copy the token: it is shown once. The console stores only a hash of it.

### 2. Call the API

```bash
export CONSOLE_URL=http://localhost:3200 CONSOLE_TOKEN=dc_…   # your console's URL and the token

# Who am I, and what may this token call?
curl -sS "$CONSOLE_URL/api/ops" -H "Authorization: Bearer $CONSOLE_TOKEN"

# Is everything OK in staging?
curl -sS -X POST "$CONSOLE_URL/api/ops/envs.status" -H "Authorization: Bearer $CONSOLE_TOKEN" \
  -H "Content-Type: application/json" -d '{"input":{"env":"staging"}}'

# What would a restart do? A dry run returns the plan and changes nothing.
curl -sS -X POST "$CONSOLE_URL/api/ops/services.restart" -H "Authorization: Bearer $CONSOLE_TOKEN" \
  -H "Content-Type: application/json" -d '{"input":{"env":"staging","service":"api","confirm":"yes"},"dryRun":true}'
```

The dry run answers with the plan:

```json
{"plan":{"summary":"Restart api in Staging","changes":["new deployment of revision 123 (1/1 tasks, rolling)"],"warnings":[],"confirm":"yes"}}
```

### 3. Ask for a change and approve it

Send the same request without `"dryRun": true`. With a *propose* token the console answers `202` with an approval
request instead of restarting:

```json
{"approval":{"id":"3a799f6a-…","op":"services.restart","status":"pending","plan":{"summary":"Restart api in Staging",…},…}}
```

Open **Automation → Approvals** in the console, check the plan and choose **Approve** (or **Reject**, with a reason
the agent can read). Then follow up:

```bash
curl -sS "$CONSOLE_URL/api/approvals/3a799f6a-…" -H "Authorization: Bearer $CONSOLE_TOKEN"
```

The status is now `done`, with the result, and the audit log shows `<you> approving token "<name>"`.

### 4. Use it from Claude Code

```bash
claude mcp add --transport http deployment-console "$CONSOLE_URL/api/mcp" \
  --header "Authorization: Bearer $CONSOLE_TOKEN"
```

Then ask Claude Code something like "is staging healthy?" or "restart the worker in staging". Changes come back as
approval requests for you to decide in the console. More clients in [MCP](#mcp).

### 5. Try the example agent

```bash
CONSOLE_URL=http://localhost:3200 CONSOLE_TOKEN=dc_… ANTHROPIC_API_KEY=… node examples/agent/agent.mjs
```

See [Example agent](#example-agent).

## Operations API

| Request | Answer |
|---|---|
| `GET /api/ops` | `{ caller, operations: [{ name, tool, area, title, description, risk, perm, role, roleProtected, input, allowed, approval }] }` — `allowed` and `approval` (`never` · `protected` · `always`) are for this caller |
| `GET /api/ops?format=anthropic` (or `openai`, `mcp`) | `{ tools: [...] }` — ready-to-use tool definitions for the operations this caller may call |
| `POST /api/ops/<name>` with `{ "input": { … } }` | `200 { result }` |
| … with `"dryRun": true` | `200 { plan }` — `{ summary, changes, warnings, estimate?, confirm }`, names and counts only. The token's mode applies here too: a *read* token gets `403` for a change operation |
| … when the change needs a person | `202 { approval }` — see [Approvals](#approvals) |

`<name>` may be the operation name (`services.restart`) or its tool name (`services_restart`).

Errors come as `{ error }`, plus `problems` for invalid input:

| Status | Means |
|---|---|
| `400` | invalid input (`{ error, problems: ["env: required", …] }`), a confirmation that doesn't match, a missing reason or migration acknowledgement |
| `401` | missing, unknown, expired or revoked token, or its owner is disabled |
| `403` | the token's role or mode doesn't allow it (a *read* token's dry run of a change included), or a guard forbids it (the console's own service, power on a protected environment, create & scale turned off) |
| `404` | unknown operation, environment or service, or an API path that doesn't exist (always JSON) |
| `409` | a guard refused it for now: rollout in progress, already stopped, another change in flight… |
| `413` | request body larger than 256 KiB |
| `429` | a rate limit; see `Retry-After` |
| `502` | AWS or GitHub failed |
| `503` | the console's database is unavailable |

People signed in to the console can call the same API with their session (`POST` requests also need the header
`x-console-csrf: 1` and the console's own `Origin` — exactly `CONSOLE_PUBLIC_URL` when it is set), with the same role
checks. For them changes run directly — they already confirm in the UI — but the `confirm` and `reason` inputs still
apply.

**Confirmations.** Change operations take `confirm` and, where it matters, `reason`, exactly like the UI's dialogs:
`"yes"` on non-protected environments; on protected ones the text a person would type (the service name to restart,
`<env>/<service>` to stop, the target commit's short sha to switch) plus a reason of at least 3 characters. A dry run's
plan says which (`confirm`). For agents this rarely matters: changes on protected environments always go to a person,
who types the confirmation when approving.

## Tokens and modes

| Mode | Reads | Change, non-protected env | Change, protected env | Danger (delete, terminate, copy a service, add hosts, a one-off task with a command, deploy code or an image, send or publish a test message…) |
|---|---|---|---|---|
| **read** | run | refused (dry runs too) | refused (dry runs too) | refused (dry runs too) |
| **propose** (default) | run | approval | approval | approval |
| **act** | run | runs | approval | approval |

The risk of each operation is in the [Operations reference](operations.md). Note that *change* includes scaling
services and running one-off tasks without a command override: an *act* token runs those on non-protected
environments without asking. Copying a service and adding hosts start new resources you pay for, so they are *danger*
and always wait for a person. Use *propose* if you want a person to see every change.

A *read* token gets no plans of changes either: a plan can say more about the current state than a read-only caller
should see, so the mode is checked before a dry run too.

On the cloud map (`cloud.action`), the action's own risk counts. Deploying new Lambda code or a new ECS image, sending
a test message to an SQS queue and publishing a test message to an SNS topic are *danger* — new code runs with the
resource's role and secrets, and a message reaches real consumers — so they always wait for a person. "Protected"
there means what the map's runner means ([Cloud map](cloud-map.md#which-resources-count-as-protected)): any hint of a
protected environment, the tag `console:protected=true`, or — unless `inventory.unassignedProtected` is `false` — no
environment at all. An *act* token's change on such a resource waits for a person too.

- **Role.** At creation, a token gets a role no higher than yours. On every request its effective role is the lower of
  that and your *current* role — demote someone and their tokens are demoted too. The role check comes first: a
  developer token can't restart a production service even with an approval, because an approval runs as the approver
  but the request must be one the token's role could make.
- **Validity.** Expiry of 7, 30 or 90 days, or never. A revoked or expired token, or one whose owner is disabled or
  deleted, gets `401`. Revoking also rejects the token's pending approval requests, and its event streams close at
  their next heartbeat (within about 25 s). Disabling or deleting the owner rejects their tokens' pending requests at
  once.
- **Limits.** 120 requests per minute per token (every `tools/call` in an MCP batch counts); 25 active tokens per
  person; 20 pending approval requests per token. Unknown, malformed, expired or revoked tokens are throttled per
  client address: after 30 in 15 minutes, further bad tokens from that address get `429`. That address comes from
  `X-Forwarded-For` (see `CONSOLE_TRUSTED_PROXIES` in [Configuration](configuration.md#environment-variables)), so
  this throttle works only behind a load balancer or reverse proxy; valid tokens are never slowed down by someone
  else's bad ones. Over a limit: `429` with `Retry-After`.
- **Who sees what.** Everyone manages their own tokens; admins can list and revoke everyone's (**Everyone**).
- **Where tokens work.** `GET /api/ops`, `POST /api/ops/<name>`, `POST /api/mcp`, `GET /api/approvals[/<id>]`,
  `GET /api/events` and `GET /api/me`. Everything else — every page, users, tokens, integrations, settings, variable
  values, deciding approvals — answers `403`.
- **Requests.** Send `Authorization: Bearer dc_…`. No CSRF header is needed and cookies are ignored: a request with a
  token is judged on the token alone.
- **Usage.** Each token shows when it was last used and how many operations it called (saved at most every 30 s, so
  the count can trail a little). Changes are in the audit log as `<you> via token "<name>"`.

### ALB sign-in

With `AUTH_MODE=alb`, the load balancer's `authenticate-oidc` action runs before the console and would redirect an
agent to your identity provider. Add a higher-priority listener rule that forwards requests carrying the header
`Authorization: Bearer dc_*` (an `http-header` condition) on the paths above straight to the console, without the
authenticate action. The console verifies the token itself.

## Approvals

```
pending ──approve──▶ approved ──▶ done | failed
   │
   ├──reject──▶ rejected
   └──24 h────▶ expired
```

- **Created** when a token's mode requires it: the API answers `202 { approval: { id, status, plan, … } }` and MCP
  returns a normal result saying so. The same request sent again while pending returns the same approval.
- **Decided** by a person signed in to the console who holds the operation's permission (the protected variant on a
  protected environment), under **Automation → Approvals** or with `POST /api/approvals/<id>` and
  `{ "decision": "approve" | "reject", "reason"?, "confirm"? }`. Tokens can never decide.
- **Two people, if you want.** With `CONSOLE_APPROVALS_TWO_PERSON=true`, nobody may approve a request made with their
  own tokens (`403`); rejecting your own is still allowed. It's off by default so a one-person team can use agents.
- **Shown to those who need it.** The plan's changes, the input (for example a one-off task's command) and the result
  are visible to the token that asked and to people who could decide the request; everyone else sees only that it
  exists and its one-line summary.
- **Approving** asks for the plan's confirmation text (one click when it is `"yes"`) — the approver's text replaces
  whatever the agent sent, and a one-click request ignores any other text typed, so a stray value can't use it up —
  and for a reason when the request has none, on a protected environment and for every *danger* operation (on an
  unprotected environment too). An `approval.approve` audit row is written first; if the audit log is unavailable,
  the approval is refused (`503`) and the request stays pending. The operation then runs **as the approver**; the
  audit log records `<approver> approving token "<name>" (requested by <owner>)`. The result, or the error, is stored
  with the request.
- **The exact plan.** A request stores the hash of its plan (the operation, the resources it touches, the input with
  secrets HMAC'd, the changes and the confirmation). Approving plans the change again, as the token that asked; if
  anything differs — the service was scaled meanwhile, another revision went live — the request is rejected as
  `invalidated: the plan changed since it was requested` and the answer is `409` (`code: "plan_changed"`): the agent
  has to ask again, and the person approves what they actually see.
- **An agent's request is different.** For a request made by an agent token or an agent run (`run` is set on the
  approval), approving only records the decision on the request's grant: the change then runs **as the agent**, on its
  run, once, under that exact plan — never as the approver. It expires with the agent's policy (15 minutes by default),
  and the person the agent acts for counts as the requester in two-person mode. A rollback across changed (or
  unchecked) database migrations needs `"migrationAck": true` from the approver; agents can't send it themselves.
- **Rejecting** asks for a reason, which the agent can read (`detail`), and writes an `approval.reject` audit row.
- **Tied to its token.** If the token that asked has been revoked or has expired, or its owner was disabled or
  deleted, deciding rejects the request instead (`409`).
- **Atomic.** Every transition is one conditional update: approving twice, or two people approving at once, can't run
  the operation twice.
- **Stored safely.** The request's input is sealed with `CONSOLE_SECRET_KEY` (it may contain variable values); the plan
  holds names and counts only. Secret inputs are shown as `(hidden)`.
- **Following up.** `GET /api/approvals/<id>` (a token sees only its own requests), the `approvals.get` operation (for
  MCP clients), or the event stream.

## Live events

```bash
curl -N "$CONSOLE_URL/api/events" -H "Authorization: Bearer $CONSOLE_TOKEN"
# Missed some? Reconnect with the last id you saw (EventSource sends Last-Event-ID by itself):
curl -N "$CONSOLE_URL/api/events?after=1234" -H "Authorization: Bearer $CONSOLE_TOKEN"
```

| Event | Data |
|---|---|
| `ready` | `{ at, via, cursor }` — sent once, when the stream opens |
| `state` | `{ env, key, kind, name, state, previous, reasons, at }` — a resource changed state (from the background sampler) |
| `action` | `{ env, target, action, user, result, reason?, detail?, at }` — an action finished |
| `approval` | `{ event: "created" \| "decided" \| "done", id, op, status, env, tokenId, runId, at }` — a request was created, decided or ran |
| `run` | `{ id, kind, state, previous?, error?, at }` — an agent run changed state |
| `step` | `{ id, runId, seq, kind, name, state, at }` — a step of an agent run changed state |
| `operation` | `{ id, action, target, env, state, actor, actorKind, at }` — a change finished (people only) |
| `replayed` | `{ count, through, truncated, reset? }` — after a reconnect: the missed events were sent (`count` of them were yours to see); `truncated` means some were not (more than 500, or older than an hour) |

Every event except `ready` and `replayed` is stored for 7 days and carries an `id:`. Reconnecting with `Last-Event-ID`
or `?after=<id>` first sends what was missed — up to 500 events from the last hour (`truncated: true` when there were
more) — then goes live. `?run=<id>` keeps one agent run's events. Who sees what: people see everything; an API token
sees `state` and `action` events and its own approval requests; an agent token sees only its own run's events.

A live stream never skips an event that commits late (another console's change), and never sends one twice. An id
this console never issued — from another console's database, or from before its database was reset — starts the
stream at the newest event, with `reset: true` in `replayed`.

A comment line (`: ping`) every 25 s keeps proxies from closing the connection. A stream ends after about 10 minutes
and clients reconnect (browsers' `EventSource` does so by itself), so every connection is authenticated again
regularly. A token's stream also closes at the next heartbeat after the token stops being valid (within about 25 s).

## MCP

`POST /api/mcp` is a Model Context Protocol server over Streamable HTTP with plain JSON responses: `initialize`,
`ping`, `tools/list` (only the tools the token may call) and `tools/call` (through the same checks as the API). It
supports protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05`, is stateless (no sessions, no
server-initiated messages) and needs a token. Tool names use `_` (`services_restart`). A JSON-RPC batch holds at most
20 messages, handled one after another (a larger batch is refused as an invalid request, HTTP `400`); a call in a
batch that goes over the token's rate limit gets a JSON-RPC error (`-32603`, "rate limit") while the rest are
answered. A request body is at most 256 KiB. A change that needs approval comes back as a normal tool result with the approval id and a note
telling the model to wait and check `approvals_get`.

**Claude Code:**

```bash
claude mcp add --transport http deployment-console https://console.example.com/api/mcp \
  --header "Authorization: Bearer dc_…"
```

or in a project's `.mcp.json` (Claude Code expands `${CONSOLE_TOKEN}` from your environment, so the token stays out of
the file):

```json
{
  "mcpServers": {
    "deployment-console": {
      "type": "http",
      "url": "https://console.example.com/api/mcp",
      "headers": { "Authorization": "Bearer ${CONSOLE_TOKEN}" }
    }
  }
}
```

**Clients that only start local (stdio) servers**, such as Claude Desktop, can connect through a stdio-to-HTTP
bridge, for example the community `mcp-remote` package; [examples/agent](#example-agent)'s README has a ready-made
configuration. Check the bridge's README for its current options.

Prefer a *read* or *propose* token for chat clients.

## Example agent

`examples/agent/` in the repository is a zero-dependency Node script: a terminal chat that loads the token's tools from
`GET /api/ops?format=anthropic`, calls the Anthropic Messages API, runs each tool call through `POST /api/ops/<name>`,
and when a change needs approval prints the plan and waits on the event stream until a person decides. It is a
reference for building your own, not part of the console.

```bash
CONSOLE_URL=http://localhost:3200 CONSOLE_TOKEN=dc_… ANTHROPIC_API_KEY=… node examples/agent/agent.mjs
```

Its README (`examples/agent/README.md`) lists every setting.

## Model connections

Agents that the console runs itself use a **model connection**: the model access they call, and who pays for it.
Connections are listed under **Automation → Connections** (API: `GET /api/agents/connections`).

- **Personal or organisation.** A personal connection is usable only by you; admins can disconnect it but never use
  it. An organisation connection is created by an admin and usable by people with at least its minimum role.
- **Secrets are write-only.** The console seals a key when you save it and never shows it again. Every use is audited
  (`credential.use`), never with the value.
- **Endpoints.** Personal connections use the providers' built-in endpoints, or a custom endpoint an admin explicitly
  allowed for personal use; registered endpoints are for organisation connections by default. A local endpoint
  (Ollama, a local server) must resolve to loopback or private addresses only, and redirects and cloud metadata
  addresses are always refused.
- **No fallback.** A run always uses the connection it started with. It never switches to another provider, account,
  endpoint or model, so who pays and who sees the data never changes. If a key is refused or the connection is
  disconnected, the run waits for you to fix it (`paused_auth`). If the account is out of quota or keeps being rate
  limited, the run pauses (`paused_budget`). A reset time is shown only when the provider gives one; none is guessed.
- **Background use.** Workflow runs need a connection with background use turned on.
- **Disconnecting** pauses the runs using the connection. For an API key the console deletes its own copy, but the
  key stays valid at the provider until you delete it there; the connection says so.
- **Demo.** With the simulated account, a built-in **Demo model (scripted)** connection lets you try the assistant
  with no provider and no cost.

Provider notes:

- **Ollama.** Ollama's local endpoint can also reach Ollama's cloud models. A local connection refuses them before
  anything is sent. To make the Ollama server itself local-only, start it with `OLLAMA_NO_CLOUD=1` (or set
  `disable_ollama_cloud` in `~/.ollama/server.json`).
- **Bedrock.** The connection's own credentials (never the console's role) need `bedrock:InvokeModelWithResponseStream`,
  plus `bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles` to list models, and `sts:AssumeRole` on the
  role for a role connection. Cross-region inference profiles (`us.`, `eu.`, `apac.`, `in.`, `global.`…) can process
  requests outside the connection's region; the model list marks them.
- **Claude.** Newer Claude models ignore the temperature setting and refuse a forced tool call; the console drops
  the one and refuses the other before sending anything.

### Local runtimes

A runtime connection (admins only) runs a CLI that is installed and signed in on the console's own machine, as an
MCP client of the console.

- **Claude Code** (2.1.263 or newer; `CONSOLE_CLAUDE_BIN`). The console runs your own `claude` as
  `claude -p … --restricted --tools "" --disable-slash-commands --strict-mcp-config --mcp-config <0600 temp file>
  --allowedTools "mcp__deployment-console__*" --permission-mode dontAsk --permission-prompts none --output-format
  stream-json --verbose --no-session-persistence`. It runs in an empty temporary directory with only `PATH`, `HOME`,
  `USER`, `LANG` and `TERM` (no AWS, console, API-key or database variables) and a token valid for that run only. Your
  hooks, plugins and settings files don't load, and it can't run commands, edit files or browse. If it lists any tool
  other than the console's (and Claude Code's three MCP-resource helpers), the run is stopped. It is billed to
  whatever login the CLI has, usually your Claude subscription. A refused login pauses the run (`paused_auth`): run
  `claude` and `/login` as the user the console runs as.
- **Gemini CLI** (0.11.0 or newer; `CONSOLE_GEMINI_BIN`). It works the same way, with its settings written to the run's
  own directory. Older versions are reported as too old for HTTP MCP.
- One CLI runs at a time by default (`CONSOLE_RUNTIME_CONCURRENCY`); others wait in a queue.

### ChatGPT plan (off by default)

With `CONSOLE_CHATGPT_PLAN=eligible`, a personal connection can use your ChatGPT plan instead of an API key. OpenAI
offers ChatGPT plan usage for open-source apps and personal projects running locally (and self-hosted VMs of an
eligible open-source app). A shared or hosted console isn't assumed eligible: paid or remotely hosted offerings need
OpenAI's approval. Open the console at `http://127.0.0.1:<port>` and use **Connections → Sign in with ChatGPT**. The
connection shows the account and plan it is bound to (never an email), with a link to ChatGPT → Settings → Usage to
review or cap its use. The console never shows a remaining quota and never falls back to API billing: when the plan's
allowance runs out, the run pauses. Disconnecting signs the session out at OpenAI and says whether OpenAI confirmed it.


## The Automation page

Automation has eight tabs. **Approvals** (opens first when something waits): changes agents asked for. An agent's
request shows the exact plan it binds (its hash), the resources, the evidence it cites and how old it is, how success
will be judged and when it expires; approving needs a typed confirmation and a reason, and lets the agent's run make
that change as the agent — never as you. If the plan changes first, the request is invalidated and says why.
**Runs**: release metrics (verified completion, escalations, unknown outcomes, prevented violations, duplicate effects,
invalidated approvals, measured cost) and every run; a run shows who asked, who it acts for, which connection pays, its
scope, budget, evidence, proposals and three separate outcomes — *AI completed*, *AWS accepted*, *verified healthy* —
and has a Stop button. **Workflows**: start from a template, edit the draft in fields, preview (trigger, services, steps
and who decides each change, limits, approvals, destination, payer), publish exactly the preview; versions never
change. **Agents**: the agents on/off switch (admins; `CONSOLE_AGENTS` overrides it), the step worker, the emergency
stop and agent definitions. **Connections**: model access and who pays. **Connect your agent**: a token and ready-made
configuration for Claude Code, Gemini CLI or any MCP client — the client's own subscription pays and the console never
sees it. **API tokens** and **Operations** as before. While the emergency stop is on, a banner on every tab says who
turned it on and why.

## Agent runs and the assistant

The **Ask** button in the top bar (or `g i`), and **Explain this** / **Why is this unhealthy?** on a resource, start an
assistant run: an incident-investigator agent that acts for you, reads the resource and its neighbourhood on the cloud
map, explains what it found with the evidence, and prepares any change as a proposal for review. The same from a
script (people only, with your session):

```bash
POST /api/assistant { "question": "Why is api slow?", "resourceKey": "…", "connectionId": "…" }   # → 201 { "runId" }
```

With the simulated account the connection defaults to the built-in scripted demo model; against a real account you
name one (Automation → Connections) — there is no default and no fallback. A question that looks like it contains a
secret is refused (`secret_in_question`): set secrets in the service's Variables tab instead.

Follow a run with `GET /api/agents/runs/<runId>` or the event stream (`/api/events?run=<runId>`). A run shows who
asked and who it acts for, which connection pays, its scope, the evidence it read (each with an id like `E3` and its
age), its proposals (the plan hash each one binds and when it expires), the operations AWS accepted and how they were
verified, its budget, and three separate outcomes: *AI completed*, *AWS accepted*, *verified healthy*.

- **Budgets pause, they don't stretch.** A run that reaches its model-turn, tool-call or cost limit stops in
  `paused_budget` instead of carrying on. A change a person approves still runs after the run's time limit: the
  approval's own expiry and the verification window bound it.
- **Cancelling** (`POST /api/agents/runs/<runId>/cancel`, or Stop) starts no new steps and withdraws pending approval
  requests. Changes AWS already accepted can't be called back: the console keeps verifying them and the run says how
  they end.
- **Metrics:** `GET /api/agents/metrics` (`?since=`, admins `?all=1`) counts what was verified — verified completion,
  escalations, unknown outcomes, prevented violations, duplicate effects, invalidated approvals and measured cost.

## Workflows

Automation → Workflows starts from six templates (incident investigator, approved remediation, non-production
schedule, daily digest, cost review, configuration drift). A workflow is a list of steps run in order; publishing it
needs its preview (when it fires, which resources it touches, what runs on its own and what a person approves, where
the result goes and who pays). Published versions never change; a change is a new version. Scheduled and event runs
act for the person who published the version; a run started by hand acts for whoever started it. Disabling a workflow
stops its schedules at once and ends its runs at their next step. A non-production schedule acts only on the services
listed in its preview: a service that matches later pauses the run until a person continues (without it) or cancels —
the run view shows the prompt. A run paused for review waits only until its time limit; then it is cancelled and
nothing is done.

## Security model

- **A token is a delegate, never more.** It acts as its owner, at most with the role chosen at creation and never
  above the owner's current role. The owner's account being disabled or deleted ends it.
- **Only a hash is stored.** The token (`dc_` + 32 random bytes) is shown once; the database holds its SHA-256. The
  `dc_` prefix makes a leaked token easy to spot for secret scanners.
- **A small surface.** The console lets tokens reach only the agent routes listed above, checked before the token is
  even looked up; cookies are removed from such requests so a token can never ride on a browser session.
- **People decide.** Protected environments (on the cloud map, protected resources) and dangerous operations
  (including copies, new hosts, one-off tasks with a command, and deploying code or images) always need a person for
  token requests, whatever the mode; deciding needs a signed-in person with
  the permission; the approver's own role is checked again.
- **Everything is attributed.** Every change a token makes — directly or through an approval — is audited with the
  token's name; token creation and revocation, approvals and rejections are audited too.
- **Sealed at rest.** Approval inputs are encrypted with `CONSOLE_SECRET_KEY`, like integration secrets.
- **One switch turns it off.** `CONSOLE_API_TOKENS=false` refuses every bearer request and blocks new tokens; existing
  tokens stay listed (revocable) and work again when the switch is flipped back. The switch fails closed: only unset,
  `true`, `1`, `yes` or `on` leave tokens on, so a typo turns them off.

## Agent identities, policies and the emergency stop

API tokens (`dc_`) act in a mode. **Agent tokens** (`da_`) act under a **policy** — the identity of an agent run, built
by the console, never a person's session:

- **Run tokens** are minted for one run (the local `claude` runtime calls the console's MCP server with one); they end
  with the run.
- **External agent tokens** come from *Connect your agent*, or `POST /api/agents/tokens` with
  `{ "name", "definitionId", "days": 7 | 30 | 90 }` → `{ token, id, runId, expiresAt, mcpUrl }` (shown once). The
  definition is a stored agent definition or one of the built-in templates — `incident-investigator`,
  `approved-remediation`, `nonproduction-schedule`, `daily-digest`, `cost-review`, `config-drift`. Each token has its
  own run, which every call is recorded against; `GET /api/agents/tokens` lists yours (admins `?all=1`), `DELETE
  /api/agents/tokens/<id>` revokes it, cancels its run and rejects its pending requests. While agents are turned off,
  creating one answers `503`.

Agent tokens reach the same routes as API tokens. An agent acts for one person: it never has more than that person's
**current** role (demoting or disabling them takes effect at once), and its policy narrows that further. For every call
the console checks, in order: what no policy can allow (below); the policy's tool lists (`deny` wins); its scope
(accounts, regions, environments, resource keys, kinds, tags — a change whose resources, or under an account or region
scope whose AWS account or region, can't be worked out is refused); security metadata (an agent never changes a resource
whose tags couldn't be read — not even as an approval request; with `requireCompleteSecurityMetadata`, nor one whose
other security metadata, such as a resource policy, couldn't be read completely); the mode — **observe** (reads only),
**propose** (every change becomes an exact-plan approval request), **bounded-act** (a listed routine change on resources
listed *by name*, unprotected, runs on its own; anything else asks a person); then its limits (tool calls, model turns,
run time, concurrent and per-resource hourly changes). Dangerous operations, protected environments and services, hosts
or databases tagged `console:protected` always need a person; so does a scale or start of a service Application Auto
Scaling manages, and a rollback across changed migrations. `GET /api/me` with an agent token returns `principal: { kind,
runId, delegator, mode, policyHash }`. An agent's approval request expires with its grant (the policy's
`approval.expireAfterSeconds`, 15 minutes in the templates; the card shows the time). It is withdrawn when its run ends
before anyone decides, when the run's policy changes, or when the person the agent acts for can no longer make the
change — approving then answers `409` (`run_finished`, `policy_changed`, `delegator_changed`). Over MCP, a tool the
agent's policy hides answers with the refusal and its reason (a tool error), and the attempt is recorded on the agent's
run.

- **The agents switch.** `CONSOLE_AGENTS=on|off` decides when set; otherwise an admin's toggle
  (`POST /api/agents/settings { "enabled": false }`); otherwise agents are on with the simulated account and **off
  against a real AWS account**. While off, agent tokens and runs get `503 agents are turned off on this console`.
  `GET /api/agents/settings` also shows this console's step worker (`worker: { started, draining, inflight,
  handlers }`); it starts once the console has settled what a previous run left in flight, so `started: false` on a
  console that has been up for a minute means it never came up (check the server log).
- **The emergency stop.** `POST /api/agents/emergency-stop { "on": true, "reason": "…" }` (admins; audited) stops every
  agent change at once — `423` — whatever any policy says, while reads go on; queued agent changes wait. `GET` shows
  who turned it on, when and why. A change an agent was about to make waits too, even if the stop was turned on after
  the change was picked up, and runs once the stop is lifted, if its approval hasn't expired. Turning the stop or the
  agents switch on or off is recorded in the audit log and sent as an `action` event (`agents.emergency_stop`,
  `agents.emergency_stop_lifted`, `agents.enable`, `agents.disable`).
- **When the console stops mid-change.** An agent's change is never sent twice. If the console stops, or loses the
  answer, after a change reached AWS, the step shows *outcome unknown*, the run waits, and a check of the resource
  follows. A change that never reached AWS simply runs again. Cancelling a run stops its model and tool work within a
  few seconds; a change AWS is already processing still finishes and is checked.

## What an agent can never do

- Read environment variable values — there is no such operation and the reveal route refuses tokens. An API token can
  *write* a value it was given (`variables.update`), which the plan and audit log record by name only; an agent token
  never can.
- Manage users, API or agent tokens, integrations or settings, or approve or reject anything. (Agent tokens) start,
  change or administer runs, agents, workflows, connections or policies — their own included.
- (Agent tokens) change IAM or anything belonging to the console itself, act after the emergency stop, or run a change
  without the exact plan a person approved (unless its policy is bounded-act and the change is listed by name).
- Open pages, or use a session cookie.
- Exceed the role of the person who created its token.
- Change a protected environment, or run a dangerous operation, without a person approving it.
- Open a shell, use ECS Exec or make an arbitrary AWS call — the console has none of these, for anyone. The only
  free-text command is the optional command override of a one-off task (`tasks.run`), which runs inside the service's
  own task definition and role. It counts as *danger*: a person must approve it in every mode, and the audit log
  records the command.
