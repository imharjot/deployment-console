# Security policy

The Deployment Console holds an AWS role that can see, and if you allow it change, what a team runs on Amazon ECS, and
it lets people use that role without AWS access of their own. We treat security reports as the highest-priority
issues, and we're grateful for them.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a vulnerability.**

1. Report it privately through the repository's **Security → Report a vulnerability** form (GitHub private
   vulnerability reporting). If that isn't available, contact the maintainers privately and ask for a secure channel
   before sharing details.
2. Include what you can:
   - the affected version or commit;
   - your configuration: `AUTH_MODE`, the database (SQLite or Postgres), `CONSOLE_SOURCE`, and whether API tokens are
     on;
   - steps to reproduce (the simulated account, `CONSOLE_SOURCE=mock`, is ideal because it needs no AWS account);
   - the impact you observed, and a suggested fix if you have one.
3. The maintainers will acknowledge the report, agree a fix and disclosure timeline with you, and credit you in the
   release notes unless you'd rather not be named.

Please test against your own installation or the simulated account, never against someone else's console or AWS
account.

## Supported versions

The project is pre-1.0: fixes land on the default branch and in the next release. Run a recent build.

## Scope

In scope — anything that lets someone do more than their role allows, or learn what they shouldn't:

- authentication and sessions: `src/proxy.ts`, `src/lib/server/auth/`, the OIDC flow, ALB header verification, the
  first-run setup;
- authorisation gaps: an action, power change, variable reveal or edit, create & scale action, CI re-run, ticket, cost
  data or admin operation reachable without the right role, or on a protected environment without its confirmation
  and reason;
- the agent surface: an API token reaching a route outside the operations API, exceeding its owner's role or its mode,
  deciding an approval, or reading variable values; an approval running twice or as the wrong person, or approved by
  its own requester with `CONSOLE_APPROVALS_TWO_PERSON=true`; the MCP endpoint;
- CSRF, open redirects, injection (SQL, log query, CloudWatch pattern, HTML) and XSS in the UI or `/docs`;
- a way to make the console call AWS, GitHub or a URL on a resource it didn't discover or wasn't configured with, or
  make an integration reach a link-local (cloud metadata) address;
- disclosure of secrets: integration secrets, session or API tokens, environment variable values or EC2 user data;
- audit-log bypass: a change that runs without an intent row being written first;
- deleting or terminating a resource the console didn't create, or acting on the console's own service.

Out of scope: weaknesses in your own AWS account configuration or in IAM policies you wrote, denial of service by an
authenticated admin, findings that need a compromised host or browser, and issues in third-party dependencies without
a demonstrated impact on the console (please report those upstream).

## What the console guarantees

These are design guarantees. A way around any of them is a vulnerability:

- It stores **no AWS credentials**: it uses the standard SDK credential chain (an ECS task role in production).
- **Environment variable values never appear in page data.** They are returned only on an explicit, role-checked
  reveal or edit, and only after the audit row (names only) is written; they never appear in the audit log or in
  approval plans, no operation returns them to an API token, and the console's own service's variables are never
  revealed at all. A plan to change variables never compares with the current values, and the cloud map's S3 file
  actions refuse env files.
- It has **no shell, no ECS Exec and no arbitrary AWS call**. The only free-text command is the optional command
  override of a one-off ECS task, which needs the role that may restart that service, is recorded in the audit log,
  and always needs a person's approval when an API token asks for it.
- It **never acts on its own service** (and refuses every change when it can't tell which service is its own), nor
  on its own EC2 host (`CONSOLE_SELF_INSTANCE`, or anything tagged `console:self=true`), and the shipped IAM policy
  denies it too.
- It **deletes or terminates only resources it created** (tag `console:created=true`), and the shipped IAM policy
  enforces the tag too.
- It never performs a change without an **audit intent** row written first (approving an agent's request writes its
  own row before the operation runs); if the audit log is unavailable, the change is refused.
- **Power actions** (EC2 and RDS start/stop) are disabled on protected environments, and it never copies a protected
  environment's service into an unprotected one.
- **API tokens** reach only the operations API, never act above their owner's current role, can never approve a
  request, and need a person's approval for any change on a protected environment and any dangerous operation. On the
  cloud map, "protected" fails safe: a resource that any hint ties to a protected environment, one tagged
  `console:protected=true`, and (by default) one in no environment all count.
- Integration secrets and agents' approval inputs are **encrypted at rest** (AES-256-GCM with `CONSOLE_SECRET_KEY`),
  and integration secrets are never sent back to the browser.
- **Integration URLs** can never reach link-local addresses (EC2 instance and ECS task metadata), not even when an
  admin enters one, and redirects are never followed.
- It never touches the data in **application databases**; the only database it writes is its own.

See [docs/security.md](docs/security.md) for the threat model and a hardening checklist, and
[docs/connect-aws.md](docs/connect-aws.md) for every IAM permission it uses.
