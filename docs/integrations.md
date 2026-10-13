# Integrations

Send notifications and create tickets without leaving the console. Admins configure integrations under
**Settings → Integrations**; secrets (tokens, webhook URLs) are encrypted at rest with `CONSOLE_SECRET_KEY` and never
shown again after saving.

| Integration | Notifications | Tickets | You provide |
|---|---|---|---|
| **Slack** | ✓ | | an [incoming webhook](https://api.slack.com/messaging/webhooks) URL |
| **Webhook** | ✓ | | any HTTPS URL, optional signing secret |
| **GitHub Issues** | | ✓ | repo `owner/name`, token (or reuse `GITHUB_TOKEN`), labels |
| **Jira Cloud** | | ✓ | site URL, account email, API token, project key, issue type |
| **Linear** | | ✓ | API key, team ID |
| **ClickUp** | | ✓ | API token, list ID, tags |
| **Asana** | | ✓ | personal access token, project GID |

Every integration has a test button that checks your settings before you rely on them: **Send test** for
notification integrations (it sends a test message), **Test connection** for ticket integrations (it reads the
project, list or repository instead of creating a ticket).

## Allowed URLs

Integration URLs (a webhook, a Jira site, …) must be `http://` or `https://`. Private addresses are fine — a
self-hosted Jira or an internal webhook receiver is normal — but link-local addresses are refused, even for admins and
even behind a host name: link-local `169.254.0.0/16` (EC2 instance metadata `169.254.169.254`, ECS task metadata
`169.254.170.2`) and `fe80::/10`, AWS's `fd00:ec2::/32`, and "this host" (`0.0.0.0/8`, `::`) — in every spelling
(IPv4-mapped, IPv4-compatible, IPv4-translated, NAT64, numeric). They hand out cloud credentials. The host name is
resolved once and only an address that passed the check is dialled, so a name can't change its answer between the
check and the request. Redirects are never followed: a `30x` answer counts as an error, so enter the final URL. See
[Outbound requests](security.md#outbound-requests).

## Notifications

Pick which events each notification integration receives, and from which environments (all, protected only, or a list):

| Event | When |
|---|---|
| Service down | a service or resource becomes DOWN |
| Service degraded | … becomes DEGRADED |
| Service recovered | … returns to UP after DOWN, DEGRADED or UNKNOWN |
| Console actions | anyone changes something through the console — restart, stop/start, switch revision, power, variable reveals and edits, create & scale — with who, why and the result |
| CI failures | a GitHub Actions run fails on a watched repository |

Delivery is fire-and-forget with a 5 s timeout and one retry. The same state change is sent at most once a minute per
integration, so a flapping service doesn't flood a channel; every console action is sent. The last deliveries (and failures) are listed on the
settings page.

### Webhook payload

`POST` with `Content-Type: application/json`, the event as the body, and headers:

| Header | Value |
|---|---|
| `X-Console-Event` | event type, e.g. `service.down` |
| `X-Console-Signature` | `sha256=<hex HMAC-SHA256 of the raw body with your secret>` (when a secret is set) |

```json
{ "type": "service.down", "at": 1790000000000, "url": "https://console.example.com/?env=production&r=service:api",
  "env": "production", "envLabel": "Production", "protected": true,
  "key": "service:api", "name": "Public API", "state": "DOWN", "previous": "UP", "reasons": ["0/1 tasks running"] }
```

Verify the signature before trusting the body.

## Tickets

A **Ticket** button appears (for developers and above) in three places, pre-filled with the context you're looking at:

- a resource's panel — name, state, reasons, commit, deep link;
- a log line — the line, its timestamp, service and environment;
- a CI run — workflow, branch, commit, failed jobs and tests, GitHub link.

Edit the title and description, pick the integration, and create it. The console returns a link to the new ticket,
and records it in the audit log.

## Adding an integration

Integrations are small, self-contained modules: a file in `src/lib/plugins/` and one line in
`src/lib/plugins/registry.ts`. The settings page, secret storage, test button and delivery pick them up
automatically. The step-by-step guide is in `CONTRIBUTING.md` at the root of the repository.
