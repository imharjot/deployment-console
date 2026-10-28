# Security model

What the console protects against, what it can and cannot do to your AWS account, and how to deploy it safely. This
page is for whoever approves running it: security reviewers, platform engineers and account owners. To report a
vulnerability, follow `SECURITY.md` at the root of the repository, never a public issue.

## The short version

- The console acts in AWS with **its own IAM role**. People sign in to the console, not to AWS, and each person can
  only do what their [role](auth.md#roles) allows. Their changes are audited under their name.
- **You decide what the role can do.** With the read-only policy it can change nothing. Each write feature is a
  separate set of IAM statements you can leave out.
- Every change goes through the **same server-side guard** as the button, needs a **confirmation** (typed, with a
  reason, on protected environments) and writes an **audit intent before** calling AWS. No intent, no change.
- It **never acts on its own service**, **deletes only what it created**, and has **no shell, no ECS Exec and no
  arbitrary AWS call**, for anyone.
- Agents use **API tokens** that act for a person, never with more than that person's role; changes on protected
  environments and dangerous operations always wait for a person to approve them.

## Threat model

The console holds an AWS role that can see — and, if you allow it, change — what you run on ECS, and it lets people
use that role without AWS access of their own. That makes the console itself worth protecting.

| Threat | What stops it |
|---|---|
| Someone on the internet reaches the console | Every page and API call needs a signed-in person or a valid API token (`src/proxy.ts`); only the sign-in pages and the health check are open. Deploy it on a private network behind a load balancer with HTTPS (see [Deploy the console](deploy.md)). |
| Someone on the network, or a web page, reaches a laptop running `AUTH_MODE=dev` | `npm run dev` listens on `127.0.0.1` only, and in `dev` mode every request must name a loopback host (`Host`, `X-Forwarded-Host`, `Forwarded`), checked before anything else: a LAN client or a DNS-rebinding page gets `403`. A first password and API tokens — which outlive dev mode — are only created for loopback requests. See [`dev` mode is loopback-only](auth.md#dev-mode-is-loopback-only). |
| A signed-in person does more than their role allows | The server checks the role on every request, whatever the UI shows. Protected environments need a higher role, a typed confirmation and a reason. |
| A malicious website uses a signed-in browser (CSRF) | Every non-GET request needs the header `x-console-csrf: 1` and an `Origin` equal to `CONSOLE_PUBLIC_URL` (or, when that isn't set, to the request's own host); the session cookie is `SameSite=Lax`. |
| A password is guessed | Passwords are hashed with scrypt; failed sign-ins are rate-limited and don't reveal which emails exist. Prefer SSO. |
| Someone else's SSO identity signs in to an account (a reassigned email address, an unverified email) | The provider must have verified the email (`email_verified`, or Entra's `xms_edov`; required by default). An account is bound to the SSO subject of its first SSO sign-in, and a different subject with the same email is refused and audited. |
| An API token leaks | Only its SHA-256 is stored; it reaches only the agent routes; it is capped at a role and a mode (*propose* by default); it can expire and be revoked; `CONSOLE_API_TOKENS=false` turns every token off. |
| An agent is tricked into doing damage (for example by text in a log line) | Its token can't exceed its owner's role; in *propose* mode every change waits for a person; changes on protected environments and dangerous operations always do; with `CONSOLE_APPROVALS_TWO_PERSON=true` that person can't be the token's owner; no operation reveals variable values. |
| Secrets leak through the console | Variable values are never in page data; revealing them needs a role and an audit row (no audit row, no values); the console never reveals its own service's variables; the cloud map's S3 file actions refuse env files, plans of variable changes never compare with current values, and credentials in URLs are masked; integration secrets and agents' approval inputs are encrypted at rest; EC2 user data never leaves the server. |
| A shared parameter, secret or env file is changed through a less protected service | A value is as protected as the most protected service that reads it: editing or revealing it from a non-protected service needs the protected role, a typed confirmation and a reason when any reader is protected, and is refused when the console's own service reads it. If the console can't tell who reads it (a region or service it couldn't list), it treats the value as protected. |
| The console breaks itself or deletes your infrastructure | It never acts on its own service (in code and with IAM denies; if it can't tell which service is its own, it refuses every change), never stops, reboots or scales its own EC2 host (`CONSOLE_SELF_INSTANCE`, or the tag `console:self=true` that the IAM deny also goes by), and deletes only resources tagged `console:created=true` (in code and with IAM conditions). |
| Someone uses the console to run code of their choosing | There is no shell or exec. A one-off task's command override needs the role that may restart the service, is recorded in full in the audit log, and always needs a person's approval when an agent asks. Deploying new Lambda code or a new ECS image from the cloud map is *dangerous* too: a person always approves an agent's request. Copies and image deploys can be limited to your own registries (`provisioning.allowedImageRegistries`); without it, an image deploy stays on the registry the container already uses. |
| An integration or health-check URL is aimed at cloud metadata (SSRF) | Integration URLs and `console:healthcheck` URLs must be `http(s)`; link-local addresses — EC2 instance metadata `169.254.169.254`, ECS task metadata `169.254.170.2`, `fe80::/10`, AWS's `fd00:ec2::/32` — and "this host" (`0.0.0.0/8`, `::`) are refused in every spelling, even for admins, and redirects are never followed. See [Outbound requests](#outbound-requests). |
| A change nobody can trace | The audit log records who, when, from where and why, before and after every change, including changes made through tokens and approvals. |

Not covered: a compromised host or browser, an admin acting in bad faith, people who change things directly in AWS,
and AWS account settings or IAM policies outside the console.

## What the console can and cannot do

What it *can* do in AWS is exactly what its IAM role allows:

| With | It can | It cannot |
|---|---|---|
| **The read-only policy** (`infra/iam-policy-readonly.json`) | list and describe ECS, EC2, RDS, ElastiCache and load balancers; read CloudWatch metrics and logs; run Logs Insights queries; read Cost Explorer | change anything; read secret values, S3 env files or EC2 user data |
| **The full policy** (`infra/iam-policy.json`) | everything above, plus: update any ECS service in the region (restart, stop, roll back, deploy a new revision); start, stop and reboot EC2 instances, and start and stop RDS instances, tagged `console:power=allow`; register task definitions; read and write SSM parameters and Secrets Manager secrets; read, write and delete objects in one S3 bucket (the one holding your env files); create services and launch EC2 hosts (tagged `console:created=true`); run one-off tasks; the cloud map's actions | delete or terminate anything not tagged `console:created=true`; update or delete its own service; stop, reboot, terminate or scale anything tagged `console:self=true`; change IAM (beyond passing existing roles to new tasks and hosts); touch the data inside your databases |

Whatever the policy:

- **No shell, no ECS Exec, no arbitrary AWS call.** The only free-text command is the optional command override of a
  one-off task ([Run task](provisioning.md#run-a-one-off-task)). It runs with the service's own task definition and
  role, needs the role that may restart that service, and is recorded in the audit log. For API tokens it is a
  *dangerous* operation: a person always approves it.
- **Never on itself.** The console recognises its own service and refuses every action, reveal, copy and one-off task
  on it. If it runs on ECS but can't tell which service is its own, it refuses them everywhere until it can (set
  `CONSOLE_SELF` to avoid that). On EC2 it never stops, reboots or scales its own instance or Auto Scaling group
  (`CONSOLE_SELF_INSTANCE`, or the tag `console:self=true`).
- **Power actions are never allowed on protected environments.**
- **On the cloud map, protection fails safe.** A resource follows the protected rules if any hint names a protected
  environment (its provider, its tags, its name, its VPC, its EKS cluster), if it's tagged `console:protected=true`,
  or — unless `inventory.unassignedProtected` is `false` — if it's in no environment at all. A tag can add protection,
  never remove it; and whoever can tag a resource can't move it out of the environment its provider reports. See
  [Cloud map](cloud-map.md#which-resources-count-as-protected).
- **It never copies a protected environment's service into an unprotected one**, where its variables and secret
  references would become readable by more people.
- **Outbound calls** go only to AWS APIs, GitHub (if you set a token), the integrations you configure, your identity
  provider, and the health-check URLs you set with the `console:healthcheck` tag or the config file. Integration and
  health-check URLs can't reach link-local (cloud metadata) addresses, and their redirects are never followed
  ([Outbound requests](#outbound-requests)).

### What every signed-in person can see

The *viewer* role — the least any signed-in person has — can read every environment's status, events, metrics, the
audit log, **and application logs**. Logs often contain personal data or secrets your apps printed. Invite only people
who may see production logs, and keep sensitive values out of logs.

## Identity

Every page and API call passes one gate (`src/proxy.ts`): a valid session (password or OIDC), a verified ALB OIDC
header, or — only outside production, and only for requests addressed to a loopback host — the dev identity.
Unauthenticated page loads go to sign-in; API calls get `401`. Headers the browser sends that look like the console's
own identity headers are dropped before the gate.

- **Dev mode is loopback-only.** `AUTH_MODE=dev` makes every caller an admin, so in that mode the gate first checks
  that `Host`, every `X-Forwarded-Host` entry and every `Forwarded: host=` name `localhost`, `127.0.0.1`, `[::1]` or a
  `*.localhost` name, and answers anything else with `403` — before API tokens or sessions are looked at. The routes
  that create credentials which outlive dev mode (the dev user's first password, API tokens) check it again.
- **SSO.** The ID token's email must be verified by the provider (`OIDC_REQUIRE_EMAIL_VERIFIED`, on by default; Entra
  ID's `xms_edov` counts). The first SSO sign-in binds the account to the provider's subject (`sub`); afterwards a
  different subject for that email is refused and recorded as a failed sign-in, and a bound subject can't sign in to
  another account.
- **Load balancer.** The ALB's `x-amzn-oidc-data` header must be signed (ES256) by the load balancer named in
  `ALB_ARN`, and the `exp` in its signed header must not have passed (60 s clock tolerance); an expiry in the payload
  never replaces it.

Agents use API tokens (`Authorization: Bearer dc_…`). A token acts as its creator, capped at its own role and the
creator's current role, and can reach only the operations API — never pages, users, tokens, integrations, settings,
variable values or approval decisions. Cookies are removed from token requests. Details:
[Agents & API](automation.md#security-model).

## Authorisation

Four roles, each including the one before: **viewer** (read), **developer** (actions and variables on non-protected
environments, CI re-runs, tickets, forcing a cloud-map refresh), **operator** (+ protected environments, power,
costs, create & scale on non-protected environments), **admin** (+ users, integrations, discovery re-scan, create &
scale on protected environments). Checks run on the server for every request; the UI only mirrors them. See
[Sign-in & roles](auth.md).

## Requests

- Every non-GET request needs the `x-console-csrf: 1` header **and** a matching `Origin`. With `CONSOLE_PUBLIC_URL`
  set, the `Origin` must be exactly that origin and no request header can change the answer; without it, the
  request's own host (`X-Forwarded-Host`, else `Host`) is the reference. Set it in production. Requests with an API
  token are exempt: they carry no ambient credentials (cookies are ignored).
- API tokens are rate-limited (120 requests per minute each; repeated failed token checks from one address are
  throttled). Per-address throttles — for sign-in, one-time links and bad tokens — take the client's address from
  `X-Forwarded-For`: the entry `CONSOLE_TRUSTED_PROXIES` places from the end (default `1`, one load balancer; `2` for
  CloudFront → ALB). Entries before it were written by the client and are never trusted. With `0` (nothing in front)
  the header is ignored and per-address throttles are off; the per-email and per-token limits always apply.
- Without `CONSOLE_PUBLIC_URL`, the allowed origin, sign-in redirects and invite links follow the request's `Host`
  header; the console logs a warning at start when it runs in `session` or `alb` mode that way.
- Request bodies are capped (10 KB for forms; more only where a route needs it, such as the Variables editor). A
  `Content-Length` over the cap is refused with `413` before the body is read, and a body without one is counted while
  it arrives and cut off at the cap.
- Session cookies are `HttpOnly`, `SameSite=Lax` and `Secure` over HTTPS; only a hash of the session token is stored.
- Passwords are hashed with scrypt and a per-user salt; failed sign-ins are rate-limited with the same message for
  unknown emails and wrong passwords.
- Responses carry a Content-Security-Policy that keeps everything on the console's own origin (`default-src 'self'`,
  `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`;
  inline scripts and styles are allowed because Next.js hydration and the static docs pages need them), plus
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` and a
  `Permissions-Policy` that turns off camera, microphone and geolocation. HSTS is left to the load balancer or proxy
  that terminates TLS; see [Deploy the console](deploy.md#protecting-the-console-itself).

## Outbound requests

Every URL that someone configures — integration URLs (Slack, webhooks, a Jira site), health-check URLs from the
`console:healthcheck` tag or the config file — goes through one guard (`src/lib/plugins/http.ts`):

- **http(s) only**; health-check URLs at most 2,048 characters and without credentials in them.
- **The host is resolved once and every address is checked.** If any address is refused, the request is refused. The
  connection is then made only to an address that was checked — the name is never looked up again — so a DNS server
  that answers with a harmless address first and the metadata address a moment later (DNS rebinding) can't slip
  through. TLS still verifies the server's certificate against the host name.
- **Always refused, even for admins:** link-local addresses (`169.254.0.0/16`, which holds EC2 instance metadata
  `169.254.169.254` and ECS task metadata `169.254.170.2`; `fe80::/10`), AWS's internal `fd00:ec2::/32` (IPv6
  instance metadata `fd00:ec2::254`), and "this host" (`0.0.0.0/8`, `::`) — in every spelling: plain, IPv4-mapped
  (`[::ffff:169.254.169.254]`, which a URL normalises to `[::ffff:a9fe:a9fe]`), IPv4-compatible (`[::169.254.169.254]`),
  IPv4-translated (`[::ffff:0:169.254.169.254]`) and NAT64 (`[64:ff9b::169.254.169.254]`), and numeric forms such as
  `http://2852039166/`.
- **Private addresses** (RFC 1918, loopback, `100.64.0.0/10`, unique-local IPv6) are allowed for integrations and health
  checks on purpose — a self-hosted Jira, an internal webhook receiver or an internal load balancer is normal — and
  refused by default for anything else the guard is used for.
- **Redirects** are never followed for integrations and health checks. Where the guard follows them, each hop is checked
  again, at most 3, and credentials are dropped when the origin changes.
- Errors never include the URL or headers: webhook URLs and tokens are secrets.

## Data

| Data | Where | How it's protected |
|---|---|---|
| AWS credentials | not in the console's database | the SDK credential chain (an ECS task role in production); another account is reached by switching into a role for an hour at a time. A console run locally (`AUTH_MODE=dev`) can save an IAM user's access key to `~/.aws/credentials`, owner-only, as `aws configure` does; it never shows or logs the secret |
| The console's external ID | the console's database | random, made once; admins only. Not a secret in AWS's sense: a role made from the console's CloudFormation template also requires the console's own login (`aws:PrincipalArn`) |
| Users, sessions, invite links, API tokens | the console's database | only hashes of session tokens, links and API tokens; passwords as scrypt hashes |
| Integration secrets (Slack webhooks, API tokens) | the console's database | encrypted with AES-256-GCM using `CONSOLE_SECRET_KEY`; never sent back to the browser |
| Agents' approval inputs (may contain variable values) | the console's database | sealed the same way; secret inputs shown as `(hidden)` |
| Environment variable values | not stored | read from AWS only on an explicit, role-checked, audited reveal or edit; discovery reads plain values on the server only to find hostnames |
| SSO subject of each account | the console's database | the provider's `sub`, used only to check sign-ins; never shown or returned by an API |
| Audit log | the console's database | kept until you delete it; readable by every signed-in person |

## Audit log

Every change writes an **intent** row before AWS is called and a **result** row after; if the intent can't be written
the change is refused. The log records who (and through which token, or who approved it), when, from which address,
the reason, and parameters as names, ids and counts — never variable values or user data. A one-off task's command
is recorded in full (up to 2,000 characters), so don't put secrets in commands. It also records
reveals (which names), sign-ins and failed sign-ins, user and token management, integration changes, tickets, and
approval decisions: `approval.approve` is written before the approved operation runs (if it can't be, the approval is
refused), `approval.reject` for rejections. Open it under **Audit**, or with the `audit.recent` operation.

Integration changes and tickets follow the same rule: saving or deleting an integration, and filing a ticket, write
their intent before the change is saved or the tracker is called. A ticket's result is *ok* (the tracker answered with
the ticket), *error* (it refused) or *unknown* — the request left but no answer came back, so check the tracker before
filing again.

On Postgres the console's database connections have timeouts (5 s to connect, 15 s per query and statement), so a
stuck database refuses changes quickly — and a change whose intent can't be written is refused — instead of hanging.

## Deploy it safely

1. **Keep it private.** Private subnets, a security group that admits port 3000 only from your load balancer, HTTPS
   (with HSTS) at the load balancer, `CONSOLE_PUBLIC_URL` set to the `https://` address, and
   `CONSOLE_TRUSTED_PROXIES` set to the number of proxies in front.
2. **Use your SSO.** `AUTH_MODE=session` with OIDC (or `AUTH_MODE=alb`), invites or `AUTH_ALLOWED_DOMAINS` with the
   `viewer` default, and `AUTH_PASSWORD_LOGIN=false` once admins can sign in with SSO.
3. **Choose the policy per account.** The read-only policy where you only want visibility (for example production
   accounts), the full policy or selected statements elsewhere. Fill in `CONSOLE_CLUSTER` and `CONSOLE_SERVICE` so the
   IAM deny protects the console's own service.
4. **Narrow what you grant.** Scope `SecretValues` to your parameter paths and secrets, `EnvironmentFiles` to your
   env-file bucket, `ServiceActions` to named clusters, and `PassTaskRolesToNewRevisions` to your services' task
   roles: as shipped it may pass any role that trusts ECS tasks (see
   [Connect AWS](connect-aws.md#narrowing-it-further)). Keep the `Never…` denies, and set
   `provisioning.allowedImageRegistries` to your own registry so copies and image deploys can't run images from
   elsewhere. The generated `Inventory…` statements use `"Resource": "*"`; narrow the ones you use
   ([Permissions setup](permissions.md#narrowing-further)).
5. **Tell it who it is.** Set `CONSOLE_SELF` (cluster/task family) on ECS. On plain EC2, set `CONSOLE_SELF_INSTANCE`
   and tag the instance (and its Auto Scaling group, if any) `console:self=true`.
6. **Mark production as protected.** Check **Settings → Environments**; tag clusters `console:protected=true` where
   the name doesn't say so.
7. **Handle secrets like secrets.** `DATABASE_URL`, `CONSOLE_SECRET_KEY` (at least 32 random characters) and tokens in
   SSM Parameter Store or Secrets Manager, never in the image. Back up `CONSOLE_SECRET_KEY`.
8. **Turn off what you don't use.** `CONSOLE_API_TOKENS=false` without agents; `provisioning.enabled: false` (and no
   create & scale statements) without create & scale.
9. **Ask for a second approver.** Once more than one person decides agents' requests, set
   `CONSOLE_APPROVALS_TWO_PERSON=true`: nobody can then approve what their own tokens asked for.
10. **Review regularly.** The audit log, **Settings → Users & roles**, and everyone's tokens (**Automation → API
   tokens → Everyone**, for admins).

## Hardening checklist

- [ ] Reachable only through the load balancer, over HTTPS, with HSTS added by the load balancer, CloudFront or your
      proxy.
- [ ] `CONSOLE_PUBLIC_URL` is the exact `https://` address people use.
- [ ] `AUTH_MODE` is `session` or `alb` (never `dev` anywhere but a laptop); `OIDC_REQUIRE_EMAIL_VERIFIED` left on
      (with Entra ID, the `xms_edov` optional claim added).
- [ ] Sign-in through SSO; password sign-in off, or only for a break-glass admin.
- [ ] Roles given sparingly: *viewer* by default, *operator* and *admin* by name.
- [ ] The task role has only the statements you use; `CONSOLE_CLUSTER` and `CONSOLE_SERVICE` are filled in, and the
      `Never…` denies name your console's task family and role.
- [ ] `SecretValues`, `EnvironmentFiles`, `ServiceActions` and `PassTaskRolesToNewRevisions` scoped to your resources;
      S3 file actions granted only on the buckets you mean ([Permissions setup](permissions.md#s3-file-actions)).
- [ ] If the console runs on EC2, its instance — and Auto Scaling group, if any — is tagged `console:self=true`, so
      the `NeverStopOrScaleTheConsolesOwnHost` deny covers it (and `CONSOLE_SELF_INSTANCE` is set on plain EC2).
- [ ] `provisioning.allowedImageRegistries` lists only your own registries (or create & scale is off).
- [ ] `CONSOLE_SELF` is set, and `CONSOLE_TRUSTED_PROXIES` matches the proxies in front (`1` for an ALB, `2` for
      CloudFront → ALB).
- [ ] Every production-like environment shows as protected, and `inventory.unassignedProtected` is left at `true`
      unless every resource on the cloud map has an environment.
- [ ] Hosts and databases tagged `console:power=allow` only where stopping them is acceptable.
- [ ] `CONSOLE_SECRET_KEY` is set, random, stored as a secret and backed up.
- [ ] `CONSOLE_API_TOKENS=false` unless you use agents; otherwise tokens in *propose* or *read* mode with an expiry,
      and `CONSOLE_APPROVALS_TWO_PERSON=true` if more than one person approves.
- [ ] The console's own log group has a retention period; its database is backed up.
