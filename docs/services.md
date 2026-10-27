# Supported services

What the cloud map discovers in an AWS account (and Cloudflare), how it connects resources to each other, which
actions it offers, and the permissions each needs. To set the permissions up, see [Permissions setup](permissions.md);
**Settings → AWS permissions** shows the same list for the build you're running, with live status.

One console covers one account and the regions it is set to read (`CONSOLE_REGIONS` or `inventory.regions`, home
first — [Configuration](configuration.md)); regional services are read in each of them. CloudFront, Route 53, IAM and
Cloudflare are global, and S3 lists every bucket the account owns, marked with its region.

## How resources get connected

Every arrow on the map says how the console knows about it, strongest first:

| Evidence | Shown as | Examples |
|---|---|---|
| **Configuration** — AWS stores the relationship | solid | a Lambda event source mapping on a queue, an SNS subscription, an EventBridge rule target, an S3 event notification, a CloudFront origin, a DNS record, a load balancer rule, an Auto Scaling group's instances |
| **Allowed** — the network permits it | dashed | a security group rule letting a service reach a database port |
| **Mentioned** — a name appears in configuration | dotted | an environment variable holding a queue URL, a bucket name or a database hostname |

Mentions are matched against every resource's ARN, name, aliases and endpoints on the server; values themselves are
never shown or sent to the browser. IAM policies as evidence ("this function may write to that table") are not used
yet.

## Services

Every service below is **available**. The IAM table at the bottom is generated from the code (`npm run iam:policy`),
and Settings → AWS permissions shows what your running console can actually read.

**Being added.** These services are registered but not read yet; Settings → AWS permissions lists them as *not implemented
yet*, and they need no permissions until they are: WAF, Cognito, AWS Backup, Global Accelerator, Classic Load
Balancers, Network Firewall, Route 53 Resolver, VPC Lattice, FSx, SageMaker and Bedrock (inventory only). Until then their resources still appear through the catch-all
([Other AWS resources](#other-aws-resources)).

Each action is *change* or *danger*. *Danger* actions can't be undone, run new code, or reach real consumers:
deploying new Lambda code or a new ECS image, invoking a function, sending a test message to a queue, publishing a
test message to a topic, purging a queue, starting a Step Functions execution, deleting an S3 object. They always ask
for the resource's name and a reason, and with an API token they always wait for a person's approval
([Agents & API](automation.md#tokens-and-modes)).

### Edge & DNS

| Service | Status | Discovers | Connects to | Actions |
|---|---|---|---|---|
| Route 53 | available | hosted zones (public and private; Cloud Map-managed ones say so), record counts, VPCs; health checks with what Route 53's checkers report (the first 50) | every alias / CNAME / A / AAAA record → what it points at (load balancer, CloudFront, API Gateway domain, S3 website, Elastic Beanstalk, App Runner, EC2 public IP), with its routing policy (weighted, failover, latency, geolocation, multivalue, IP-based); NS delegations to other zones; health check → what it watches | none (DNS edits are out of scope) |
| Cloudflare | available (needs a token) | zones: plan, status, name servers | every A / AAAA / CNAME record (proxied or DNS-only) → what it points at, such as a CloudFront distribution | purge cache |
| CloudFront | available | distributions (named by alias, Name tag, comment, then id), aliases, status | origins → S3 buckets, load balancers, API Gateway, custom hosts, labelled with their path patterns; access logs → bucket; Lambda@Edge → functions; its ACM certificate and WAF web ACL | invalidate paths |
| API Gateway | available | REST, HTTP and WebSocket APIs, stages, custom domains | routes and integrations → Lambda functions, HTTP backends, VPC links | redeploy a REST stage |
| AppSync | available | GraphQL APIs per region, with their GraphQL and real-time hosts; API keys are never read, and HTTP data sources' auth settings are dropped | data sources → Lambda functions, DynamoDB tables, OpenSearch, RDS clusters (and the secret they sign in with), HTTP hosts, EventBridge buses; roles; Lambda authorizer and Cognito user pool; log group; WAF web ACL | none |
| Amplify Hosting | available | apps per region, every branch and custom-domain host, the latest build per branch (the production branch first); a failed production build is an error, a failed build on another branch or a domain that isn't verified yet is a warning, an app with no branches is stopped; environment variables are matched, never shown; basic-auth credentials and build specs are never read; the repository is shown without credentials | app → its service and compute roles, branch backend stacks; certificate and WAF web ACL → app | none |
| Elastic Load Balancing | available | application, network and gateway load balancers per region, listed on their own: listeners, rules, target groups and every target's health (no readable target health is "unknown", never healthy) | rules → target groups → ECS services, EC2 instances, the ECS task or instance holding an IP target, Lambda functions; a rule's host header is a hostname of the service behind it | none |

### Compute

| Service | Status | Discovers | Connects to | Actions |
|---|---|---|---|---|
| ECS | available | services, tasks, images, revisions (the console's environments) | load balancers; databases and caches from connection strings and security groups; anything its environment variables mention | restart, stop / start, switch revision, scale and more, in the environment views ([Actions](actions.md)) |
| EC2 | available | instances with Elastic IPs, status checks, and what they belong to (ECS cluster, Auto Scaling group, EKS node group, Beanstalk environment) | security groups; DNS records pointing at their public IPs | start, stop, reboot (following the ECS hosts' power rules) |
| EC2 Auto Scaling | available | groups: size, members, launch template, health | member instances; target groups → load balancers | set desired capacity within the group's min..max (refused for groups EKS or Beanstalk own) |
| Lambda | available | functions, versions, aliases | event source mappings (SQS, Kinesis, DynamoDB streams); destinations and dead-letter queues; anything its environment variables mention; security groups | deploy code (zip, S3 object or image; *danger*), publish a version, shift an alias (canary weights), roll back an alias, invoke a test event (*danger*), set reserved concurrency, update variables (values never shown) |
| EKS | available | clusters, node groups; workloads (Deployments, StatefulSets…) with an access entry ([Permissions setup](permissions.md#5-kubernetes-workloads-on-eks-optional)) | node group instances; services and ingresses → load balancers | scale a node group; rollout restart and scale a Deployment / StatefulSet (needs an edit access policy) |
| App Runner | available | services, URLs, VPC connectors | DNS records pointing at the service URL | start a deployment, pause, resume |
| Elastic Beanstalk | available | environments, health, CNAME | its instances, Auto Scaling group and load balancer | deploy an existing application version, restart the app servers |
| AWS Batch | available | compute environments (invalid is an error, disabled is stopped) and job queues; a job waiting to run (RUNNABLE) for more than an hour is a warning; recent jobs date a queue's last activity; Batch's own ECS clusters are a property of the compute environment, never an environment | queue → its compute environments; instance, service and Spot fleet roles; EKS cluster; from the definitions its jobs ran: ECR images, job and execution roles, the secrets and parameters they read, log group; job-definition variables are matched, never shown | none |
| Lightsail | available | instances, container services and databases per region (regions without Lightsail are skipped); container variables are matched, never shown; container commands, key and master user names, and pending changes (which can carry a new password) are never read | container service → the ECR images it pulls | none |

### Messaging & events

| Service | Status | Discovers | Connects to | Actions |
|---|---|---|---|---|
| SQS | available | queues, depth, dead-letter queues | redrive → dead-letter queue; Lambda functions polling it | send a test message (*danger*), redrive a dead-letter queue, purge (*danger*) |
| SNS | available | topics | subscriptions → SQS, Lambda, HTTP endpoints | publish a test message (*danger*: it reaches real subscribers) |
| EventBridge | available | buses and rules, schedules | rule targets → Lambda, SQS, SNS, Step Functions and more | enable or disable a rule |
| Kinesis | available | data streams, consumers | Lambda functions reading it | — |
| Step Functions | available | state machines, recent executions | the services its definition calls (Lambda, SQS, SNS, ECS…) | start an execution (*danger*) |
| MSK | available | Kafka clusters (provisioned and serverless): state, brokers, every bootstrap broker host, authentication, public access | variables naming a broker host → the cluster; KMS key → cluster; cluster → its broker log group, Firehose stream or bucket | none |
| Amazon MQ | available | ActiveMQ and RabbitMQ brokers: engine, deployment mode, broker hosts (never credentials; user names are counted, not listed), public access | variables naming a broker host → the broker; KMS key → broker; broker → its log groups | none |
| Data Firehose | available | delivery streams: source, destinations, processors, encryption; HTTP endpoint attributes are matched, never shown | stream → its Kinesis stream or MSK topic, S3 buckets, OpenSearch domains, Redshift / Splunk / HTTP hosts, processor Lambdas, log group, roles; KMS key → stream | none |
| SES | available | e-mail identities and their verification; the account's sandbox, probation or shutdown state (the sandbox is a note, not a warning) | identity → the SNS topics, Firehose streams and EventBridge buses its configuration sets send events to | none |
| EventBridge Scheduler | available | schedules: expression in words, time zone, window, retries; disabled and finished one-time schedules show as stopped; inputs are matched, never shown | schedule → its target (Lambda, SQS, Step Functions…), dead-letter queue, role; ECS targets → the service running that task family (by its family ARN) | none |
| EventBridge Pipes | available | pipes: state, filters, source, enrichment and target; input templates and HTTP parameters are matched, never shown | pipe → its source (polled), enrichment, target, role, log destination; ECS targets → the service running that task family | none |

### Databases & storage

| Service | Status | Discovers | Connects to | Actions |
|---|---|---|---|---|
| RDS | available | database instances, attributed to environments | services reaching them (connection strings, security groups) | start / stop in the environment views, for instances tagged `console:power=allow` |
| ElastiCache | available | replication groups and clusters | services reaching them | none |
| DynamoDB | available | tables, streams | streams → Lambda functions | — |
| RDS clusters and proxies | available | Aurora and Multi-AZ DB clusters, DocumentDB and Neptune clusters, RDS proxies, per region: endpoints (writer, reader, custom), members, VPC and subnets, encryption, backups; a proxy's targets; a global database's primary → secondaries | a cluster endpoint in a variable → the cluster, its instances folded under it; proxy → its targets | none |
| ElastiCache Serverless | available | serverless caches per region: endpoint, usage limits, network, encryption | services reaching them | none |
| MemoryDB | available | clusters per region: shards, endpoint, TLS, encryption, ACL | services reaching them | none |
| OpenSearch | available | domains per region: endpoints (public, VPC, custom), nodes, storage, encryption, fine-grained access control, log publishing; a domain outside a VPC counts as public | services reaching them; KMS key → domain | none |
| Redshift | available | provisioned clusters (a paused one is stopped) and Serverless workgroups with their namespaces | services reaching them; KMS key, IAM roles | none |
| Transfer Family | available | SFTP/FTPS/FTP/AS2 servers per region: endpoints (with the `transfer:customHostname` tag), state, whether they're public, users' home directories; banners, host keys and session policies are never copied | server → its identity provider (Lambda or API Gateway), roles, users' home buckets and EFS file systems, log group, FTPS certificate, Elastic IPs; idle from bytes in **and** out | none |
| EFS | available | file systems per region: mount targets (VPC, subnets, security groups, addresses), access points, encryption; no mount targets is a warning | ECS services and Lambda functions mounting them | none |
| EBS | available | volumes, folded into the instance they're attached to; an unattached volume is a warning (billed per GB) | instance → its volumes; KMS key → volume | none |
| Athena | available | workgroups (the untouched default "primary" is hidden), where they write query results, encryption | workgroup → its results bucket; KMS key → workgroup | none |
| Glue | available | jobs and crawlers: last run or crawl (a failed one is a warning); a job's arguments are matched against other resources, never shown; connections are never read | job → its script and temp buckets, role; crawler → its S3 targets (and their events), table definitions, log group | none |
| S3 | available | every bucket the account owns: region, public access, website, versioning, encryption; the top of the bucket in its panel (keys, sizes, dates — never contents) | event notifications → Lambda, SQS, SNS, EventBridge; access logs and replication → buckets; website redirect → host | upload, delete, a 5-minute download link (the only way to object contents) — never on env files, and only on buckets a hand-written IAM statement grants ([S3 file actions](permissions.md#s3-file-actions)) |

### Network

| Service | Status | Discovers | Connects to | Actions |
|---|---|---|---|---|
| VPC networking | available | VPCs and subnets (each classed Public, Private (NAT), Private (routed), IPv6 egress-only or Isolated from its route table), NAT and internet gateways, endpoints, peerings, transit gateway attachments, VPN connections (tunnel status only), Elastic IPs attached to nothing (billed hourly); a subnet named private that routes 0.0.0.0/0 to an internet gateway, or that is running out of addresses, is a warning | resources → their VPC and subnets (folded); peering → both VPCs | none |
| Security groups | available | groups and their rules; open to the internet on anything but 80/443 is a warning; a group no network interface uses and no other group references is unused (default groups never are) | the "allowed" lines between resources; with a publicly addressable resource in a subnet routed to the internet whose network ACL lets the port in, an exposure error | none |
| Cloud Map | available | namespaces and services with their DNS names; a service with no instances is stopped | namespace → the hosted zone it manages; service → the ECS services and instances registered in it | none |

### Security & identity

| Service | Status | Discovers | Connects to | Actions |
|---|---|---|---|---|
| IAM | available | roles: who may assume them (trust policy), attached and inline policy names (never documents), permissions boundary, instance profiles, last use; service-linked and reserved roles are hidden; a role open to anyone is an error, another account without an external id a warning; a role never used is idle | what runs as a role (ECS tasks, Lambda functions, EC2 instance profiles, EKS…) → the role | none |
| KMS | available | keys with aliases, state, multi-Region role and rotation; AWS-managed keys are hidden; a key scheduled for deletion is an error | key → what it encrypts (named by the resources that use it); a disabled or dying key warns them | none |
| Certificate Manager | available | certificates of every key type (plus us-east-1, for CloudFront), expiry, renewal, validation; a failed certificate nothing uses is idle ("safe to delete") | certificate → what serves it (load balancers, CloudFront, API Gateway domains); an expiring one warns them | none |
| Secrets Manager | available | secrets' metadata only — never values: KMS key, rotation, last access, deletion schedule | secret → its rotation function; KMS key → secret; services that read it | none |
| Parameter Store | available | parameters' metadata only — never values: type, tier, version, KMS key, expiration | KMS key → SecureString parameters; services that read them | none |

### Monitoring & logs

| Service | Status | Discovers | Connects to | Actions |
|---|---|---|---|---|
| CloudWatch Logs | available | log groups: retention, size, class; one that never expires and holds more than 10 GiB is a warning; Container Insights and vended groups are listed but not drawn | ECS services (from their task definitions) and, by AWS's naming conventions, Lambda, RDS, CodeBuild, EKS and API Gateway → the groups they write to; subscriptions → their destinations | none |
| CloudWatch alarms | available | metric and composite alarms, state and actions; in ALARM is an error; stuck without data for more than a day with actions, or with actions disabled, is a warning; scaling alarms (target tracking's AlarmHigh/AlarmLow) never warn anything | alarm → what its metric names (ECS service, load balancer, database, queue, function…), dotted *monitors* lines; a firing alarm turns what it watches amber | none |
| CloudWatch Synthetics | available | canaries and their last run (a failed run is an error, whatever the services behind say) | canary → the Lambda function it runs on and its artifacts bucket | none |
| CloudTrail | available | trails: logging status (stopped is an error, failing delivery a warning) | trail → its bucket, log group and notification topic | none |

### Build & delivery

| Service | Status | Discovers | Connects to | Actions |
|---|---|---|---|---|
| ECR | available | repositories: the images ECS runs, what each tag points to now, critical findings on running images, lifecycle policy | ECS services → the repositories they pull from | none |
| CloudFormation | available | stacks: status, drift, safe outputs (anything that looks like a secret is hidden), what each stack manages | stack → the resources it manages | none |
| CodeBuild | available | projects and their last build; environment values are never shown | project → its role, source, artifacts (and their KMS key), build image, log groups | none |
| CodePipeline | available | pipelines: last run, disabled transitions | pipeline → what it builds and deploys | none |
| CodeDeploy | available | applications and deployment groups: last deployment, blue/green ECS services | deployment group → the ECS services and Auto Scaling groups it deploys to, its role, trigger targets | none |

All of these are read-only.

### Other AWS resources

Everything else the account holds comes from Resource Explorer (turn it on with an index in each region, or one
aggregator; the console reads the default view), or — without it — from the Tagging API, which only sees tagged
resources. AWS Config's inventory and Cloud Control types are opt-in (`inventory.catchAll` in
[Configuration](configuration.md#keys)). Rows that duplicate a resource the console already reads are folded into it
(their tags are added); sub-objects (rules, snapshots, versions…) are only counted; table-only types appear in
**All resources**; the long tail with no dedicated reader appears on the map under **Other services**.

### External

Systems outside AWS appear from `externals` in [console.config.json](configuration.md), and as a placeholder when a DNS
record or origin points at a hostname nothing in the account answers.

## Compatibility: how each service is verified

Four levels, each one stronger than the last. Nothing in this table is generated: it records what was checked, and
when.

- **Simulated** — the provider runs against the simulated Acme account (`CONSOLE_SOURCE=mock`) in the unit tests, the
  end-to-end inventory test (`src/lib/inventory/acme.test.ts`) and the smoke suite. Every built service is.
- **Contract-tested** — the provider's mapper is unit-tested on fixtures shaped like the AWS SDK's real responses
  (`src/lib/inventory/*.test.ts`), including pagination, missing fields and refusals. Every built service is.
- **Live-verified read** — the provider ran against a real account (read-only), and `scripts/parity.mjs` found the
  same resources per Resource Explorer type and region as AWS reports. *Ran live, empty* means the provider ran
  without error but that account has nothing of the kind, so there was nothing to compare. *Pending policy* means
  the account's read-only policy predates the provider: its reads were checked with the AWS CLI while it was built,
  and parity follows once the regenerated policy is applied ([Permissions setup](permissions.md)).
- **Live-verified write** — an action run against a real account and checked afterwards. **None yet**: that needs an
  acceptance account whose resources may be changed. Until then every action is simulated and contract-tested only
  (its plan, validation, typed confirmation, audit and the simulated change), and Settings → AWS permissions plus the
  console's own policy simulation say whether AWS would allow it.

Live reads were checked on 5 October 2026 against one account (ap-south-1 and us-east-1).

| Service (`id`) | Simulated | Contract-tested | Live-verified read | Actions (simulated; live write: none) |
|---|---|---|---|---|
| ECS (`ecs`), Elastic Load Balancing (`elb`), RDS (`rds`), ElastiCache (`elasticache`), EC2 (`ec2`) | yes | yes | **yes** | ECS: restart, stop / start, switch revision, scale, variables, create & scale ([Actions](actions.md)); EC2: start, stop, reboot |
| S3 (`s3`), CloudFront (`cloudfront`) | yes | yes | **yes** | S3: upload, delete*, download; CloudFront: invalidate |
| Route 53 (`route53`) | yes | yes | **yes** (CLI: Resource Explorer doesn't index private zones) | — |
| VPC networking (`vpc`), Security groups (`security-group`), EBS (`ebs`) | yes | yes | **yes** | — |
| Certificate Manager (`acm`), CloudWatch Logs (`logs`), ECR (`ecr`), Athena (`athena`), EventBridge (`eventbridge`) | yes | yes | **yes** | EventBridge: enable / disable a rule |
| Declared workloads (`declared`) | yes | yes | **yes** (from console.config.json) | — |
| EC2 Auto Scaling (`asg`), EKS (`eks`), App Runner (`apprunner`), Elastic Beanstalk (`beanstalk`) | yes | yes | ran live, empty | ASG: set desired capacity; EKS: scale a node group, rollout restart, scale a workload; App Runner: deploy, pause, resume; Beanstalk: deploy a version, restart app servers |
| Lambda (`lambda`), SQS (`sqs`), SNS (`sns`), Step Functions (`stepfunctions`), Kinesis (`kinesis`), DynamoDB (`dynamodb`), API Gateway (`apigateway`) | yes | yes | ran live, empty | Lambda: deploy code*, publish a version, shift / roll back an alias, invoke*, concurrency, variables; SQS: test message*, redrive, purge*; SNS: test message*; Step Functions: start*; API Gateway: redeploy a stage |
| ECS image deploys (`ecs-image`) | yes | yes | ran live, empty (an action, not a listing) | deploy an image* |
| CloudTrail (`cloudtrail`), CloudFormation (`cloudformation`), CodePipeline (`codepipeline`), CodeBuild (`codebuild`), CodeDeploy (`codedeploy`) | yes | yes | ran live, empty | — |
| RDS clusters (`rds-cluster`), ElastiCache Serverless (`elasticache-serverless`), OpenSearch (`opensearch`), Redshift (`redshift`), EFS (`efs`), Data Firehose (`firehose`), SES (`ses`) | yes | yes | ran live, empty | — |
| Cloud Map (`cloudmap`), IAM (`iam`), KMS (`kms`), Secrets Manager (`secrets`), Parameter Store (`ssm`), CloudWatch alarms (`alarms`), Synthetics (`synthetics`) | yes | yes | pending policy | — |
| MemoryDB (`memorydb`), Glue (`glue`), MSK (`msk`), Amazon MQ (`mq`), EventBridge Scheduler (`scheduler`), EventBridge Pipes (`pipes`) | yes | yes | pending policy | — |
| AWS Batch (`batch`), Transfer Family (`transfer`), AppSync (`appsync`), Amplify Hosting (`amplify`), Lightsail (`lightsail`) | yes | yes | pending policy | — |
| Other AWS resources (`catchall`) | yes | yes | pending policy (Resource Explorer `Search`, `tag:GetResources`) | — |
| Cloudflare (`cloudflare`) | yes | yes | not checked (needs a token) | purge cache |
| WAF, Cognito, AWS Backup, Global Accelerator, Classic Load Balancers, Network Firewall, Route 53 Resolver, VPC Lattice, FSx, SageMaker, Bedrock | — | — | being added (their resources appear through the catch-all) | — |

\* *danger*: always a typed name and a reason, and a person's approval for API tokens and agents.

To check your own account: `node scripts/parity.mjs --base <console URL> --profile <read-only profile> --regions
<a,b> [--expect expectations.json]` (header of the script for the expectations format). It exits non-zero on any
mismatch and prints each one. Where the map and Resource Explorer disagree, the service's own list call settles it:
Resource Explorer doesn't index everything (AWS-managed KMS keys, private hosted zones…) and keeps some released
resources for a while (Elastic IPs), so a disagreement the list call confirms is printed as information, not a mismatch.

## IAM actions by provider

Generated from the providers' declarations by `npm run iam:policy` (the IAM test fails when it's out of date). Discovery
actions are in both policies, data reads and actions only in `infra/iam-policy.json`. An action a hand-written
statement already grants — on every resource, or only on some (one bucket) or under a condition (a tag) — is still
listed here, but never generated again: the hand-written limit stays the limit. So `s3:GetObject`, `s3:PutObject` and
`s3:DeleteObject` come only from `EnvironmentFiles` (the env-files bucket), and `ec2:StartInstances`,
`ec2:StopInstances` and `ec2:RebootInstances` only from `PowerNonProtectedHostsAndDatabases` (instances tagged
`console:power=allow`).

<!-- generated by npm run iam:policy: begin -->

| Provider | Discovery (both policies) | Data reads (full policy only) | Actions (full policy only) |
|---|---|---|---|
| Certificate Manager (`acm`) | `acm:DescribeCertificate`, `acm:ListCertificates`, `acm:ListTagsForCertificate` | — | — |
| CloudWatch alarms (`alarms`) | `apigateway:GET`, `cloudwatch:DescribeAlarmHistory`, `cloudwatch:DescribeAlarms`, `cloudwatch:ListTagsForResource` | — | — |
| Amplify Hosting (`amplify`) | `amplify:ListApps`, `amplify:ListBranches`, `amplify:ListDomainAssociations`, `amplify:ListJobs` | — | — |
| API Gateway (`apigateway`) | `apigateway:GET` | — | `apigateway:POST` |
| App Runner (`apprunner`) | `apprunner:DescribeService`, `apprunner:DescribeVpcConnector`, `apprunner:ListOperations`, `apprunner:ListServices`, `apprunner:ListTagsForResource` | — | `apprunner:PauseService`, `apprunner:ResumeService`, `apprunner:StartDeployment` |
| AppSync (`appsync`) | `appsync:ListDataSources`, `appsync:ListGraphqlApis` | — | — |
| EC2 Auto Scaling (`asg`) | `autoscaling:DescribeAutoScalingGroups`, `autoscaling:DescribeScalingActivities`, `autoscaling:DescribeTags` | — | `autoscaling:SetDesiredCapacity` |
| Athena (`athena`) | `athena:GetWorkGroup`, `athena:ListWorkGroups` | — | — |
| AWS Backup (`backup`) | — | — | — |
| AWS Batch (`batch`) | `batch:DescribeComputeEnvironments`, `batch:DescribeJobDefinitions`, `batch:DescribeJobQueues`, `batch:ListJobs` | — | — |
| Elastic Beanstalk (`beanstalk`) | `cloudformation:DescribeStackResources`, `elasticbeanstalk:DescribeApplicationVersions`, `elasticbeanstalk:DescribeApplications`, `elasticbeanstalk:DescribeConfigurationSettings`, `elasticbeanstalk:DescribeEnvironmentHealth`, `elasticbeanstalk:DescribeEnvironmentResources`, `elasticbeanstalk:DescribeEnvironments`, `elasticbeanstalk:DescribeEvents`, `elasticbeanstalk:ListTagsForResource` | — | `elasticbeanstalk:RestartAppServer`, `elasticbeanstalk:UpdateEnvironment` |
| Bedrock (`bedrock`) | — | — | — |
| Other AWS resources (`catchall`) | `cloudformation:ListResources`, `config:DescribeConfigurationRecorderStatus`, `config:SelectResourceConfig`, `resource-explorer-2:ListIndexes`, `resource-explorer-2:Search`, `tag:GetResources` | — | — |
| Cloudflare (`cloudflare`) | Cloudflare token: `DNS:Read`, `Zone:Read` | — | Cloudflare token: `Cache Purge` |
| CloudFormation (`cloudformation`) | `cloudformation:DescribeStackEvents`, `cloudformation:DescribeStacks`, `cloudformation:ListStackResources`, `cloudformation:ListStacks` | — | — |
| CloudFront (`cloudfront`) | `cloudfront:GetDistributionConfig`, `cloudfront:GetInvalidation`, `cloudfront:ListDistributions`, `cloudfront:ListInvalidations`, `cloudfront:ListTagsForResource` | — | `cloudfront:CreateInvalidation` |
| Cloud Map (`cloudmap`) | `servicediscovery:GetInstancesHealthStatus`, `servicediscovery:ListInstances`, `servicediscovery:ListNamespaces`, `servicediscovery:ListServices`, `servicediscovery:ListTagsForResource` | — | — |
| CloudTrail (`cloudtrail`) | `cloudtrail:DescribeTrails`, `cloudtrail:GetTrailStatus`, `cloudtrail:ListTags` | — | — |
| CodeBuild (`codebuild`) | `codebuild:BatchGetBuilds`, `codebuild:BatchGetProjects`, `codebuild:ListBuildsForProject`, `codebuild:ListProjects` | — | — |
| CodeDeploy (`codedeploy`) | `codedeploy:BatchGetDeploymentGroups`, `codedeploy:BatchGetDeployments`, `codedeploy:ListApplications`, `codedeploy:ListDeploymentGroups`, `codedeploy:ListDeployments`, `codedeploy:ListTagsForResource` | — | — |
| CodePipeline (`codepipeline`) | `codepipeline:GetPipeline`, `codepipeline:GetPipelineState`, `codepipeline:ListPipelineExecutions`, `codepipeline:ListPipelines`, `codepipeline:ListTagsForResource` | — | — |
| Cognito user pools (`cognito`) | — | — | — |
| Declared in config (`declared`) | — | — | — |
| DynamoDB (`dynamodb`) | `dynamodb:DescribeTable`, `dynamodb:ListTables`, `dynamodb:ListTagsOfResource` | — | — |
| EBS volumes (`ebs`) | `ec2:DescribeVolumes` | — | — |
| EC2 (`ec2`) | `ec2:DescribeAddresses`, `ec2:DescribeInstanceStatus`, `ec2:DescribeInstances`, `ec2:DescribeSecurityGroups`, `ec2:DescribeTags` | — | `ec2:RebootInstances`, `ec2:StartInstances`, `ec2:StopInstances` |
| ECR repositories (`ecr`) | `ecr:DescribeImageScanFindings`, `ecr:DescribeImages`, `ecr:DescribeRepositories`, `ecr:GetLifecyclePolicy`, `ecr:ListTagsForResource` | — | — |
| ECS services (`ecs`) | `cloudwatch:GetMetricData`, `ec2:DescribeInstances`, `ec2:DescribeSecurityGroups`, `ec2:DescribeSubnets`, `ecs:DescribeClusters`, `ecs:DescribeContainerInstances`, `ecs:DescribeServices`, `ecs:DescribeTaskDefinition`, `ecs:DescribeTasks`, `ecs:ListClusters`, `ecs:ListContainerInstances`, `ecs:ListServices`, `ecs:ListTasks`, `elasticloadbalancing:DescribeTargetGroups` | `s3:GetObject` | — |
| ECS image deploys (`ecs-image`) | `ecs:ListTagsForResource` | — | `ecs:RegisterTaskDefinition`, `ecs:UpdateService`, `iam:PassRole` |
| EFS (`efs`) | `ec2:DescribeNetworkInterfaceAttribute`, `elasticfilesystem:DescribeAccessPoints`, `elasticfilesystem:DescribeFileSystems`, `elasticfilesystem:DescribeMountTargetSecurityGroups`, `elasticfilesystem:DescribeMountTargets` | — | — |
| EKS (`eks`) | `ec2:DescribeInstances`, `eks:DescribeCluster`, `eks:DescribeNodegroup`, `eks:ListAddons`, `eks:ListClusters`, `eks:ListFargateProfiles`, `eks:ListNodegroups` | — | `eks:UpdateNodegroupConfig` |
| ElastiCache (`elasticache`) | `elasticache:DescribeCacheClusters`, `elasticache:DescribeCacheSubnetGroups`, `elasticache:DescribeReplicationGroups`, `elasticache:ListTagsForResource` | — | — |
| ElastiCache Serverless (`elasticache-serverless`) | `elasticache:DescribeServerlessCaches`, `elasticache:ListTagsForResource` | — | — |
| Load balancers (`elb`) | `elasticloadbalancing:DescribeListeners`, `elasticloadbalancing:DescribeLoadBalancerAttributes`, `elasticloadbalancing:DescribeLoadBalancers`, `elasticloadbalancing:DescribeRules`, `elasticloadbalancing:DescribeTags`, `elasticloadbalancing:DescribeTargetGroups`, `elasticloadbalancing:DescribeTargetHealth` | — | — |
| Classic Load Balancers (`elb-classic`) | — | — | — |
| EventBridge (`eventbridge`) | `events:ListApiDestinations`, `events:ListEventBuses`, `events:ListRules`, `events:ListTagsForResource`, `events:ListTargetsByRule` | — | `events:DisableRule`, `events:EnableRule` |
| Data Firehose (`firehose`) | `firehose:DescribeDeliveryStream`, `firehose:ListDeliveryStreams`, `firehose:ListTagsForDeliveryStream` | — | — |
| FSx (`fsx`) | — | — | — |
| Global Accelerator (`globalaccelerator`) | — | — | — |
| Glue (`glue`) | `glue:GetCrawlers`, `glue:GetJobRuns`, `glue:GetJobs`, `glue:GetTags` | — | — |
| IAM roles (`iam`) | `iam:GetAccountAuthorizationDetails` | — | — |
| Kinesis (`kinesis`) | `kinesis:DescribeStreamSummary`, `kinesis:ListStreamConsumers`, `kinesis:ListStreams`, `kinesis:ListTagsForStream` | — | — |
| KMS keys (`kms`) | `kms:DescribeKey`, `kms:GetKeyRotationStatus`, `kms:ListAliases`, `kms:ListKeys`, `kms:ListResourceTags` | — | — |
| Lambda (`lambda`) | `cloudwatch:GetMetricData`, `lambda:GetFunctionConcurrency`, `lambda:GetFunctionConfiguration`, `lambda:GetPolicy`, `lambda:ListAliases`, `lambda:ListEventSourceMappings`, `lambda:ListFunctionEventInvokeConfigs`, `lambda:ListFunctionUrlConfigs`, `lambda:ListFunctions`, `lambda:ListTags`, `lambda:ListVersionsByFunction` | — | `lambda:DeleteFunctionConcurrency`, `lambda:InvokeFunction`, `lambda:PublishVersion`, `lambda:PutFunctionConcurrency`, `lambda:UpdateAlias`, `lambda:UpdateFunctionCode`, `lambda:UpdateFunctionConfiguration` |
| Lightsail (`lightsail`) | `lightsail:GetContainerServices`, `lightsail:GetInstances`, `lightsail:GetRelationalDatabases` | — | — |
| CloudWatch Logs (`logs`) | `logs:DescribeLogGroups`, `logs:DescribeLogStreams`, `logs:DescribeSubscriptionFilters`, `logs:ListTagsForResource` | — | — |
| MemoryDB (`memorydb`) | `memorydb:DescribeClusters`, `memorydb:ListTags` | — | — |
| Amazon MQ (`mq`) | `mq:DescribeBroker`, `mq:ListBrokers` | — | — |
| MSK (`msk`) | `kafka:GetBootstrapBrokers`, `kafka:ListClustersV2` | — | — |
| Network Firewall (`network-firewall`) | — | — | — |
| OpenSearch (`opensearch`) | `es:DescribeDomains`, `es:ListDomainNames`, `es:ListTags` | — | — |
| EventBridge Pipes (`pipes`) | `pipes:DescribePipe`, `pipes:ListPipes` | — | — |
| RDS databases (`rds`) | `rds:DescribeDBInstances` | — | — |
| RDS clusters and proxies (`rds-cluster`) | `rds:DescribeDBClusters`, `rds:DescribeDBProxies`, `rds:DescribeDBProxyTargets`, `rds:DescribeDBSubnetGroups`, `rds:DescribeGlobalClusters` | — | — |
| Redshift (`redshift`) | `redshift-serverless:ListNamespaces`, `redshift-serverless:ListWorkgroups`, `redshift:DescribeClusters` | — | — |
| Route 53 (`route53`) | `route53:GetHealthCheckStatus`, `route53:GetHostedZone`, `route53:ListHealthChecks`, `route53:ListHostedZones`, `route53:ListResourceRecordSets`, `route53:ListTagsForResources` | — | — |
| Route 53 Resolver (`route53-resolver`) | — | — | — |
| S3 (`s3`) | `s3:GetBucketLocation`, `s3:GetBucketLogging`, `s3:GetBucketNotification`, `s3:GetBucketPolicyStatus`, `s3:GetBucketPublicAccessBlock`, `s3:GetBucketTagging`, `s3:GetBucketVersioning`, `s3:GetBucketWebsite`, `s3:GetEncryptionConfiguration`, `s3:GetReplicationConfiguration`, `s3:ListAllMyBuckets`, `s3:ListBucket` | `s3:GetObject` | `s3:DeleteObject`, `s3:PutObject` |
| SageMaker (`sagemaker`) | — | — | — |
| EventBridge Scheduler (`scheduler`) | `scheduler:GetSchedule`, `scheduler:ListSchedules` | — | — |
| Secrets Manager (`secrets`) | `secretsmanager:DescribeSecret`, `secretsmanager:ListSecrets` | — | — |
| Security groups (`security-group`) | `ec2:DescribeNetworkInterfaces`, `ec2:DescribeSecurityGroupRules`, `ec2:DescribeSecurityGroups` | — | — |
| SES (`ses`) | `ses:GetAccount`, `ses:GetConfigurationSetEventDestinations`, `ses:GetEmailIdentity`, `ses:ListConfigurationSets`, `ses:ListEmailIdentities` | — | — |
| SNS (`sns`) | `sns:GetSubscriptionAttributes`, `sns:GetTopicAttributes`, `sns:ListSubscriptionsByTopic`, `sns:ListTagsForResource`, `sns:ListTopics` | `kms:Decrypt` | `kms:GenerateDataKey`, `sns:Publish` |
| SQS (`sqs`) | `sqs:GetQueueAttributes`, `sqs:ListMessageMoveTasks`, `sqs:ListQueueTags`, `sqs:ListQueues` | `kms:Decrypt` | `kms:GenerateDataKey`, `sqs:DeleteMessage`, `sqs:PurgeQueue`, `sqs:ReceiveMessage`, `sqs:SendMessage`, `sqs:StartMessageMoveTask` |
| Parameter Store (`ssm`) | `ssm:DescribeParameters`, `ssm:ListTagsForResource` | — | — |
| Step Functions (`stepfunctions`) | `states:DescribeStateMachine`, `states:ListExecutions`, `states:ListStateMachines`, `states:ListTagsForResource` | — | `states:StartExecution` |
| CloudWatch Synthetics (`synthetics`) | `synthetics:DescribeCanaries`, `synthetics:DescribeCanariesLastRun` | — | — |
| Transfer Family (`transfer`) | `transfer:DescribeServer`, `transfer:ListServers`, `transfer:ListUsers` | — | — |
| VPC networking (`vpc`) | `ec2:DescribeAddresses`, `ec2:DescribeEgressOnlyInternetGateways`, `ec2:DescribeFlowLogs`, `ec2:DescribeInternetGateways`, `ec2:DescribeNatGateways`, `ec2:DescribeNetworkAcls`, `ec2:DescribeRouteTables`, `ec2:DescribeSubnets`, `ec2:DescribeTransitGatewayAttachments`, `ec2:DescribeVpcEndpoints`, `ec2:DescribeVpcPeeringConnections`, `ec2:DescribeVpcs`, `ec2:DescribeVpnConnections` | — | — |
| VPC Lattice (`vpc-lattice`) | — | — | — |
| WAF (`waf`) | — | — | — |

<!-- generated by npm run iam:policy: end -->
