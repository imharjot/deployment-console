# Deploy the console

Run the console for your team as an ECS Fargate service in the account it watches, behind your load balancer with
HTTPS and single sign-on. This page is for the platform engineer setting it up; plan about an hour.

The console is one container (UI and API together) listening on port **3000**. Apart from its database it keeps no
state you need to back up, so you can replace the task at any time.

## The setup at a glance

```
people ──HTTPS──▶ Application Load Balancer (your certificate)
                    │  rule: host console.example.com
                    ▼
                  target group, port 3000, health check /api/healthz
                    │
                    ▼
                  ECS Fargate service "deployment-console"
                  (1 task, private subnets)
                    ├─ task role ─▶ the console's IAM policy
                    ├─ secrets from SSM Parameter Store
                    │  (DATABASE_URL, CONSOLE_SECRET_KEY, GITHUB_TOKEN)
                    └─ Postgres (for example Amazon RDS):
                       users, sessions, audit log, settings
```

## Before you start

- A VPC with private subnets that can reach AWS APIs (through a NAT gateway, or VPC endpoints plus a NAT gateway for
  GitHub, your integrations and Cost Explorer).
- An Application Load Balancer with an HTTPS listener, an ACM certificate for the console's host name, and DNS for it.
- A Postgres database the task can reach (Amazon RDS or any other).
- An ECS cluster to run the console in. It may be one the console also shows as an environment.
- Docker and the AWS CLI v2 on your machine, with permission to create IAM roles, ECR repositories and ECS services.
- Optional: an OIDC application in your identity provider (Google, Okta, Microsoft Entra ID, Auth0, Keycloak…).

The examples use account `123456789012`, region `eu-west-1`, cluster `acme-tools` and host `console.example.com`.

## Four decisions first

| Decision | Options | Recommendation |
|---|---|---|
| Database | **Postgres** (`DATABASE_URL`), or **SQLite** on a persistent local disk | Postgres on Fargate: tasks have no persistent disk. SQLite suits a single container on a VM (see [Docker on any host](#docker-on-any-host)). |
| Sign-in | **The console signs people in** (`AUTH_MODE=session`: passwords and/or OIDC SSO), or **the load balancer does** (`AUTH_MODE=alb` with an `authenticate-oidc` action) | `session` with OIDC, unless you already use ALB authentication. |
| IAM policy | **Read-only** or **full** (or the statements you pick) | Read-only first; add features later. See [Connect AWS](connect-aws.md#step-5-turn-on-more-one-feature-at-a-time). |
| CPU | **ARM64** (Graviton) or **x86_64**: the image from step 1 runs on both | ARM64, about 20 % cheaper than x86 for the same size; the template asks for it (`cpuArchitecture`, step 6). |

## Step 1: Build and push the image

```bash
export AWS_REGION=eu-west-1 ACCOUNT_ID=123456789012
export REPO=$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/deployment-console TAG=$(git rev-parse --short HEAD)

aws ecr create-repository --repository-name deployment-console
aws ecr get-login-password | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
docker buildx create --use --name multiarch   # once per machine: a builder that makes images for both CPUs
docker buildx build --platform linux/arm64,linux/amd64 --build-arg VERSION=$TAG -t $REPO:$TAG --push .
```

- **One tag, both CPUs.** The image holds an `arm64` and an `amd64` build, so the task definition can ask for `ARM64`
  (Graviton) or `X86_64` (step 6), and switching later needs no rebuild. The machine builds its own CPU natively and
  the other through emulation (Docker Desktop includes it; on Linux, install QEMU's binfmt handlers), so the build
  takes longer than a single one.
- **Only one CPU?** Build just that one, and name the same one in the task definition:
  `docker build --platform linux/arm64 --build-arg VERSION=$TAG -t $REPO:$TAG .` (or `linux/amd64`), then
  `docker push $REPO:$TAG`.
- `VERSION` is shown in the sidebar, so you can tell which build is running.

## Step 2: Prepare the database

Create a database and a user for the console, for example `console`. The console creates and migrates its tables on
start. Your connection string looks like:

```
postgres://console:PASSWORD@acme-db.abc123.eu-west-1.rds.amazonaws.com:5432/console?sslmode=no-verify
```

About TLS: Amazon RDS for PostgreSQL 15 and newer requires encrypted connections by default. `sslmode=no-verify`
encrypts the connection without checking the server's certificate. To check it too, add the
[RDS certificate bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html) to your image
and use `?sslmode=verify-full&sslrootcert=/app/rds-ca.pem`; plain `sslmode=require` verifies against Node.js's
built-in certificate authorities, which don't include the RDS one.

## Step 3: Store the secrets

```bash
aws ssm put-parameter --name /deployment-console/DATABASE_URL --type SecureString \
  --value 'postgres://console:PASSWORD@acme-db.abc123.eu-west-1.rds.amazonaws.com:5432/console?sslmode=no-verify'
aws ssm put-parameter --name /deployment-console/CONSOLE_SECRET_KEY --type SecureString \
  --value "$(openssl rand -base64 48)"
aws ssm put-parameter --name /deployment-console/GITHUB_TOKEN --type SecureString --value 'github_pat_…'
```

- **`CONSOLE_SECRET_KEY`** (at least 32 characters) encrypts integration secrets and agents' pending approval inputs in
  the database, and protects the SSO sign-in flow. It is required with Postgres: without it (or with a shorter one)
  every request answers `500` and the health check fails. Keep it stable and backed up: with a different key, saved
  integration secrets and pending approvals can no longer be read.
- **`GITHUB_TOKEN`** is optional ([GitHub & CI](github.md) lists the scopes). Not using it? Remove it from the task
  definition's `secrets` too, or the task won't start.
- Using OIDC? Store the client secret the same way (`/deployment-console/OIDC_CLIENT_SECRET`) and add it to `secrets`.

## Step 4: Create the two IAM roles

Both roles are assumed by ECS tasks:

```bash
cat > ecs-tasks-trust.json <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": { "Service": "ecs-tasks.amazonaws.com" }, "Action": "sts:AssumeRole" }] }
EOF
```

**The execution role** lets ECS pull the image, write logs and read the secrets when the task starts:

```bash
aws iam create-role --role-name deployment-console-exec --assume-role-policy-document file://ecs-tasks-trust.json
aws iam attach-role-policy --role-name deployment-console-exec \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name deployment-console-exec --policy-name read-console-secrets \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ssm:GetParameters","Resource":"arn:aws:ssm:eu-west-1:123456789012:parameter/deployment-console/*"}]}'
```

If your parameters use a customer-managed KMS key rather than the default `aws/ssm` key, also allow `kms:Decrypt` on
that key.

**The task role** is what the console acts as. Attach the policy you created in [Connect AWS](connect-aws.md):

```bash
aws iam create-role --role-name deployment-console-task --assume-role-policy-document file://ecs-tasks-trust.json
aws iam attach-role-policy --role-name deployment-console-task \
  --policy-arn arn:aws:iam::123456789012:policy/deployment-console-readonly
```

With the full policy, set its `CONSOLE_CLUSTER` and `CONSOLE_SERVICE` placeholders to `acme-tools` and
`deployment-console`, so the console can never update or delete itself. Its other three denies refer to the task
family `deployment-console` and the role `deployment-console-task`; if you name them differently, change those
statements too.

**To connect other accounts** with the console's CloudFormation template ([Connect AWS](connect-aws.md#connect-an-account-with-cloudformation)),
let the task role switch into the roles it creates, and leave `CONSOLE_SOURCE` out of the task definition (step 6), so
an admin can pick **Another AWS account, with CloudFormation** in Settings:

```bash
aws iam put-role-policy --role-name deployment-console-task --policy-name switch-into-connected-accounts \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Resource":"arn:aws:iam::*:role/deployment-console-access"}]}'
```

## Step 5: Create the log group

```bash
aws logs create-log-group --log-group-name /ecs/deployment-console
aws logs put-retention-policy --log-group-name /ecs/deployment-console --retention-in-days 30
```

## Step 6: Register the task definition

Start from `infra/task-definition.json` and change:

| Field | Change to |
|---|---|
| `ACCOUNT_ID`, `REGION` | your account id and region (roles, image, secrets, logs) |
| `image` | `…/deployment-console:<TAG>` from step 1 instead of `:latest` |
| `cpuArchitecture` (in `runtimePlatform`) | `ARM64` as shipped (Graviton), or `X86_64`; the image from step 1 runs on either |
| `CONSOLE_PUBLIC_URL` | your console's URL, for example `https://console.example.com` |
| `GITHUB_OWNER` | your GitHub organisation or user, or remove it |
| `CONSOLE_CONFIG` (not in the template) | add it only if you ship a `console.config.json` in the image or on a volume (see below). If it points at a missing file, **Settings → Environments** shows an error. |
| `CONSOLE_SELF` | replace `CONSOLE_CLUSTER` with your cluster, e.g. `acme-tools/deployment-console` (cluster/task family). The console also finds itself through the ECS task metadata endpoint, but with this set it never has to refuse changes while that endpoint is unavailable. |
| `CONSOLE_TRUSTED_PROXIES` (not in the template) | leave it out behind one ALB (the default, `1`); add it with the value `2` if CloudFront sits in front of the ALB |
| `secrets` | remove `GITHUB_TOKEN` if you don't use it; add `OIDC_CLIENT_SECRET` if you do |
| role names | only if you named the roles differently |

Add your sign-in settings to `environment` (step 9), then register it:

```bash
aws ecs register-task-definition --cli-input-json file://task-definition.json
```

**Shipping a config file.** The image doesn't include a `console.config.json`. Build a small image on top of it, for
example:

```dockerfile
FROM 123456789012.dkr.ecr.eu-west-1.amazonaws.com/deployment-console:TAG
COPY console.config.json /app/config/console.config.json
```

Or mount the file from a volume. See [Configuration](configuration.md).

## Step 7: Route traffic from the load balancer

Create a target group and a listener rule for the console's host name:

```bash
aws elbv2 create-target-group --name deployment-console --protocol HTTP --port 3000 --target-type ip \
  --vpc-id vpc-0abc… --health-check-path /api/healthz --matcher HttpCode=200
aws elbv2 create-rule --listener-arn arn:aws:elasticloadbalancing:…:listener/app/acme-alb/… --priority 50 \
  --conditions Field=host-header,Values=console.example.com \
  --actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:…:targetgroup/deployment-console/…
```

Create a security group for the console that allows port 3000 **only from the load balancer's security group**.
Point `console.example.com` at the load balancer in DNS.

## Step 8: Create the service

```bash
aws ecs create-service --cluster acme-tools --service-name deployment-console \
  --task-definition deployment-console --desired-count 1 --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-0aaa…,subnet-0bbb…],securityGroups=[sg-0console…],assignPublicIp=DISABLED}' \
  --load-balancers targetGroupArn=arn:aws:elasticloadbalancing:…:targetgroup/deployment-console/…,containerName=deployment-console,containerPort=3000 \
  --deployment-configuration 'deploymentCircuitBreaker={enable=true,rollback=true}'
```

Run **exactly one task**. Action locks, notifications, sign-in rate limits and uptime history live in the process, so
a second task would send duplicate notifications and couldn't see the first one's locks.

After a minute or two the target turns healthy. `https://console.example.com` should show the setup page.

If it never turns healthy and the log says `health check failed: misconfigured`, the same log line names the problem:
an invalid `AUTH_MODE`, or a missing or too short `CONSOLE_SECRET_KEY`. `/api/healthz` fails on purpose then, so ECS
never counts the task as healthy, and during an upgrade the circuit breaker rolls back to the working revision instead
of keeping a console that answers every request with an error.

## Step 9: Sign-in

### Option A: the console signs people in (recommended)

Add to the task definition's `environment`:

| Name | Value |
|---|---|
| `AUTH_MODE` | `session` (already set) |
| `CONSOLE_PUBLIC_URL` | `https://console.example.com` |
| `OIDC_ISSUER` | your provider's issuer URL, for example `https://accounts.google.com` |
| `OIDC_CLIENT_ID` | the client id of the app you registered |
| `OIDC_LABEL` | the button text, for example `Sign in with Google` |
| `OIDC_REQUIRE_EMAIL_VERIFIED` | leave `true`; with Entra ID add the `xms_edov` optional claim ([Sign-in & roles](auth.md)) |
| `AUTH_ALLOWED_DOMAINS` | optional: your email domain, so colleagues can sign in without an invite (as `viewer`) |

Register the redirect URI **`https://console.example.com/api/auth/oidc/callback`** with your provider. Details and
every option: [Sign-in & roles](auth.md).

### Option B: the load balancer signs people in

Put an `authenticate-oidc` action before the forward action in the listener rule, then set `AUTH_MODE=alb` and
`ALB_ARN` (the load balancer's ARN — without it every request is refused). The console verifies the signed header
the load balancer adds. If agents will use API tokens, add the extra listener rule described in
[Agents & API](automation.md#alb-sign-in).

## Step 10: Create the first admin

With no users yet, the console prints a one-time setup token (valid 24 hours) to its log, and a new one at every start
until the first admin exists. Find it:

```bash
aws logs filter-log-events --log-group-name /ecs/deployment-console \
  --filter-pattern '"setup token"' --query 'events[].message' --output text
```

Open `https://console.example.com/setup`, paste the token and create your admin account. In `alb` mode the setup page
asks for no password, and the email must be the one the load balancer signed you in with.

Alternatively, set `CONSOLE_ADMIN_EMAIL` (and `CONSOLE_ADMIN_PASSWORD`, at least 10 characters) on the task before
its first start. Without a password the admin is created only if OIDC is configured or `AUTH_MODE=alb`, so that person
can sign in; otherwise the console logs why and prints a setup token instead.

Then [invite your team](auth.md#invite-your-team).

## Protecting the console itself

- **It never acts on its own service**, reveals its variables or copies it. On ECS it recognises itself from the task
  metadata endpoint, `CONSOLE_SELF` (set it, as in step 6) or the service tag `console:self=true`. If it can't tell
  which service is its own, it refuses every change until it can. The full IAM policy's `Never…` denies block it at
  the AWS level too: no update or delete of its own service, no task or service from its task family, nothing else
  can be given its role, and nothing tagged `console:self=true` (tag the EC2 host it runs on, if any) can be stopped,
  rebooted, terminated or scaled.
- **Only the load balancer can reach it**: private subnets, and a security group that admits port 3000 from the load
  balancer only. The load balancer appends the client's address to `X-Forwarded-For`, which the audit log and the
  per-address sign-in and token throttles use. `CONSOLE_TRUSTED_PROXIES` says how many proxies to trust: `1` (the
  default) for an ALB, `2` for CloudFront in front of an ALB.
- **Changes come only from its own address.** With `CONSOLE_PUBLIC_URL` set, the console accepts sign-ins and other
  changes (every non-GET request) only when the browser's `Origin` is exactly that address.
- **Browser security headers.** The console sends a Content-Security-Policy, `X-Frame-Options: DENY` and more itself
  (see [Security model](security.md#requests)). HSTS belongs to whatever terminates TLS: an ALB sends it only after
  you turn on response header modification on the HTTPS listener (the attribute
  `routing.http.response.strict_transport_security.header_value`, for example `max-age=31536000; includeSubDomains`);
  with CloudFront, use a response headers policy; a reverse proxy can add the header itself.
- **Its role is powerful.** Everyone who can sign in acts through it, within their console role. Keep sign-in to your
  SSO, and grant the task role only the statements you use.
- More in the [Security model](security.md), including a hardening checklist.

## Upgrades

The console never restarts or rolls back its own service, so upgrade it the way you deploy other services: build and
push a new image (step 1), register a new task-definition revision with it, and update the service:

```bash
aws ecs update-service --cluster acme-tools --service deployment-console --task-definition deployment-console
```

Database migrations run on start. On SIGTERM the console stops accepting changes and lets the ones in flight finish
(up to 25 seconds) before it exits: the image sets `NEXT_MANUAL_SIG_HANDLE=true` and the template's `stopTimeout` is 30
seconds — keep both if you write your own.

`examples/github-actions/deploy-ecs.yml` is a deploy workflow for GitHub Actions
that you can adapt; it is written for app services, so point its family and container name at `deployment-console`.

## Backups

- **Postgres**: your usual database backups (for example RDS automated snapshots).
- **SQLite**: the whole data directory (`/app/data` in the image), which holds `console.db` and, unless you set
  `CONSOLE_SECRET_KEY`, the generated `secret.key`.
- Keep a copy of `CONSOLE_SECRET_KEY` wherever you keep secrets.

## Docker on any host

The same image runs anywhere Docker does. Build it, then run it with SQLite on a named volume:

```bash
docker build -t deployment-console .
docker run -d --name deployment-console --restart unless-stopped -p 3000:3000 \
  -e CONSOLE_SOURCE=aws -e AWS_REGION=eu-west-1 \
  -e CONSOLE_PUBLIC_URL=https://console.example.com \
  -e GITHUB_TOKEN=github_pat_… -e GITHUB_OWNER=acme \
  -v console-data:/app/data \
  deployment-console
```

- **Credentials**: give the host an instance profile with the console's policy, or pass AWS credentials. On EC2 with
  IMDSv2, set the instance's metadata hop limit to 2, or containers can't reach the instance profile.
- **HTTPS**: put a TLS-terminating proxy in front and keep port 3000 private. The proxy should send
  `X-Forwarded-Proto` and append `X-Forwarded-For` (the default `CONSOLE_TRUSTED_PROXIES=1` trusts one such proxy),
  and `CONSOLE_PUBLIC_URL` should be the `https://` address. Running without any proxy, for a quick trial? Set
  `CONSOLE_TRUSTED_PROXIES=0`, as the repository's `docker-compose.yml` does, so clients can't choose the address the
  console sees; per-address throttles are then off, while per-email and per-token limits still apply.
- **SQLite needs a local disk.** Keep one container per data volume, and prefer a local disk to a network file system:
  SQLite's write-ahead log doesn't work well over NFS or EFS.
- **First admin**: `docker logs deployment-console 2>&1 | grep "setup token"` (restarting the container prints a new
  token while there are no users), or set `CONSOLE_ADMIN_EMAIL` and `CONSOLE_ADMIN_PASSWORD`.

## Checklist

- [ ] HTTPS only, with HSTS added at the load balancer, CloudFront or your proxy, and `CONSOLE_PUBLIC_URL` is the
      `https://` address.
- [ ] The service runs one task, in private subnets, reachable only from the load balancer.
- [ ] `CONSOLE_SELF` names your cluster, and `CONSOLE_TRUSTED_PROXIES` matches what's in front (`1` for an ALB, `2`
      for CloudFront → ALB).
- [ ] Sign-in through your SSO (or invites); `AUTH_PASSWORD_LOGIN=false` once admins can sign in with SSO.
- [ ] The task role has only the statements you use, with `CONSOLE_CLUSTER` and `CONSOLE_SERVICE` filled in.
- [ ] `DATABASE_URL` and `CONSOLE_SECRET_KEY` are in SSM; the key is backed up.
- [ ] Log retention is set on `/ecs/deployment-console`.
- [ ] `CONSOLE_API_TOKENS=false` if nobody will use agents or scripts.
