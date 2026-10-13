# Permissions setup

The console sees and does only what its AWS role allows. You give it one policy; it discovers everything that
policy lets it read and builds the map. **Settings → AWS permissions** shows, per service, whether discovery worked and
which actions AWS refused, and builds the policy for you.

This page is for whoever looks after the AWS account. The short version:

1. Open **Settings → AWS permissions**, keep **Read-only (map only)**, and copy the **AWS CLI** commands.
2. Run them with credentials that may manage IAM. They create the policy and attach it to the console's role.
3. Come back to **Settings → AWS permissions** after the next discovery pass: every service should say **Working**.

The rest of this page explains each step and what each kind of permission risks.

## 1. Choose read-only or full

Every permission the console uses belongs to one class:

| Class | In which policy | Examples | What it lets the console do | What it risks if the console (or its role) is misused |
|---|---|---|---|---|
| **Discovery** | both | `ec2:DescribeInstances`, `s3:ListAllMyBuckets`, `route53:ListResourceRecordSets` | list resources, their configuration, tags and relationships | someone sees your architecture: names, tags, hostnames, settings. Some configuration AWS returns includes values — ECS task definitions and Lambda functions come with their plain environment variables. The console keeps those on the server, only to match them against other resources' names, and never shows or sends them |
| **Data reads** | full only | `s3:GetObject`, `ssm:GetParameter`, `secretsmanager:GetSecretValue` | read what's *inside*: object contents, secret values, messages | reading your data. The console uses these only behind audited actions (revealing a variable, a 5-minute download link) |
| **Actions** | full only | `cloudfront:CreateInvalidation`, `autoscaling:SetDesiredCapacity`, `ecs:UpdateService`, `s3:PutObject` | change things, from a harmless cache purge to deleting an object | changes to your account. Every action checks the person's role, protected environments and a confirmation, and writes an audit entry before calling AWS — but IAM has the last word |
| **Authorised through other calls** | where needed | `iam:PassRole`, `kms:Decrypt` | what AWS checks on top of another call | only granted in hand-written statements with a condition (for example `iam:PassedToService`, `kms:ViaService`) |

Metadata about secrets is discovery, not a data read: `ssm:DescribeParameters` and `secretsmanager:ListSecrets` return
names, types, KMS keys and dates — never a value — so they belong in both policies. Values need `ssm:GetParameter` or
`secretsmanager:GetSecretValue` (full policy only).

One discovery call returns a secret anyway: **`ec2:DescribeVpnConnections`** includes the VPN tunnels' pre-shared keys
in its answer. The console needs the call for tunnel status, drops the rest where the answer arrives and keeps only
the status — but the read-only policy still lets the console's role read those keys. If that's not acceptable, remove
the action from the policy: VPN connections then show as not read, and everything else keeps working.

- **Read-only (map only)** is discovery only. The console can show everything and change nothing. Action buttons are
  still there; AWS refuses them and the console shows AWS's error. Start here.
- **Full (map + actions)** adds data reads and what every action needs, plus the ECS console's own statements (restart,
  variables, create & scale) with their conditions and the denies that stop the console acting on itself.

A common setup: read-only on production accounts, full on staging.

**Why not an AWS-managed policy?** `ViewOnlyAccess` misses about half of what the read-only policy grants — log events
and Logs Insights, alarms, KMS key details, ECR images and findings, Cloud Map, Resource Explorer, most tag reads — so
those services would show **Missing permissions**. `ReadOnlyAccess` covers them but also grants data reads the console
never needs (object contents with `s3:GetObject`, table items with `dynamodb:Scan`, …). Attaching either beside the console's own policy changes nothing the console does; it only widens what its role could
read.

## 2. Create the policy

**From the console (easiest).** Settings → AWS permissions → **Policy builder**:

- Pick the mode, and untick services you don't want the console to see.
- Fill in the console's role, account id and region. In full mode it also asks for the placeholders of the hand-written
  statements (the console's own cluster and service, the env-files bucket, and the console's own parameter path,
  secret prefix and env file that the `NeverReadOrWriteTheConsoles…` denies protect) — see
  [Connect AWS](connect-aws.md#step-5-turn-on-more-one-feature-at-a-time) for what each means. Nothing you type leaves
  your browser.
- Copy **Policy JSON** (for the IAM console) or **AWS CLI** (creates and attaches it in one go).

**From the repository.** The same policies are `infra/iam-policy-readonly.json` and `infra/iam-policy.json`, covering
every service. Their statements come in two kinds:

- **Hand-written** ones (`DiscoverAndRead`, `CostsRead`, `ServiceActions`, `Never…` and the rest): the ECS console's
  features, explained in [Connect AWS](connect-aws.md).
- **Generated** ones, named `Inventory<Service>Read`, `Inventory<Service>Sensitive` and `Inventory<Service>Write`
  (read-only file: `…Read` only), one set per cloud-map service, built from what each service declares.
  `npm run iam:policy` rewrites them — only them — after an upgrade. It never generates an action a hand-written
  statement already grants, whether on every resource, only on some, or only under a condition: IAM adds allows up, so
  a generated `"Resource": "*"` beside a hand-written limit would quietly cancel it. A hand-written limit stays the
  limit — S3 object actions only on the env-files bucket (`EnvironmentFiles`), EC2 start, stop and reboot and RDS start
  and stop only on resources tagged `console:power=allow` (`PowerNonProtectedHostsAndDatabases`).

To print a policy for some services only, or split it into parts that fit AWS's size limit:

```bash
npm run iam:policy -- --print read --providers lambda,sqs,s3          # to stdout
npm run iam:policy -- --print full --out ./policies                   # one file per part
npm run iam:policy -- --print full --regions eu-west-1,us-east-1 \
  --set ACCOUNT_ID=123456789012 --principal arn:aws:iam::123456789012:role/deployment-console-task --out ./policies
```

`--set NAME=value` fills a placeholder (an invalid value is refused), `--regions` fills `REGION` or, with more than
one region, widens it (below), and `--principal` names the identity the console runs as in `SimulateOwnPermissions`
(an IAM user's ARN when you try it locally as a user).

**Size.** AWS allows 6,144 characters (not counting spaces) in a managed policy, and every service together needs more
than that. With every service built today the read-only policy is about 11,700 characters — **2 parts** — and the full
policy about 18,400 — **4 parts**. Plan for **3 read-only parts** (and 5 full ones): the services listed as *being
added* in [Supported services](services.md#services) each bring their own reads. The builder and `--out` split the
document into parts (`deployment-console-readonly-1`, `-2`, … / `deployment-console-1`, …), in statement order, a
statement too big for one part split by actions: create and attach every part. A role or user holds 10 managed
policies by default, so even five parts leave room. Upgrading later? Publish each part as a new version of the
same policy, and create (and attach) only the parts that are new.

## 3. Attach it to the console's role

The console uses the standard AWS credential chain and stores no credentials.

- **On ECS**, attach it to the console's **task role** (`deployment-console-task` in `infra/task-definition.json`),
  not the execution role.
- **On your machine**, attach it to a role you assume through a profile —
  [Connect AWS, step 2](connect-aws.md#step-2-give-the-console-credentials-with-that-policy).

```bash
# one create + attach per part (the builder's AWS CLI tab writes these for you)
for f in ./policies/deployment-console-readonly-*.json; do
  aws iam create-policy --policy-name "$(basename "$f" .json)" --policy-document "file://$f"
  aws iam attach-role-policy --role-name deployment-console-task \
    --policy-arn "arn:aws:iam::123456789012:policy/$(basename "$f" .json)"
done
```

**Replace, don't stack.** Moving from read-only to full? Detach the read-only policy: the full one contains it. After an
upgrade, publish the new document as a new version of the same policy instead of creating another one:

```bash
aws iam create-policy-version --set-as-default \
  --policy-arn arn:aws:iam::123456789012:policy/deployment-console-readonly-1 \
  --policy-document file://policies/deployment-console-readonly-1.json     # and so on for each part
```

IAM keeps five versions; delete the oldest first when it's full. New permissions apply within seconds: no restart. The
map picks them up on its next discovery pass.

### More than one region

A console that reads several regions (`CONSOLE_REGIONS`, or `inventory.regions`) needs the full policy's
region-scoped statements in each of them. Replace `REGION` with `*` — or let `--regions a,b` do it. That widens:

- the `kms:ViaService` conditions (`SecretValuesKms`, `MessagingKms`) to `ssm.*.amazonaws.com`,
  `secretsmanager.*.amazonaws.com`, `s3.*.amazonaws.com`, `sqs.*.amazonaws.com` and `sns.*.amazonaws.com`: KMS still
  decrypts only for those services, in any region;
- the ARNs of the console's own statements (`ServiceActions`, `RunOneOffTasks`, `LaunchHosts…`, …), which stay scoped
  by account, resource type, name pattern and tag.

The read-only policy has no region in it: nothing to change. The denies that protect the console's own parameters,
secrets and env file already use `*`.

## 4. Cloudflare (optional)

Cloudflare isn't AWS: it needs an API token, not IAM. In the Cloudflare dashboard: **My Profile → API Tokens → Create
Token → Custom token**, limited to the zones you want on the map, with:

| Permission | For |
|---|---|
| `Zone:Read`, `DNS:Read` | the map: zones and the records pointing at your AWS resources |
| `Cache Purge` | only if you want the purge-cache action |

Then set `CLOUDFLARE_API_TOKEN` in the console's environment — `.env.local` locally; on ECS a Secrets Manager secret
referenced from the task definition's `secrets` — and restart the console. `CLOUDFLARE_ACCOUNT_ID` (optional) limits
the map to one Cloudflare account's zones. The console never logs or returns the token. Settings → AWS permissions lists the
scopes the running build asks for.

## 5. Kubernetes workloads on EKS (optional)

IAM gets the console as far as the clusters and their node groups. To show the workloads inside a cluster
(Deployments, StatefulSets…), give the console's role an **access entry** in each cluster:

```bash
CLUSTER=my-cluster
ROLE_ARN=arn:aws:iam::123456789012:role/deployment-console-task
aws eks create-access-entry --cluster-name "$CLUSTER" --principal-arn "$ROLE_ARN"
# See workloads (read-only):
aws eks associate-access-policy --cluster-name "$CLUSTER" --principal-arn "$ROLE_ARN" \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy --access-scope type=cluster
# Restart and scale workloads too, only in the namespaces you name:
aws eks associate-access-policy --cluster-name "$CLUSTER" --principal-arn "$ROLE_ARN" \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy --access-scope type=namespace,namespaces=app
```

- The cluster's authentication mode must allow access entries (`API` or `API_AND_CONFIG_MAP`):
  `aws eks update-cluster-config --name "$CLUSTER" --access-config authenticationMode=API_AND_CONFIG_MAP`.
- The console must reach the cluster's API endpoint: a public endpoint, or a private one from the console's VPC.
- View access is enough for the map. Edit access lets the console change workloads in those namespaces; the console
  still checks roles, protected environments and confirmations, and audits every action.

## 6. Check Settings → AWS permissions

Each service shows one of:

| Status | Meaning | What to do |
|---|---|---|
| **Working** · *n* | discovery succeeded and found *n* resources | nothing |
| **Missing permissions** | AWS refused the listed actions | in the builder, **Only what's missing**, then update the policy |
| **Not set up** | the service needs configuration first (for example Cloudflare without a token) | follow the reason shown |
| **Error** | something else failed (throttling, a network error) | usually passes on the next pass; the message says why |

The card also shows what the service discovers and, under **Needs**, every permission it uses by class. The map's
footer shows the same statuses. AWS errors name the missing action, so a partly granted policy still produces a map:
the services it can read appear, the others say what they need.

## 7. Add write permissions one feature at a time

Once the map looks right:

1. Pick one action you want, for example CloudFront invalidations. [Supported services](services.md) lists every
   action and the permission it needs.
2. Add just that service's `Inventory<Service>Write` statement (or build a full policy with only that service ticked),
   and publish it as a new policy version.
3. Try the action on something unimportant. Repeat for the next one.

### S3 file actions

The map's S3 **upload**, **delete** and **download** need `s3:PutObject`, `s3:DeleteObject` and `s3:GetObject`, and
only a hand-written statement grants those: as shipped, `EnvironmentFiles`, on the env-files bucket
(`ENV_FILES_BUCKET`). Env files themselves (`.env`, `.env.*`, anything ending in `.env`) are refused by these actions
in every bucket — they're read and edited only in a service's **Variables** tab. To use the file actions on other
buckets, add their ARNs to a hand-written statement (any `Sid` that doesn't start with `Inventory`, so
`npm run iam:policy` keeps it as it is):

```json
{
  "Sid": "MapFileActions",
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::my-bucket/*"
}
```

### Narrowing further

Narrow what you grant when you can — IAM is the last line of defence if a guard or an account is ever wrong. The
generated statements use `"Resource": "*"`. You can replace them with ARN patterns, or add tag conditions where the
service supports them, without changing how the console behaves — AWS refuses an action outside the scope, and the
console shows AWS's error. Worth doing for Lambda code updates (`lambda:UpdateFunctionCode`), SQS receive and delete
(`sqs:ReceiveMessage`, `sqs:DeleteMessage`), API Gateway `apigateway:POST`, Step Functions (`states:StartExecution`),
Auto Scaling (`autoscaling:SetDesiredCapacity`) and Beanstalk writes (`elasticbeanstalk:RestartAppServer`,
`elasticbeanstalk:UpdateEnvironment`):

- Name the resources you mean: `arn:aws:lambda:eu-west-1:123456789012:function:acme-staging-*` for code deploys.
- Allow actions only on tagged resources:
  `"Condition": { "StringEquals": { "aws:ResourceTag/console:managed": "true" } }`.
- Give the replacement statement a `Sid` that doesn't start with `Inventory`: `npm run iam:policy` then keeps it and
  stops generating the actions it grants.
- Keep the `Never…` denies from `infra/iam-policy.json`: they stop the console changing, copying, running, stopping or
  scaling itself, and reading or overwriting its own parameters, secrets and env file, even if its own checks failed.

Who may press which button inside the console is a separate layer: roles and protected environments
([Sign-in & roles](auth.md), [Actions & safety](actions.md)).

### Cloud Control types

`inventory.catchAll.cloudControlTypes` lists CloudFormation types (`AWS::Glue::Database`) the catch-all reads through
AWS Cloud Control. The policy grants `cloudformation:ListResources`, but Cloud Control then calls the service for you
**with the console's own permissions** — its *handler permissions*, listed per type in the
[CloudFormation resource type schema](https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/resource-types.html)
under `handlers.list.permissions` (`aws cloudformation describe-type --type RESOURCE --type-name AWS::Glue::Database`).
For `AWS::Glue::Database` that is `glue:GetDatabases` plus three Lake Formation reads
(`lakeformation:ListResources`, `lakeformation:DescribeResource`,
`lakeformation:DescribeLakeFormationIdentityCenterConfiguration`). Add those actions to a hand-written statement (a
`Sid` that doesn't start with `Inventory`); without them, that type shows as not read and everything else keeps
working. List handlers only read, but check each type's list: like Glue's, some reach into a related service.

## Agent model credentials

The agents' model connections (Anthropic, OpenAI, Bedrock…) are separate from the console's role and from these
policies. A Bedrock connection signs in with its own access keys, or a role it assumes with them — never the console's
role — so the console's policy never needs `bedrock:InvokeModel`, and a model connection never gets the console's AWS
permissions. See [Agents & API](automation.md#model-connections).

## For contributors: adding a service

Each provider (`src/lib/server/providers/*.ts`) declares every IAM action it uses in `read`, `sensitive`, `write` or
`implicit`, and Cloudflare-style token scopes with a `cloudflare:` prefix. Then:

```bash
npm run iam:policy        # regenerates the Inventory* statements and the table in docs/services.md
npm test                  # src/lib/iam-policy.test.ts says exactly what to add where
```

The test maps every AWS SDK command a server file imports to its IAM action and fails when a call isn't declared, a
declared action is never called, an action has two classes, or the policies and docs are out of date. `implicit`
actions go with discovery when they read (`Describe…`, `List…`, `Get…`) and with actions otherwise; `iam:*` and `kms:*`
are never generated — add a hand-written statement with a condition instead.

A provider also declares what it discovers: `kinds`, its `scope` (`regional`, `global` with a `homeRegion`, or `home`)
and `covers`, the Resource Explorer types it lists, spelled exactly as `aws resource-explorer-2
list-supported-resource-types` spells them (sub-types included, such as `elasticloadbalancing:loadbalancer/app`).
`src/lib/inventory/covers.test.ts` checks every `covers` entry against the snapshot in
`src/lib/inventory/aws-resource-types.json`, and that no type is covered twice. When the IAM action differs from the
SDK command's name, add it to `OVERRIDES` in `src/lib/iam-policy.test.ts` (Resource Explorer's `ListResources` is
authorised by `resource-explorer-2:Search`).

The agents' model adapters (`src/lib/server/agents/inference/` and `runtime/`) aren't part of these policies: they call
a model provider — Bedrock included — with that connection's own credentials, never the console's role. The test keeps
`@aws-sdk/client-bedrock-runtime` out of every other file.
