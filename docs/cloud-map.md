# Cloud map

The cloud map is one picture of everything the console can find in your AWS account — ECS services, load balancers,
databases and caches, and around them the serverless and edge plumbing (Lambda functions, queues, topics, event
rules, buckets, CloudFront, Route 53, Cloudflare, EKS, App Runner, Beanstalk, EC2…) — with the connections between
them, which environment each belongs to, and what nobody uses anymore. Nothing about your company is configured in
code: the map is read from AWS every couple of minutes, and this page explains every rule so you can predict what it
will show.

Columns run left to right the way requests usually flow: **Edge & DNS → Compute → Messaging & events → Databases →
Storage → External**. Which services are listed, and the IAM permissions each needs, are in
[Supported services](services.md) and [Permissions setup](permissions.md).

## Using the map

Open **Cloud map** in the sidebar (or press `g`), the **Cloud map** link on an environment's overview, or ⌘K.

- **Layers.** The flow (edge & DNS, compute, messaging, data, storage, external) is always drawn. Support layers —
  Network, Security & identity, Monitoring & logs, Build & delivery, Other services — are switched on in **Layers**
  (counts per layer; your choice is remembered in this browser, and a link carries it). Other services is on by
  default: generic resources the console has no dedicated reader for, grouped per lane and AWS service. Hidden rows
  (AWS-managed keys, service roles, table-only types) are never drawn; they are listed in All resources.
- **Lanes.** Lanes group the map by environment (default; production first, **Shared** last), by VPC, by region (with
  several regions) or not at all. More than 12 resources of one kind in a lane show as one group: click it to expand,
  use the chip at the top left to collapse.
- **Folding.** Resources that belong to another (subnets to their VPC, a NAT gateway to its subnet, Aurora members to
  their cluster) fold into it ("+3 inside"); the panel's Relationships section shows them and *Show the N inside on
  the map* unfolds them (a chip on the map folds them back).
- **Lines.** Solid: read from AWS configuration. Dashed: allowed by a security group. Dotted: a setting names the
  resource. The dot marks the receiving end. Hover or focus a resource to trace its paths; click a line to see how the
  console knows it.
- **Connections.** Filters lines by how sure the console is (config, allowed, mentioned); it never hides resources. A
  Cloud Map service, VPC endpoint, NAT gateway or RDS proxy between two resources on the map is drawn as a label on the
  joined line ("via acme-production-pg-proxy") unless its layer is on, it has a problem or it matches the search. DNS
  routing shows on the line ("weighted 50", "failover primary", "latency"). On a map with more than 400 lines, only the
  lines of the resource you hover, focus or open (and of search matches) are drawn until *Show all N connections*.
- **Filters.** Environment (one environment also shows the shared resources wired to it), region (with several
  regions), kinds, search (name, key, `tag=value`, endpoint, alias), *Idle only*, *Problems only*. On phones they live
  under **Filters**.
- **Badges.** A ring marks a problem when names are too small to read; a group says how many members have one; a siren
  marks a resource a CloudWatch alarm in ALARM watches (target-tracking scaling alarms never do); a dashed node is a
  reference to another account or region, or a resource the last complete read didn't list ("not seen since … —
  confirming").
- **Phones.** Phones open on a list (grouped by environment, then category, problems first); the List/Map switch shows
  the map, which is laid out top to bottom when the phone is held upright. Phones start without lanes.
- **Keyboard.** Tab / Shift+Tab move between resources, arrows follow connections, Enter opens, `+` / `−` zoom, `0`
  fits, `/` searches, Esc closes.
- **Resource panel.** On desktop the panel sits beside the live map: click another resource to switch, Escape closes
  it. Overview, Connections, Details (for S3: browse folders; files download through an audited 5-minute link, people
  only), Actions, Notes. It shows pins, facts (shared self-referencing security groups, idle evidence…), what wasn't read
  (tags not read count as protected), relationships, *Open metrics* (RDS, load balancers, ElastiCache), a *Coverage*
  link to Settings → AWS permissions, and for each action its summary, how to undo it and when it counts as done (IAM
  actions under Details). ECS services link to their full service panel.
- **Actions.** Every action shows its plan first (a dry run); nothing changes until you confirm. Dangerous actions, and
  any action on a resource that counts as protected ([see below](#which-resources-count-as-protected)), ask for the
  resource name and a reason.
- **All resources.** `/resources` (also `/map?view=table`) lists every row, including hidden and generic ones:
  sortable, filterable by kind, service, category, region, environment, health, source and hidden; pin a row with its
  star; export CSV; **Save view** keeps the filters under a name (it opens the command palette's save dialog; find it
  under ⌘K). Slim rows load their properties when opened.
- **Sources footer.** What discovery read; a denied source lists the exact IAM actions to add (Settings →
  Permissions). **Refresh** re-reads the account (rate-limited; developer role and up — viewers don't see the button).
- **Links.** The URL carries the view: `q`, `env`, `kinds`, `problems=1`, `idle=1`, `region`, `layers` (comma list or
  `none`), `conn` (confidences), `lanes` (`env`, `vpc`, `region`, `none`), `view` (`map`, `list`, `table`),
  `edges=all` and `r` (the open resource). A link to a resource that's gone says so.

## Where the data comes from

Each AWS service (and Cloudflare) has a **provider**: a small reader that lists that service's resources, the
relationships AWS stores explicitly, and the few actions the service supports. The map runs every enabled provider
at once and merges what they report.

| Provider | Lists | Reads |
|---|---|---|
| ECS services | every service of every discovered environment (the same discovery as the environment pages), its tasks, image, network and task definition; its task and execution roles, Cloud Map registries, EFS volumes, Service Connect names, running task IPs, autoscaling range and deployment controller | ECS, EC2 subnets, security groups, Application Auto Scaling |
| Load balancers | every Application, Network and Gateway Load Balancer in each region, on its own (ECS ownership is joined in when ECS discovery answers): listeners, rules, target groups and every target's health. Health combines the load balancer's own state with its targets' — no target groups, or none whose health could be read, is "unknown", never healthy; a stopped ECS service's empty target group is fine | Elastic Load Balancing |
| RDS databases | every DB instance (Aurora instances included), per region: posture (public access, encryption, backups, deletion protection), its KMS key and Aurora cluster | RDS |
| RDS clusters and proxies | Aurora and Multi-AZ DB clusters, DocumentDB and Neptune clusters, RDS proxies, per region: endpoints (writer, reader, custom), members, VPC and subnets (from the subnet group), encryption, backups; a proxy's targets; a global database's primary → secondaries | RDS |
| ElastiCache | replication groups and standalone clusters, per region: tags, VPC (from the subnet group), encryption, AUTH; member clusters resolve to their group | ElastiCache |
| ElastiCache Serverless · MemoryDB | serverless caches (endpoint, usage limits, network, encryption); MemoryDB clusters (shards, endpoint, TLS, encryption, ACL) | ElastiCache, MemoryDB |
| EFS · OpenSearch · Redshift | file systems (mount targets, access points, encryption; "no mount targets" is a warning); domains (endpoints, nodes, storage, encryption, fine-grained access control; a domain outside a VPC counts as public); provisioned clusters (a paused one is stopped) and Serverless workgroups with their namespaces | EFS (and EC2 for mount-target security groups), OpenSearch Service, Redshift |
| Lambda | functions, triggers (event source mappings), dead-letter and async destinations, function URLs, VPC, reserved concurrency; execution role, the environment's KMS key, log group, EFS mounts. Health comes from Lambda's deployment state (GetFunctionConfiguration, the first 300 functions, cached until the function changes); a function whose state wasn't read is "unknown", never healthy. The panel separates exists / deployment state / runtime health (errors and throttles) | Lambda, CloudWatch |
| SQS · SNS · Kinesis · DynamoDB | queues (depth, redrive, DLQ warnings), topics (subscribers, masked people), streams, tables; each one's KMS key (a bare alias such as alias/aws/sqs is that region's AWS-managed key). Unread attributes or table details give "unknown". Kinesis and DynamoDB tags are read through every page | SQS, SNS, Kinesis, DynamoDB |
| EventBridge · Step Functions | buses (the default one listed, not drawn), rules → targets, the roles they run as; state machines with what their definition calls, their role, log groups and KMS key | EventBridge, Step Functions |
| API Gateway | REST, HTTP and WebSocket APIs, routes → integrations, stages (access logs), authorizers (Cognito pools, Lambda functions), custom domains and their certificates | API Gateway |
| S3 | every bucket in every region (one global run): public access, website, versioning, encryption (its KMS key), access logs, replication, notifications. Settings are read per bucket within the discovery time budget; a bucket past it shows "settings not read" and counts as protected until its tags are read | S3 |
| CloudFront | distributions (named by alias, Name tag, comment, then id), origins by path pattern, access logs, Lambda@Edge, the ACM certificate and WAF web ACL | CloudFront |
| Route 53 | hosted zones (Cloud Map-managed ones say so), records → what they point at with their routing policy (weighted, failover, latency, geolocation, multivalue, IP-based), and health checks: health from what Route 53's checkers report (the first 50), linked to what they watch | Route 53 |
| EC2 · Auto Scaling · EKS · App Runner · Beanstalk | per region: instances, groups, clusters, services and environments, the roles they run as, KMS keys, the EKS control-plane log group, App Runner's ECR repository and VPC connector | EC2, Auto Scaling, EKS, App Runner, Elastic Beanstalk |
| Declared in config | apps you list under `workloads` and outside systems under `externals` in `console.config.json` (see below) | nothing: the config file, plus a live health check for workloads |
| Everything else | see [Supported services](services.md) and [Other AWS resources](#other-aws-resources) | one provider per service |

A provider that isn't allowed to read something shows up as **denied** at the bottom of the map, with the exact IAM
action AWS named — the rest of the map still works. Cloudflare stays **disabled** until `CLOUDFLARE_API_TOKEN` is set.

**Network.** VPCs and subnets (each classed Public, Private (NAT), Private (routed), IPv6 egress-only or Isolated from
its route table), NAT and internet gateways, endpoints, peerings, transit gateway attachments, VPN connections (tunnel
status) and Elastic IPs attached to nothing (billed hourly). A subnet named private that routes 0.0.0.0/0 to an internet
gateway, or that is running out of addresses, is a warning. Security groups: open to the internet on anything but
80/443 is a warning; a group is marked unused only when no network interface uses it and no other group references it
— both known to be zero (default groups never are); their rules draw the *allowed* lines, and a publicly addressable
resource in a subnet routed to the internet whose network ACL lets the port in gets an exposure error (see
[Health across resources](#health-across-resources)). Cloud Map: namespaces and services with their DNS names, linked to
the ECS services registered in them; a service with no instances is stopped. EBS: volumes fold into their instance; an
unattached one is a warning (billed per GB).

**Monitoring & logs.**

- **CloudWatch alarms** are drawn as dotted *monitors* lines to what they watch: the ECS service, load balancer,
  database, queue or function their metric names, in the alarm's own region. A composite alarm's lines go to its child
  alarms.
- An alarm in ALARM is red, and it turns what it watches amber.
- **Scaling alarms** are always green and never turn anything amber; their lines say *scales*. These are the
  AlarmHigh/AlarmLow pairs target tracking creates, or alarms whose only actions are scaling policies. AlarmLow sits in
  ALARM whenever load is low, and that's normal.
- An alarm stuck without data for more than a day while it has actions is amber, because its actions can't fire. So is
  an alarm whose actions are disabled.
- **Log groups** show who writes to them: ECS services (from their task definitions, in the region `awslogs-region`
  names) and, by AWS's naming conventions, Lambda functions, RDS, CodeBuild, EKS and API Gateway.
- A log group that never expires and holds more than 10 GiB is amber. Container Insights and vended groups are listed
  but not drawn.
- **Synthetics canaries** are red when their last run failed, even if every service behind them reports healthy.
- **CloudTrail trails** are red when they stopped logging, and amber when delivery fails.
- **Glue** jobs and crawlers are amber when their last run or crawl failed. A job's arguments are only matched against
  other resources and never shown; Glue connections are never read.

**Build & delivery.** ECR repositories (the images ECS runs, what each tag points to now, critical findings on running
images, lifecycle policy), CloudFormation stacks (status, drift, safe outputs, what each stack manages), CodeBuild
projects (last build; environment values never shown), CodePipeline pipelines (last run, disabled transitions, what
each pipeline builds and deploys) and CodeDeploy deployment groups (last deployment; blue/green ECS services). All
read-only. EventBridge Scheduler and Pipes targets that run ECS tasks link to the service running that task family.

### Other AWS resources

Everything else the account holds comes from Resource Explorer (turn it on with an index in each region, or one
aggregator; the console reads the default view), or — without it — from the Tagging API, which only sees tagged
resources. With `inventory.catchAll` in [`console.config.json`](configuration.md#keys) it also reads AWS Config's
resource inventory and the Cloud Control types you name. Rows that duplicate a resource the console already reads are
folded into it (their tags are added); sub-objects (rules, snapshots, versions…) are only counted; table-only types
appear in All resources; the long tail with no dedicated reader appears on the map under **Other services**. A
resource another account or region is configured to use is drawn as a reference ("referenced in configuration — not in
this account/region").

### Apps AWS can't see: declared workloads

Containers started by docker compose on an EC2 box, a job under systemd, an app on another platform — AWS only sees
the instance (or nothing at all). Describe them once in `console.config.json` and the map shows them on their host,
connected to what they use, with a live health check:

```json
"workloads": {
  "api": {
    "name": "Storefront API",
    "env": "staging",
    "host": "i-0123456789abcdef0",
    "platform": "docker compose",
    "healthcheck": "https://api.staging.example.com/ready",
    "url": "https://api.staging.example.com",
    "repo": "acme/api",
    "uses": ["rds:acme-staging-pg", "redis", "external:kafka"]
  },
  "redis": { "name": "Redis", "env": "staging", "host": "i-0123456789abcdef0", "platform": "docker compose" }
}
```

- `host` links it to the EC2 instance it runs on ("runs on"). Leave it out for apps outside AWS (e.g. `"platform": "Railway"`).
- `healthcheck` is fetched like the service health checks (HTTP 200 = up; two failures in a row = down).
- `url`'s hostname lets DNS records, CloudFront origins and other apps' settings point at it.
- `uses` takes resource keys (below), names, hostnames, ARNs or other workload ids; unknown hostnames become external nodes.

Resources are identified by their ARN, or by a short key when AWS has none: `ecs:service/<cluster>/<service>`,
`elb:<name>`, `rds:<id>`, `elasticache:<id>`, `ec2:<instance-id>`, `workload:<id>`, `external:<host>`; outside the home
region the ECS, load balancer, RDS, ElastiCache and EC2 keys end in `@<region>` (`ec2:i-0abc@eu-west-1`). Notes and links
use the same keys, so a note on an ECS service shows on its environment page and on the map.

## How connections are found

Every line on the map says how the console knows about it — its **confidence** — and lists its evidence.

| Confidence | Meaning | Examples of evidence |
|---|---|---|
| **config** | Read from AWS configuration: this path is set up | `listener HTTPS:443 rule 10 → api-prod`, `CloudFront origin assets (S3)`, `event source mapping (enabled, batch 10)`, `Route 53 alias A www.acme.example → d1….cloudfront.net`, a connection in `console.config.json` |
| **allowed** | A security group lets traffic through; nothing says it's actually used | `security group sg-db allows sg-api` |
| **mentioned** | A setting names the other resource — usually an environment variable | `env DATABASE_URL`, `env ORDERS_QUEUE_URL`, `env file` |

When two kinds of evidence describe the same line they're merged, and the strongest confidence wins: an API service
whose `DATABASE_URL` names the database *and* whose security group is allowed in shows one `sql` line with both
pieces of evidence.

**What a line means** (its kind): `route` (DNS, CDN, gateway or load balancer sends requests to it), `invoke` (calls or
triggers it), `event` (delivers events: S3 notifications, EventBridge targets, SNS subscriptions), `poll` (pulls from it:
Lambda on a queue or stream), `sql` / `cache` / `stream` (data connections), `reads` / `writes` (direction known), `uses`
(named, direction unknown) and `http` (a network path).

### Mentions: settings that name other resources

The console reads task-definition environment variables (and the equivalent settings of Lambda, Beanstalk, App Runner,
Kubernetes workloads…) **on the server** and looks for anything that names another resource:

| In a value | Matches |
|---|---|
| An ARN (`arn:aws:sns:…:orders`) — also qualified Lambda ARNs, S3 object ARNs, DynamoDB stream ARNs | that resource |
| A queue URL (`https://sqs.<region>.amazonaws.com/<account>/<queue>`) | that queue |
| A hostname, with or without scheme, credentials, port or path (`postgres://app:…@db.abc.rds.amazonaws.com:5432/app`) | the resource answering on it: database and cache endpoints (any ElastiCache node of a cluster, an Aurora cluster endpoint (writer, reader or custom) → the cluster, whose instances are folded under it), load balancer / CloudFront / API Gateway / App Runner / Beanstalk hostnames, S3 endpoints in every form, DNS names that point at a resource, public IPs |
| A bucket in `s3://bucket/…` | that bucket |
| A distinctive name as a whole word (`acme-production-sessions`) | the one resource with that name |

Names only count when they're unambiguous: at least three characters, not a common word (`api`, `orders`, `prod`,
`cache`…), and not shared by two resources. When two resources share a name, the variable's name decides:
`…_TABLE` means a DynamoDB table, `…_QUEUE…` a queue, `…_TOPIC…` a topic, `…_BUCKET` a bucket. The variable's name
also sets the kind: `ORDERS_QUEUE_URL` → **writes** to the queue, `EVENTS_TOPIC_ARN` → **writes** to the topic,
`SESSIONS_TABLE` / `UPLOADS_BUCKET` → **uses**; databases are `sql`, caches `cache`.

The evidence is only ever the variable's **name** (`env DATABASE_URL`). Values never leave the server — see
[What's never shown](#whats-never-shown).

With the full policy (`s3:GetObject` on the env-files bucket), the values in a service's S3 env files are matched the
same way (evidence "env file DATABASE_URL"). The console never reads its own service's env files, and none at all
while it can't tell which service it is. A read-only setup gets connections from config and security groups only.

### Security groups

Two resources in the same VPC are connected as **allowed** when an inbound rule of one's security group names the
other's security group — the same rule the environment pages use. Into a database, cache or search domain the rule
must also admit a port it listens on (a group admitting 5432 says nothing about OpenSearch on 443 in the same group);
when that port isn't known, any rule counts. File systems are only ever the receiving end. ECS services on `host` or
`bridge` networking share their instance's groups, so a rule can't say which service on the host is meant; the map
leaves those out rather than guess. A security group that admits itself (members may reach each other) draws no
connections between services — the panel lists it under the resource's facts. When the two resources are already
connected (a listener rule, a connection string), the rule only adds its evidence to that line.

### DNS, origins and outside systems

DNS records are followed through the account: `shop.acme-shop.com` (Cloudflare) → `www.acme.example` (Route 53) →
the CloudFront distribution lands on the distribution, and `www.acme.example` becomes one of its hostnames — so an
environment variable holding `https://www.acme.example` connects to it too. A target that nothing in the account
answers to — a status page, a partner API, a server elsewhere — becomes an **External** node with its hostname, so
the map still shows where traffic leaves. Private IP addresses never become external nodes. Outside systems can also
be declared by name under `externals` in [`console.config.json`](configuration.md).

An `ip` target of a load balancer lands on the ECS service whose running task holds that address (or an EC2 instance
with it); a public one nothing answers to becomes an external node. A forward rule's host header is a hostname of the
service behind it, so `https://api.example.com` in a variable finds that service.

## Health across resources

One resource's state shows on the ones it affects. These rules only ever raise health (and append to the reason),
never lower it:

| Rule | What it does |
|---|---|
| Alarms | a non-scaling alarm in ALARM warns what it watches; a composite alarm leaves its child alarms alone |
| KMS keys | a key pending deletion warns what it encrypts (an error inside 7 days); a disabled key warns too |
| Certificates | expired or expiring within 7 days is an error on what serves it; within 30 days without auto-renewal, a warning |
| Exposure | a resource is **reachable from the internet** when it is publicly addressable, one of its subnets routes to an internet gateway (unknown counts as yes) and that subnet's network ACL lets the port in: a security group open to 0.0.0.0/0 on a port other than 80/443 is then an error, with a line from **Internet**. Open but not reachable is a warning that says why: "not publicly addressable today", "no internet route or network ACL lets it in today", or "whether it is publicly addressable is unknown". A rule naming another VPC's CIDR becomes one *allowed* line from that VPC (through the peering, when there is one) |
| Secrets | a secret scheduled for deletion warns the resources that read or use it (not the key that encrypts it or a stack that manages it) |
| Unused | a security group nothing uses or references, a certificate no service uses, an IAM role never used — idle, not unhealthy |
| Cloud Map | a service with no instances registered while its ECS service wants tasks: discovery can't find them (warning) |
| Backups | the latest recovery point of each protected resource: failed, or older than 2 days, is a warning; `AVAILABLE` counts as a good backup, `CREATING` as one in progress |

## Environments

Every resource gets at most one environment, and the panel says why (`reported by ecs`, `tag Environment=prod`,
`name contains "staging"`, `VPC vpc-0abc`, `connected to api`). The first rule that answers wins:

| Rule | Example |
|---|---|
| 1. What the provider knows | an ECS service's cluster environment, the environment the ECS discovery attributed an RDS instance to, a declared workload's `env` |
| 2. Tag `console:env` | `console:env=payments` → **payments** |
| 3. Tag `Environment`, `environment`, `Env`, `env`, `Stage` or `stage` | `Environment=prd` → **production**; `Environment=shared` → shared on purpose |
| 4. A stage word in the name, when exactly one environment matches | `acme-staging-orders` → **staging**; `prod-to-staging-sync` → nothing |
| 5. The VPC, when everything placed by rules 1–4 in that VPC agrees | a Lambda in the production VPC → **production** |
| 6. Its connections, when every connected resource with an environment agrees (up to three hops) | a queue only production services write to → **production** |

What the provider knows comes first because it's authoritative: the ECS cluster a service runs in, or the entry a
workload is declared in, decides — whoever can tag a resource can't move it to another environment. Kubernetes
workloads run in their EKS cluster's environment, whatever their own tags or names say.

Environment ids are unique across regions: when a cluster's environment name repeats outside the home region it
becomes `<id>-<region>` (for example `production-eu-west-1`), and a resource in that region whose tag or name says
`production` lands there, not in the home region's environment.

Anything else is **shared** (shown without an environment). Tag values and names use the same stage words as the
environment pages ([How discovery works](discovery.md#environments-come-from-ecs-clusters)): `prod`, `prd`, `live` → production;
`stg`, `stage`, `preprod` → staging; `dev`, `development` → dev, and so on. A value that names an existing
environment maps to it (`Environment=production` → your ECS environment `prod`, if that's what it's called). Tag
values `shared`, `common`, `global`, `all`, `none` mean "no environment", on purpose.

The environment list is the ECS environments (always, with their own protected flag) plus every other id found in
tags and names. Those new environments are **protected** when they're production-like, or when a resource in them is
tagged `console:protected=true`.

### Which resources count as protected

Protection is decided per resource, and it fails safe. A resource follows the protected rules for
[actions](#actions) — the protected role, its name and a reason to confirm — when:

- **any** hint about it names a protected environment, not only the one it's shown in: its provider's hint, its
  `console:env`, `Environment`, `Env` or `Stage` tag, a stage word in its name, its VPC, its EKS cluster;
- it's tagged `console:protected=true`; or
- it's in no environment at all (shared on purpose, or nothing placed it): an unknown resource gets the careful rules,
  not the easy ones. Set `inventory.unassignedProtected` to `false` in [`console.config.json`](configuration.md#keys)
  to treat those like an unprotected environment instead; or
- its tags weren't read (a cap, a time budget, a refused read): it counts as protected until they are.

A tag can add protection but never take it away. `Environment=prod` on a service in the staging cluster leaves it
shown under staging, but protected; `console:env=staging` on `acme-production-sessions` shows it under staging, and
it stays protected because its name says production.

## Idle resources

A resource is marked **idle** when there is evidence nobody has used it for the idle window — 14 days by default,
`inventory.idleDays` in [`console.config.json`](configuration.md) (1–365):

| Evidence | Example |
|---|---|
| Its activity metrics (CloudWatch) add up to zero over the window | `no requests in 14 days` (load balancer), `no connections in 14 days` (RDS), `no invocations in 14 days` (Lambda) |
| No metrics, but the service's own last-activity time is older than the window | `last activity 2025-08-22, over 14 days ago` |
| It's stopped, and has been since before the window | `stopped since 2026-05-29` (an EC2 instance, an ECS service at 0 tasks) |

Every series that shows use must have been read: if Invocations (or requests, connections…) couldn't be read — denied,
failed, or held back by the hourly budget — the resource isn't marked idle, and its panel says there wasn't enough
evidence. Error counters alone (Errors, Throttles, 5XX) never make a resource idle.

Metrics win over anything else: a bucket whose provider says "last write in March" but which served requests this
week isn't idle. There's no mark without evidence — a resource with neither metrics nor a last-activity time is never
idle — and anything created inside the window is too new to judge. Which metric counts as activity for each service
is listed in [Supported services](services.md). Activity metrics are read in batches of 500 series per
`GetMetricData` call (CloudFront and Route 53 in `us-east-1`), once an hour per series (once a day for network,
security, monitoring and delivery resources), within `CONSOLE_ACTIVITY_BUDGET` (5,000 metrics an hour by default,
about $36 a month at most; [Configuration](configuration.md)). The simulated demo account reports last-activity times
instead.

The panel of an idle resource shows the daily activity behind the mark.

## Actions

Providers declare a few actions each — deploy new Lambda code, shift an alias, purge a queue, invalidate CloudFront
paths, stop an instance… The map's panel lists the ones that apply, greyed out with the reason when your role isn't
enough or the action can't run right now. Every action goes through one runner, in this order:

1. The action must exist for this kind of resource, and its input must match its schema.
2. Your role must hold the action's permission — the protected variant when the resource
   [counts as protected](#which-resources-count-as-protected) (see [Sign-in & roles](auth.md)). The console never acts
   on its own resources: its own ECS service, anything tagged `console:self=true`, and on plain EC2 the instance in
   `CONSOLE_SELF_INSTANCE`.
3. **Dry run**: the plan lists what will change, with warnings, and says what you'll have to type.
4. **Confirm**: `yes` for routine changes; the resource's **name** plus a **reason** (at least 3 characters) for
   dangerous actions and anything protected.
5. One change per resource at a time — across the map, the console's own buttons, variable saves and agents (the
   second is refused with who holds it). Inside that lock the resource's tags are read live; if they can't be, or they
   now say `console:protected=true` or `console:self=true`, the change is refused before anything is recorded. Then an
   audit entry and an operation record are written **before** anything runs (no audit, no action), the result after —
   ids, versions and sizes only, never a download link. Secret inputs are hidden in the audit log and large ones (an
   uploaded zip) summarised.
6. The provider re-reads that service, and the map shows the new state on the next load.

Every action shows what it needs from AWS (IAM), how to undo it and how success is verified ("done when …").

A few actions have limits of their own:

- **Deploy image** (ECS services) takes a full image URI with a tag or digest from `provisioning.allowedImageRegistries`
  when that's set; without it, only from the registry the container already uses. A new image runs with the
  service's role and every secret its task definition injects. It refuses when the service's task definition changed
  since the dry run (`expectedRevision`, which the plan returns in `echo` and the confirmation sends back): run the
  dry run again.
- **Send once.** Actions that would act twice if repeated are sent once and never retried: Lambda's test invoke, SNS
  publish, SQS test messages (unless a FIFO deduplication id lets SQS drop duplicates), a queue purge, and starting an
  EXPRESS Step Functions workflow. A STANDARD workflow started without a name gets `console-<quarter-hour>-<hash>`,
  shown in the plan: the same request repeated within the quarter-hour can't start it twice; give a name to start
  another. A purge whose outcome is unknown is never repeated automatically.
- **S3 upload, delete and download** refuse env files (`.env`, `.env.*`, anything ending in `.env`): those are read and
  edited only in a service's **Variables** tab. They also work only on buckets a hand-written IAM statement grants
  ([S3 file actions](permissions.md#s3-file-actions)).

Agents use the same runner through the `cloud.action` operation (below). With an API token, a dangerous action — or
any change on a resource that counts as protected, by exactly the runner's rules (so also one tagged
`console:protected=true`, or one in no environment) — becomes an approval request a person accepts in the console,
even for a token in *act* mode. Deploying new Lambda code or a new ECS image, sending a test message to a queue and
publishing a test message to a topic are dangerous: new code runs with the resource's role, and a message reaches
real consumers. A *read* token can't dry-run actions either. A few actions are for **people only** (a download link
hands out data): API tokens never see them, can't run them and can't even ask for them.

## Caching and limits

| What | Value |
|---|---|
| Map refresh | cached for 2 minutes; the next load after that shows the cached map and refreshes in the background. **Refresh** (`?refresh=1`) re-discovers everything, at most once every 20 seconds; because a full pass costs AWS calls (and CloudWatch money), it needs the developer role. After an action only that provider runs again, and the next load waits for it. Each source has its own freshness (2 minutes by default; an empty region is asked again after 30 minutes). The home region and global services come first; other regions are merged in within two minutes and the map says which are still being read. The browser revalidates with an ETag, so an unchanged map isn't sent again; hidden and generic rows are sent without their properties (the panel loads them). |
| Deleted resources | a resource missing from a complete read stays one more refresh, health unknown, "not seen since 14:02 UTC — confirming", and goes after the second complete read without it. A read that was cut short, capped, refused or failed never removes anything (a refused or failed source keeps showing what it found for 30 minutes, with the time) |
| Per provider | 25 seconds from when its run starts (at most 12 runs at a time). A provider that lists first and then enriches shows what it listed when time runs out, marked partial; one that fails keeps showing what it found for 30 minutes, with the time. A region where a service isn't offered is skipped, not an error |
| AWS calls | bounded per service and region where each call is sent, and at most 16 at a time overall (`CONSOLE_AWS_CONCURRENCY`), with adaptive retries; a provider's deadline cancels its queued calls |
| Resources | the first 2,000 of each type per provider (the map says when it cut something off) |
| Activity metrics | one datapoint per day over the idle window, each series read once an hour (support resources once a day) within `CONSOLE_ACTIVITY_BUDGET` metrics an hour; what doesn't fit waits for the next hour. Every batch AWS answered is kept; a batch that failed isn't asked for again until the hour is up either, so nothing is billed twice |
| Cloudflare | stops calling Cloudflare's API once the 25-second deadline has passed, and reads at most 20,000 DNS records per pass across all zones (the map says when it stopped there) |
| Region | every region in `CONSOLE_REGIONS` / `inventory.regions` (home first; default: the home region, `AWS_REGION`); global services (CloudFront, Route 53, Cloudflare) once. Resources outside home carry their region (and ECS, RDS, ElastiCache, load-balancer and EC2 keys an `@<region>` suffix) |
| After a restart | the last map is shown at once, each source marked "from <time> — refreshing", until the first pass finishes. It is kept in the console's database (environment values only encrypted), and only maps read from the same AWS account are shown |

## What's never shown

- **Values of environment variables, secrets and connection strings.** They're read on the server, matched against
  other resources' names and endpoints, and dropped (the copy kept for a restart stores them only encrypted). The map, the API and the operations only ever carry the
  variable's name as evidence. Credentials in a URL inside a property are masked before the property leaves the
  server, whatever a provider put there — `user:password@` and a lone token (`https://TOKEN@host`) alike.
- **What a value holds, beyond the connection.** A dotted **mentioned** line names the setting (`env DATABASE_URL`),
  never its value — but by being there it does tell you that the value contains the other resource's name, ARN or
  hostname. That's by design: it's the connection the map is there to show.
- **Current values in plans.** A plan to change a Lambda function's variables lists every variable you set as
  *changed* (new names as *added*) without comparing it with what's there, and a set that's too large is refused
  without an exact total — so a plan tells nothing about values nobody may read.
- Object contents, message bodies, function code or any application data.
- Anything from outside AWS and Cloudflare, apart from `console.config.json`.

## API and operations

| Call | Returns |
|---|---|
| `GET /api/inventory` (`?refresh=1`) | the whole map: resources, edges, environments, provider statuses, notes counts. `?refresh=1` needs the developer role (`403` otherwise) |
| `GET /api/inventory/detail?key=<key>` (`&prefix=…&token=…`) | one resource's extra detail (deployments, rules, versions, subscriptions…) and activity; `prefix` / `token` browse inside it (S3 folders; the next token comes back in `page.next`) |
| `GET /api/inventory/actions?key=<key>` | the actions that apply, with `allowed` and `blocked` for you |
| `POST /api/inventory/action` `{ key, provider, action, input, confirm?, reason?, dryRun? }` | `{ plan }` for a dry run (anything but an explicit `false` counts; a plan may carry `echo`, the fields the confirmation sends back in `input`), `202 { result, operationId }` for a run |
| `GET /api/inventory/coverage` | what the map knows and doesn't: last complete scan, sources denied or failing, capped types, sources shown from an older read, regions still being read, unresolved remote references (first 200), resources pending deletion confirmation, activity-metric spend, AWS call stats (operators and admins) and a freshness summary |

For agents: `cloud.map`, `cloud.get`, `cloud.actions` and `cloud.action` in the
[operations reference](operations.md#cloud-map).
