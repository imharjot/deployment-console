# Example agent

A terminal chat that operates the Deployment Console through its [operations API](../../docs/automation.md): ask
"is production healthy?" or "restart the worker in staging" and watch it call the console's tools. About 220 lines of
Node with no dependencies — a reference for building your own chat or voice assistant, not part of the console.

## Run it

You need Node 24+, a running console (the demo from the [Quickstart](../../docs/quickstart.md) is fine), an API token
and an Anthropic API key.

1. In the console, **Automation → API tokens → New token**. For a first try pick **Propose** (every change waits for
   your approval) or **Read only**. Copy the token: it is shown once.
2. Set the variables and check the token works. The answer starts with `{"caller":{"email":…` and shows the token's
   mode:

```bash
export CONSOLE_URL=http://localhost:3200     # your console
export CONSOLE_TOKEN=dc_…                    # the token from step 1
export ANTHROPIC_API_KEY=…
curl -sS "$CONSOLE_URL/api/ops" -H "Authorization: Bearer $CONSOLE_TOKEN" | head -c 300
```

3. From the repository root, start the agent:

```bash
node examples/agent/agent.mjs
```

| Variable | Default | Meaning |
|---|---|---|
| `CONSOLE_URL` | `http://localhost:3200` | the console's address |
| `CONSOLE_TOKEN` | — | an API token (`dc_…`) |
| `ANTHROPIC_API_KEY` | — | key for the Anthropic Messages API |
| `AGENT_MODEL` | `claude-sonnet-5` | model id |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | a gateway or proxy in front of the API |
| `AGENT_APPROVAL_WAIT_MIN` | `30` | how long to wait for a person's decision before giving control back |

## What happens

1. It loads the tools this token may call from `GET /api/ops?format=anthropic` — a read-only token gets no change
   tools at all (and the console refuses it even a dry run of a change).
2. Each message goes to the Messages API with those tools. Every tool call becomes `POST /api/ops/<name>`; results go
   back to the model.
3. When the console answers **202** (the change needs a person, because of the token's mode, a protected environment
   — on the cloud map, a protected resource or one in no environment — or a dangerous operation), the agent prints the
   plan and waits. It listens on `GET /api/events` and polls `GET /api/approvals/<id>` as a fallback. Approve or
   reject under **Automation → Approvals**; the outcome — the result, the error, or your reason for rejecting — goes
   back to the model.

```
you › restart the worker in staging

agent › Checking staging first.
  → envs_status {"env":"staging"}
  → services_restart {"env":"staging","service":"worker","confirm":"yes"}

⏸  Needs approval: Restart worker in Staging
   • new deployment of revision 123 (1/1 tasks, rolling)
   Approve or reject it in the console: http://localhost:3200/automation  (request 8841…)
   ✓ Approved by alice@acme.dev and run.

agent › Restart submitted: new tasks of worker are starting on revision 123.
```

The agent never decides what needs approval — the console does. It can't read environment variable values, manage
users or tokens, or approve its own requests, whatever it is told.

## Use the console from an MCP client instead

The same operations are available as MCP tools at `POST /api/mcp`. For Claude Code:

```bash
claude mcp add --transport http deployment-console "$CONSOLE_URL/api/mcp" --header "Authorization: Bearer $CONSOLE_TOKEN"
```

or in a project's `.mcp.json`:

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

Claude Desktop and other clients that only start local (stdio) servers can connect through a stdio-to-HTTP bridge, for
example the community `mcp-remote` package — in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "deployment-console": {
      "command": "npx",
      "args": ["mcp-remote", "https://console.example.com/api/mcp", "--header", "Authorization:${CONSOLE_AUTH}"],
      "env": { "CONSOLE_AUTH": "Bearer dc_…" }
    }
  }
}
```

(Check the bridge's README for its current options.) A change that needs approval comes back as a tool result with
the request id; the model can follow it with the `approvals_get` tool.
