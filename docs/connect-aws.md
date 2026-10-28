# Connect AWS

Point the console at your own AWS account. Start with the **read-only policy**: the console can see everything and
change nothing. Once you trust what it shows, add write permissions one feature at a time.

This page is for whoever looks after the AWS account. It takes about ten minutes.

**The quickest path:** start the console (even with no permissions yet), open **Settings → AWS permissions**, copy the
AWS CLI commands from its policy builder and run them. [Permissions setup](permissions.md) walks through that, the
cloud map's services (Lambda, SQS, S3, CloudFront, Route 53, Cloudflare, EKS…) and what each class of permission
risks. This page covers the same steps by hand, and the ECS console's own statements in detail.

## Before you start

- ECS clusters in one AWS account. One console covers one account and the regions you give it (Settings → AWS
  connection, `CONSOLE_REGIONS` or `inventory.regions` in the config file; the home region first —
  [Configuration](configuration.md)).
- Permission to create an IAM policy and a role.
- The console running on your machine ([Quickstart](quickstart.md), option A) or anywhere else.
- The AWS CLI v2 for the commands below. You can do the same in the AWS console if you prefer.

The examples use the account `123456789012` and the region `eu-west-1`. Use your own.

## Step 1: Create the read-only policy

The policy is in the repository at `infra/iam-policy-readonly.json`. It covers the ECS console (`DiscoverAndRead`,
`CostsRead`, `SimulateOwnPermissions`) and every cloud-map service (`Inventory<Service>Read`). Settings → AWS permissions
builds the same document, optionally for fewer services. Its only placeholder is `ACCOUNT_ID`, in
`SimulateOwnPermissions`.

With every service it is larger than the 6,144 characters AWS allows in one managed policy, so create it in parts
(today two, plan for three as services are added) and attach every part:

```bash
npm run iam:policy -- --print read --set ACCOUNT_ID=123456789012 \
  --principal arn:aws:iam::123456789012:role/deployment-console-readonly --out ./policy
#   ./policy/deployment-console-readonly-1.json, -2.json, …
for f in ./policy/deployment-console-readonly-*.json; do
  aws iam create-policy --policy-name "$(basename "$f" .json)" --policy-document "file://$f"
done
```

`--principal` names the identity the console runs as: it simulates its own policy (`iam:SimulatePrincipalPolicy`) to
know which buttons AWS would refuse, and `SimulateOwnPermissions` allows that for the identity it names only. Without
`--principal` it names the ECS task role of `infra/task-definition.json` (`deployment-console-task`); the example
above names the local role of step 2. An IAM user instead? `--principal arn:aws:iam::123456789012:user/<name>`.

## Step 2: Give the console credentials with that policy

The console uses the standard AWS credential chain: an ECS task role, an EC2 instance profile, `AWS_PROFILE`, or
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. It stores no credentials itself.

- **On ECS** (a team deployment), attach the policy to the console's task role. [Deploy the console](deploy.md)
  shows how. No long-lived keys needed.
- **On your machine**, the safest way to try it is a role that has only this policy, used through a profile:

```bash
aws iam create-role --role-name deployment-console-readonly \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::123456789012:root"},"Action":"sts:AssumeRole"}]}'
for f in ./policy/deployment-console-readonly-*.json; do
  aws iam attach-role-policy --role-name deployment-console-readonly \
    --policy-arn "arn:aws:iam::123456789012:policy/$(basename "$f" .json)"
done
```

The trust policy above lets any identity in the account that is allowed `sts:AssumeRole` use the role. Naming yourself
instead (`"Principal":{"AWS":"arn:aws:iam::123456789012:user/<you>"}`, or your SSO role's ARN) keeps it to you.

Then add a profile to `~/.aws/config` that assumes it with your usual credentials:

```ini
[profile console-readonly]
role_arn = arn:aws:iam::123456789012:role/deployment-console-readonly
source_profile = default
region = eu-west-1
```

Using AWS IAM Identity Center (SSO)? Use your SSO profile as `source_profile`, and run `aws sso login` before you
start the console.

## Step 3: Point the console at your account

Open **Settings → AWS connection** (admins), then:

1. **Account:** choose **Your AWS account**.
2. **How it signs in:** choose **AWS CLI profile on this computer** and pick `console-readonly`. The list shows the
   profiles in this machine's `~/.aws/config` and `~/.aws/credentials`, each with its kind (read from the setting names,
   never their values), and says how long the chosen one's login lasts. The console's database never holds keys.
3. Choose **Test connection**. It shows the account and identity AWS signed you in as, and how many ECS clusters
   each enabled region has, then suggests the region with most of them as the home region.
4. Pick the **home region** (the region your ECS clusters run in), and whether to read **all enabled regions** too.
5. Choose **Save and switch**. The console switches at once, no restart: the next request reads your account.

The three ways, by where the console runs, and when each needs signing in again:

| Choice | Use it when | How long it lasts |
|---|---|---|
| **AWS CLI profile on this computer** | the console runs on your laptop | an access key: until it's deleted; `aws login` or IAM Identity Center (SSO): until that session ends, then run `aws login --profile …` or `aws sso login --profile …` again; a profile that switches into a role: renewed every hour, as long as its source profile works |
| **Another AWS account, with CloudFormation** | you want read-only access to an account, no keys ([below](#connect-an-account-with-cloudformation)) | renewed every hour on its own, as long as the machine's own AWS login works |
| **This server's AWS role** | the console runs on AWS (ECS task role, EC2 instance profile) | AWS renews it; nothing to sign in again |

- **AWS CLI profile → Add a profile with an access key** appears on a console run locally by one person
  (`AUTH_MODE=dev`). AWS checks the key first; it's then saved to `~/.aws/credentials` (or `AWS_SHARED_CREDENTIALS_FILE`)
  the way `aws configure` saves it, owner-only, so the AWS CLI can use it too. Only an IAM user's long-term key (`AKIA…`)
  is taken, never a root user's, and an existing profile is never overwritten; the console never shows the secret again,
  and the audit log names only the profile and the identity. Use an IAM user that holds only the console's policy.
- **This server's AWS role** is the AWS SDK's default credentials: on a laptop, that's the default profile. The page
  shows what it detects, read from the machine's credentials each time.
- **Already have a role?** Under the CloudFormation choice, enter its ARN (`arn:aws:iam::123456789012:role/name`, not a
  user's) and an external ID if its trust policy asks for one. Its trust policy must name the machine's own AWS login,
  which needs `sts:AssumeRole` on it; `sts:AssumeRole` belongs to whoever switches, so the generated policies don't
  include it.

### Connect an account with CloudFormation

The way monitoring and security products reach their customers' accounts, from the page, in a couple of minutes: no
keys change hands, each session lasts an hour, every use shows in the account's CloudTrail, and deleting the stack cuts
the console off.

1. **How it signs in → Another AWS account, with CloudFormation → Download setup file.** The console fills in the
   template ([`infra/connect-aws-role.json`](../infra/connect-aws-role.json), generated from the read-only policy) with
   its own login and its **external ID**: a random value made once per console, kept with its settings, and shown to
   admins only (under **What's in the setup file?**).
2. Sign in to the account to connect and open CloudFormation (**Open CloudFormation** on the page; it shows each screen,
   drawn, with what to do and why):
   - **Create stack:** choose **Upload a template file** (it defaults to Amazon S3 URL; the file is on your computer),
     then **Choose file** and select it. Next.
   - **Specify stack details:** type a stack name, such as `deployment-console-access`, and keep the parameters the
     console filled in. Next.
   - **Configure stack options** and **Review:** leave the options, tick **I acknowledge that AWS CloudFormation might
     create IAM resources with custom names** (the stack creates one IAM role) and **Submit**.

   Or with the AWS CLI, from the file's folder (**Copy commands** on the page):

   ```bash
   aws cloudformation deploy --template-file deployment-console-access.json --stack-name deployment-console-access --capabilities CAPABILITY_NAMED_IAM
   ```

3. When the stack shows `CREATE_COMPLETE`, copy **RoleArn** from its **Outputs** into the page, then **Test
   connection** and **Save and switch**.

The stack creates the role `deployment-console-access` (change **RoleName** to make another) with the read-only
policy, as managed policies sized for IAM's quota. Its trust policy lets in only the console's own login, named by
`aws:PrincipalArn` under any path, and only with the console's external ID: a login shared by several consoles can't be
pointed at a role made for another. The console's login needs `sts:AssumeRole` on the role. An IAM user with broad
rights has it; on ECS, add it to the task role (Deploy the console, step 4). If the console later runs as another
login (moved from a laptop to ECS, say), download the template again and update the stack with it.

A machine with no AWS login at all (a host outside AWS, with no keys or profiles) says so on the page: on AWS, give the
console a task role or an instance profile; anywhere else, set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` where it
runs, for an IAM user that holds the console's policy. Keys in the environment decide the sign-in, so the page then
offers no other.

When the account or the home region changes, the console forgets what it learned about the previous one, so it can't
act on the new one's same-named services: remembered task counts ("Start" after "Stop"), state history, the costs
snapshot, pending host launches, and approvals nobody has used; the audit log records it, and keeps everything else, as do
notes. A switch waits for the changes this console has in flight, and is refused while any change or agent run is still
going. Pages open before a switch can't act on the new account: their writes are refused until they are reloaded.

**Pinning it in the environment instead** (a team deployment, or Docker Compose): set the variables where the console
runs, and they decide that part; Settings shows it read-only and names the variable. `CONSOLE_SOURCE=aws` pins the
sign-in as well: on ECS the console then signs in as its task role, and nobody can pick another identity in Settings.

```bash
CONSOLE_SOURCE=aws          # "mock" is the demo; any other value is an error
AWS_REGION=eu-west-1        # the region your ECS clusters run in
AWS_PROFILE=console-readonly
```

`AWS_REGION` falls back to `AWS_DEFAULT_REGION`. Environment changes need a restart (stop the server with Ctrl-C and run
`npm run dev` again). With Docker Compose, uncomment the `~/.aws` volume in `docker-compose.yml` either way: Settings'
profile list reads the mounted files.

## Step 4: Check what it found

Open **Settings → Environments**. You should see one card per ECS cluster, with its services, and the **Mock data**
banner is gone from the overview. If AWS refused a call, the error is shown at the top of that page and names the
missing permission, for example `AccessDeniedException: … ecs:ListClusters`.

Look at three things:

1. **Is each environment protected or not?** Clusters whose names include the word `prod`, `production`, `prd` or
   `live` (as in `acme-prod`) are protected (production-like) automatically. Mark any other with the cluster tag
   `console:protected=true`.
2. **Does every service have logs?** A service whose main container doesn't use the `awslogs` driver has no Logs tab.
3. **Is anything under "Not attributed to any environment"?** Databases and caches the console couldn't place. Tag
   them or list them in the config file.

[How discovery works](discovery.md) explains every rule and the tags that fine-tune it.

Then open **Settings → AWS permissions** for the cloud map: each service says **Working** with what it found, **Missing
permissions** with the actions AWS refused, or **Not set up** with the reason.

**Every other resource (the catch-all).** Services without a dedicated reader come from AWS Resource Explorer
(`resource-explorer-2:ListIndexes` and `resource-explorer-2:Search`, in the generated `InventoryCatchallRead`). Resource
Explorer must be turned on: an index in each region, or one aggregator index, and a default view. Without it the
console falls back to the Tagging API (`tag:GetResources`), which only sees tagged resources, and notes that on the map.
AWS Config and Cloud Control are opt-in (`inventory.catchAll`); listing a type through Cloud Control also needs that
type's own read permissions (its *handler permissions*, for example `glue:GetDatabases` for `AWS::Glue::Database`) —
see [Permissions setup](permissions.md#cloud-control-types).

With the read-only policy the console changes nothing in your account; the only thing it writes is its own database.
The action buttons are there, but AWS refuses them (and the console shows AWS's error) until you add the permissions.

## Step 5: Turn on more, one feature at a time

Every write permission lives in `infra/iam-policy.json`, in statements named after what they allow. Take the ones you
want:

| Feature | Statements (`Sid`) in `infra/iam-policy.json` | What the console can then do | Details |
|---|---|---|---|
| Restart, stop/start, switch revision | `ServiceActions` (and keep the `Never…` denies) | update any ECS service in the region (never its own) | [Actions](actions.md) |
| Start/stop hosts and databases | `PowerNonProtectedHostsAndDatabases` | start, stop and reboot EC2 instances, and start and stop RDS instances, that you tagged `console:power=allow` — for the cloud map's EC2 actions too | [Actions](actions.md) |
| Reveal and edit environment variables | `EditVariablesNewRevision`, `PassTaskRolesToNewRevisions`, `SecretValues`, `SecretValuesKms`, `EnvironmentFiles` (plus `ServiceActions`) | read and write secret values and S3 env files, register task-definition revisions | [Environment variables](environment-variables.md) |
| Create & scale | `CreateServicesTaggedByTheConsole` through `DeleteOnlyConsoleCreatedSecurityGroups` (plus `ServiceActions`, `EditVariablesNewRevision` and `PassTaskRolesToNewRevisions`) | create services from an image or as copies, scale them, run one-off tasks, launch EC2 hosts; delete only what it created | [Create & scale](provisioning.md) |
| Connect services | `OpenSecurityGroupsMadeByTheConsole` through `FollowCloudMapOperations` (plus `ServiceActions`, `EditVariablesNewRevision` and `PassTaskRolesToNewRevisions`) | let one service reach another service, a database or a cache: a rule in the other side's security group (only groups it created or you tagged `console:connect=allow`), a variable with the address, ECS Service Connect between services | [Cloud map](cloud-map.md#connect-services) |
| Costs | `CostsRead` (already in the read-only policy) | read Cost Explorer | [Costs](costs.md) |
| Cloud map data reads and actions | `Inventory<Service>Sensitive`, `Inventory<Service>Write` (one pair per service) | read data behind audited actions; the map's actions (invalidate a CDN path, set desired capacity, purge a queue…). S3 file actions come from a hand-written statement instead: `EnvironmentFiles`, or one you add | [Supported services](services.md), [Permissions setup](permissions.md#7-add-write-permissions-one-feature-at-a-time) |

Each feature page shows its statements and what they risk. To use the whole file, replace its placeholders and create
the policy:

| Placeholder | Replace with |
|---|---|
| `REGION` | your region, for example `eu-west-1`. Reading more than one region? Use `*` instead: the console's own statements and the `kms:ViaService` conditions (`ssm.*.amazonaws.com` …) then hold in each of them — `npm run iam:policy -- --print full --regions eu-west-1,us-east-1` does this for you |
| `ACCOUNT_ID` | your 12-digit account id |
| `CONSOLE_CLUSTER`, `CONSOLE_SERVICE` | the cluster and service the console itself runs as, so it can never update or delete itself. Not on ECS in this account? Leave the statement as it is: it then matches nothing. |
| `deployment-console`, `deployment-console-task` (not placeholders) | the console's task-definition family and task role, as named in `infra/task-definition.json`. The denies `NeverRunTheConsolesTaskDefinition`, `NeverCreateAServiceFromTheConsole` and `NeverPassTheConsolesOwnRole`, and the `SimulateOwnPermissions` allow, use them: if you named yours differently, change them there too. |
| `ENV_FILES_BUCKET` | the S3 bucket holding your services' env files (`environmentFiles`). No env files? Delete the `EnvironmentFiles` statement (the map's S3 file actions then work only on buckets you grant yourself — see [S3 file actions](permissions.md#s3-file-actions)). |
| `CONSOLE_PARAM_PREFIX` | the SSM Parameter Store path holding the console's own settings, without the leading slash: `deployment-console` for the `/deployment-console/…` parameters of `infra/task-definition.json`. `NeverReadOrWriteTheConsolesOwnParameters` denies reading or writing them |
| `CONSOLE_SECRET_PREFIX` | the start of the console's own Secrets Manager secret names, for example `deployment-console/`. `NeverReadOrWriteTheConsolesOwnSecrets` denies reading or writing them. None? Use a prefix nothing else has |
| `CONSOLE_ENV_FILE` | the key of the console's own env file in `ENV_FILES_BUCKET`, for example `deployment-console/production.env` (`*` matches several). `NeverReadOrWriteTheConsolesOwnEnvFile` denies reading, writing or deleting it. None? Delete that statement |
| `console:self=true` (a tag, not a placeholder) | `NeverStopOrScaleTheConsolesOwnHost` denies stopping, rebooting, terminating or scaling anything carrying it. If the console runs on EC2, tag its instance — and its Auto Scaling group, if any — this way (on plain EC2, also set `CONSOLE_SELF_INSTANCE`; see [Configuration](configuration.md#environment-variables)). |

```bash
npm run iam:policy -- --print full --regions eu-west-1 --set ACCOUNT_ID=123456789012 \
  --set CONSOLE_CLUSTER=acme-tools --set CONSOLE_SERVICE=deployment-console --set ENV_FILES_BUCKET=acme-env-files \
  --set CONSOLE_PARAM_PREFIX=deployment-console --set CONSOLE_SECRET_PREFIX=deployment-console/ \
  --set CONSOLE_ENV_FILE=deployment-console/production.env --out ./policy
for f in ./policy/deployment-console-*.json; do
  aws iam create-policy --policy-name "$(basename "$f" .json)" --policy-document "file://$f"
done
```

`--set` refuses a value that isn't valid for its placeholder, so nothing typed changes the document's structure.

Attach it instead of (not next to) the read-only policy; it contains everything the read-only one has. A common
setup is the read-only policy on production accounts and the full one on staging. With every cloud-map service the full
policy is larger than the 6,144 characters AWS allows in one managed policy (four parts today): create every part,
from Settings → AWS permissions or with the command above, and attach them all. The denies stay in whichever part they
fall in, and a deny in any attached policy wins.

## What each permission is for

These are the hand-written statements. Their actions are called by `src/lib/server/aws.ts` (the `ce:*` ones by
`src/lib/server/billing-aws.ts`); where a row says so, a statement also covers a cloud-map action (`ec2:RebootInstances`
and `s3:DeleteObject` are there only for the map), and its limit then applies there too. The cloud map's `Inventory*`
statements are generated from what each service declares and listed in
[Supported services](services.md#iam-actions-by-provider). Nothing else is granted: a test
(`src/lib/iam-policy.test.ts`) keeps the policies, these tables and the code in step.

**In both policies (read-only):**

| Permission | Used for |
|---|---|
| `ecs:ListClusters`, `ecs:DescribeClusters` | Environments (one per cluster) and their tags |
| `ecs:ListServices`, `ecs:DescribeServices` | Services, deployments, events, tags |
| `ecs:ListTasks`, `ecs:DescribeTasks` | Running tasks and the last stopped ones (stop reasons, exit codes) |
| `ecs:DescribeTaskDefinition`, `ecs:ListTaskDefinitions` | Images, ports, health checks, log configuration, variable names, revisions to switch to |
| `ecs:ListContainerInstances`, `ecs:DescribeContainerInstances`, `ec2:DescribeInstances` | EC2 hosts behind ECS-on-EC2 clusters, and which host each task runs on |
| `ec2:DescribeSecurityGroups`, `ec2:DescribeSubnets` | Inferring connections and each environment's VPCs |
| `rds:DescribeDBInstances` | Databases (their tags come with the response) and attributing them to environments |
| `elasticache:DescribeReplicationGroups`, `elasticache:DescribeCacheClusters` | Caches and attributing them to environments |
| `elasticloadbalancing:DescribeTargetGroups`, `elasticloadbalancing:DescribeTargetHealth`, `elasticloadbalancing:DescribeLoadBalancers`, `elasticloadbalancing:DescribeListeners`, `elasticloadbalancing:DescribeRules` | Load balancer, routing rules, target health |
| `cloudwatch:GetMetricData` | Metrics, request performance, sparklines |
| `ecr:DescribeImages` | Whether a revision's image still exists before switching to it, and a repository's newest tags when you pick a new service's image |
| `ecr:DescribeRepositories` | The repositories offered when you pick a new service's image (also the cloud map's ECR listing) |
| `servicediscovery:ListNamespaces` | Finding the environment's Service Connect namespace when you [connect services](cloud-map.md#connect-services) (also the cloud map's Cloud Map listing) |
| `logs:DescribeLogStreams`, `logs:GetLogEvents`, `logs:FilterLogEvents` | Live tail, history, search, view-in-context |
| `logs:StartQuery`, `logs:GetQueryResults` | Logs Insights, and request performance from Caddy access logs |
| `ssm:DescribeParameters` | Parameter metadata only — name, type, tier, KMS key, never a value: the cloud map's Parameter Store listing, and keeping a parameter's type, tier and key when the full policy's variable editor writes a new value, and its current Version, so a write is refused when the parameter changed since it was read |
| `application-autoscaling:DescribeScalableTargets`, `application-autoscaling:DescribeScalingPolicies` | Which ECS services Application Auto Scaling manages, their min/max and policies: shown on the service, and the scale action warns when a count is outside that range |
| `secretsmanager:DescribeSecret` | Secret metadata only (which version is current), never a value: the variable editor refuses to overwrite a secret that changed since it was read |
| `iam:SimulatePrincipalPolicy` on the console's own role (`SimulateOwnPermissions`) | What the console's AWS identity may change: write controls are disabled or warned before a confirmation instead of failing after it ([Permissions](permissions.md)). Run locally as an IAM user, put that user's ARN in the statement |
| `sts:GetCallerIdentity` | The console's own identity, for the simulation above (needs no permission) |
| `ec2:DescribeRegions` | Which regions the account has enabled, when `CONSOLE_REGIONS` is `all-enabled` ([Configuration](configuration.md)) |
| `ce:GetCostAndUsage` | [Costs](costs.md): spend per day and AWS service, and per environment and ECS service from cost allocation tags |
| `ce:GetCostForecast` | Costs: AWS's forecast for the rest of the month |
| `ce:GetAnomalies` | Costs: anomalies found by AWS Cost Anomaly Detection in the last 30 days |

**Only in `iam-policy.json`:**

| Permission | Used for |
|---|---|
| `ecs:UpdateService` | Restart, stop/start, switch revision, deploying edited variables, scale, and setting a console-created service to 0 tasks before deleting it |
| `ec2:StartInstances`, `ec2:StopInstances`, `ec2:RebootInstances`, `rds:StartDBInstance`, `rds:StopDBInstance` | Power for hosts and databases on non-protected environments, and the cloud map's EC2 start, stop and reboot — only for resources tagged `console:power=allow` |
| `ecs:RegisterTaskDefinition` (+ `ecs:TagResource`, `iam:PassRole` to `ecs-tasks.amazonaws.com`) | A new revision when plain variables are edited, and the task definition of a copied service |
| `ssm:GetParameter`, `secretsmanager:GetSecretValue` (+ `kms:Decrypt` through SSM and Secrets Manager) | Revealing secret values referenced by a task definition. The read-only policy shows names, never values |
| `ssm:PutParameter`, `secretsmanager:PutSecretValue` (+ `kms:Encrypt` / `kms:GenerateDataKey` through SSM and Secrets Manager) | Updating a secret's value, keeping its type, tier and KMS key (read with `ssm:DescribeParameters`; standard SecureString parameters with a customer-managed key need `kms:Encrypt`) |
| `kms:Decrypt`, `kms:GenerateDataKey` through SQS and SNS only (`MessagingKms`) | The cloud map's queue and topic actions (send, redrive, publish) on queues and topics encrypted with a customer-managed key |
| `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `ENV_FILES_BUCKET` (+ `kms:Decrypt` / `kms:Encrypt` / `kms:GenerateDataKey` through S3) | Reading and editing env files (`environmentFiles`), including SSE-KMS encrypted ones. Without `s3:GetObject`, the names inside env files aren't shown either. Writes are conditional on the object's ETag (S3 `If-Match`): a file changed since it was read is never overwritten. The cloud map's S3 upload, delete and download use the same statement, so they work on this bucket only — and never on env files themselves |
| `ecs:CreateService` (+ `ecs:TagResource`) | [Copying a service and creating a new one](provisioning.md) — only with the tag `console:created=true` in the request |
| `ecs:DeleteService` | Deleting a service the console created — only services tagged `console:created=true`, never the console's own |
| `ec2:CreateSecurityGroup` (+ `ec2:CreateTags` at creation only) | A [new service](provisioning.md#new-service)'s own security group, in a VPC its environment already uses — the group must carry `console:created=true` (`CreateSecurityGroupsTaggedByTheConsole`, `CreateSecurityGroupsInExistingVpcs`, `TagSecurityGroupsAtCreationOnly`) |
| `ec2:DeleteSecurityGroup` | Removing that group with its service, or later when AWS kept it — only groups tagged `console:created=true` (`DeleteOnlyConsoleCreatedSecurityGroups`) |
| `ec2:AuthorizeSecurityGroupIngress`, `ec2:RevokeSecurityGroupIngress` | [Connecting services](cloud-map.md#connect-services): one inbound rule admitting a service's group on the other side's port, and removing it again — only in groups the console created or you tagged `console:connect=allow` (`OpenSecurityGroupsMadeByTheConsole`, `OpenSecurityGroupsTaggedForConnections`) |
| `servicediscovery:CreateHttpNamespace` (+ `servicediscovery:TagResource`), `servicediscovery:GetOperation` | The environment's Service Connect namespace when it has none — only tagged `console:created=true` (`CreateServiceConnectNamespacesTaggedByTheConsole`, `FollowCloudMapOperations`) |
| `servicediscovery:CreateService`, `servicediscovery:GetNamespace`, `servicediscovery:GetService` | What ECS calls in Cloud Map on the console's behalf when Service Connect is turned on for a service (`ServiceConnectThroughEcs`) |
| `ecs:RunTask` (+ `iam:PassRole` to `ecs-tasks.amazonaws.com`) | One-off tasks from a service's task definition, for example a migration — only with the tag `console:created=true` in the request |
| `ec2:RunInstances` (+ `ec2:CreateTags` at launch only, `iam:PassRole` to `ec2.amazonaws.com`) | Adding an EC2 host like an existing one — the instance and its volumes must carry `console:created=true` |
| `ec2:DescribeInstanceAttribute` | Reading a host's user data to launch another like it. It never leaves the server (user data often holds secrets) |
| `ec2:TerminateInstances` | Terminating a host the console launched — only instances tagged `console:created=true` |
| **Deny** `ecs:UpdateService`, `ecs:DeleteService` on `CONSOLE_CLUSTER/CONSOLE_SERVICE` (`NeverActOnTheConsoleItself`) | The console can never update or delete its own service, even if its own guard failed |
| **Deny** `ecs:RunTask` on the `deployment-console` task family, `ecs:CreateService` from it, and `iam:PassRole` of `deployment-console-task` (`NeverRunTheConsolesTaskDefinition`, `NeverCreateAServiceFromTheConsole`, `NeverPassTheConsolesOwnRole`) | Nothing can start another copy of the console, or anything else with the console's own role |
| **Deny** `ec2:StopInstances`, `ec2:RebootInstances`, `ec2:TerminateInstances`, `autoscaling:SetDesiredCapacity` on anything tagged `console:self=true` (`NeverStopOrScaleTheConsolesOwnHost`) | The console can never stop, reboot or terminate the EC2 instance it runs on, or resize its Auto Scaling group — tag them `console:self=true` |
| **Deny** `ssm:GetParameter`, `ssm:PutParameter` under `CONSOLE_PARAM_PREFIX`; `secretsmanager:GetSecretValue`, `secretsmanager:PutSecretValue` on names starting with `CONSOLE_SECRET_PREFIX`; `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `ENV_FILES_BUCKET/CONSOLE_ENV_FILE` (`NeverReadOrWriteTheConsolesOwnParameters`, `…Secrets`, `…EnvFile`) | The console's own database URL, secret key and tokens can never be revealed or overwritten through the Variables editor or the map, even if a service shares them by mistake and the console's own shared-reference check failed. In every region (`*`). Safe: ECS gives the console its secrets through the **execution** role, which these denies don't touch |

### Narrowing it further

The console enforces its own guards and roles, but IAM has the last word. Common restrictions:

- Allow `ecs:UpdateService` only on clusters you name: `arn:aws:ecs:REGION:ACCOUNT_ID:service/acme-staging/*`.
- Allow actions only on tagged services: add
  `"Condition": { "StringEquals": { "aws:ResourceTag/console:managed": "true" } }` and tag those services.
- Scope `SecretValues` to your parameter paths and secret names instead of `*`, for example
  `arn:aws:ssm:REGION:ACCOUNT_ID:parameter/acme/staging/*`.
- Narrow `PassTaskRolesToNewRevisions` to your services' task and execution roles, for example
  `arn:aws:iam::ACCOUNT_ID:role/app-*` if you name them consistently. As shipped it may pass any role that trusts
  `ecs-tasks.amazonaws.com`, which new revisions, copies and one-off tasks need; narrowed, a compromised console
  couldn't run a task with an unrelated role.
- Don't want [create & scale](provisioning.md)? Leave out the statements from `CreateServicesTaggedByTheConsole` to
  `DeleteOnlyConsoleCreatedSecurityGroups` and set `provisioning.enabled` to `false` in the config file.
- Allow new services' security groups only in VPCs you name: replace `vpc/*` in `CreateSecurityGroupsInExistingVpcs`
  with `vpc/vpc-0abc…` entries.
- Let connections open groups in one VPC only: add `"ArnEquals": { "ec2:Vpc": "arn:aws:ec2:REGION:ACCOUNT_ID:vpc/vpc-0abc…" }`
  to the conditions of `OpenSecurityGroupsMadeByTheConsole` and `OpenSecurityGroupsTaggedForConnections`.
- The generated `Inventory…Write` statements use `"Resource": "*"`: replace them with ARN patterns or tag conditions
  as described in [Permissions setup](permissions.md#narrowing-further).

## Costs

The [Costs](costs.md) page reads AWS Cost Explorer (the `CostsRead` statement, in both policies). Three things differ
from the rest of the console:

- **Enable Cost Explorer once**: Billing and Cost Management → Cost Explorer, as an account administrator. It is free
  to enable; the data takes up to 24 hours to appear. In an AWS Organizations member account, the management account
  must also allow member accounts to use it.
- **Per-environment spend needs tags.** Turn on *split cost allocation data* for Amazon ECS (Billing and Cost
  Management → Cost Management preferences) and activate the AWS-generated cost allocation tags `aws:ecs:clusterName`
  and `aws:ecs:serviceName` (Billing and Cost Management → Cost allocation tags). New data starts within 24 hours and
  is not back-filled.
- **Every Cost Explorer request costs $0.01.** The console takes one snapshot of 4 requests at most every 6 hours, and
  only when someone opens the page: at most about $5 a month. See [Costs](costs.md#what-it-costs). Cost Explorer is
  answered from `us-east-1` whatever `AWS_REGION` says, and its actions can't be scoped to resources
  (`Resource: "*"`).

## If something is missing

| What you see | Likely cause | Fix |
|---|---|---|
| The **Mock data** banner is still there | `CONSOLE_SOURCE` isn't set to `aws`, or the server wasn't restarted | fix the value and restart |
| "No environments found yet" | wrong region, or no ECS clusters there | set `AWS_REGION`; check `aws ecs list-clusters --region … --profile …` works |
| `ExpiredToken`, `Could not load credentials` | the profile's session expired or isn't set | `aws sso login --profile …`, or check `AWS_PROFILE` |
| `AccessDeniedException` at the top of Settings | the role lacks a permission | attach the policy; the message names the missing action |

More in [Troubleshooting](troubleshooting.md).
