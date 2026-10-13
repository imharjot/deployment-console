import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arnBase, arnName, arnOf, arnType, parseArn, partitionOf } from "./arn.ts";
import { keyRegion, keys } from "./types.ts";

const A = "123456789012";
const R = "us-east-1";
const SNAPSHOT = new Set((JSON.parse(readFileSync(new URL("./aws-resource-types.json", import.meta.url), "utf8")) as { types: string[] }).types);
const typeOf = (arn: string) => {
  const p = parseArn(arn);
  assert.ok(p, `parses: ${arn}`);
  return arnType(p);
};
const nameOf = (arn: string, tags?: Record<string, string>) => arnName(parseArn(arn)!, tags);

test("parseArn: the parts, an empty region and account for global ARNs, nothing for non-ARNs", () => {
  assert.deepEqual(parseArn(`arn:aws:lambda:${R}:${A}:function:orders`), { partition: "aws", service: "lambda", region: R, account: A, resource: "function:orders", type: "function", id: "orders" });
  assert.deepEqual(parseArn("arn:aws:s3:::acme-logs"), { partition: "aws", service: "s3", region: "", account: "", resource: "acme-logs", type: "bucket", id: "acme-logs" });
  const iam = parseArn(`arn:aws:iam::${A}:role/service-role/acme-codebuild`)!;
  assert.equal(iam.region, "");
  assert.equal(iam.account, A);
  assert.equal(parseArn("arn:aws:iam::aws:policy/ReadOnlyAccess")?.account, "aws");
  assert.equal(parseArn("arn:aws-cn:s3:::bucket")?.partition, "aws-cn");
  for (const bad of ["", "not-an-arn", "arn:aws:lambda", "https://sqs.us-east-1.amazonaws.com/123456789012/q", "arn:aws:Lambda:us-east-1:123:function:x"]) assert.equal(parseArn(bad), undefined, bad);
});

test("types without a segment: s3, sqs, sns, codepipeline, codecommit — the name is never the type (CC-8)", () => {
  assert.equal(typeOf("arn:aws:s3:::acme-logs"), "s3:bucket");
  assert.equal(typeOf("arn:aws:s3:::acme-logs/alb/2026/10/05/log.gz"), "s3:bucket", "an object folds to its bucket");
  assert.equal(parseArn("arn:aws:s3:::acme-logs/alb/x.gz")?.id, "acme-logs");
  assert.equal(typeOf(`arn:aws:s3:${R}:${A}:accesspoint/acme-uploads-ap`), "s3:accesspoint");
  assert.equal(typeOf(`arn:aws:sqs:${R}:${A}:acme-production-orders`), "sqs:queue");
  assert.equal(typeOf(`arn:aws:sns:${R}:${A}:acme-alarms`), "sns:topic");
  assert.equal(typeOf(`arn:aws:sns:${R}:${A}:acme-alarms:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b`), "sns:subscription");
  assert.equal(typeOf(`arn:aws:codepipeline:${R}:${A}:acme-billing-release`), "codepipeline:pipeline");
  assert.equal(nameOf(`arn:aws:codepipeline:${R}:${A}:acme-billing-release`), "acme-billing-release");
  assert.equal(typeOf(`arn:aws:codecommit:${R}:${A}:acme-infra`), "codecommit:repository");
});

test("sub-types as Resource Explorer spells them", () => {
  assert.equal(typeOf(`arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/app/acme-production/5f2c1a9d3e7b4c60`), "elasticloadbalancing:loadbalancer/app");
  assert.equal(typeOf(`arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/net/acme-nlb/0a1b2c3d4e5f6a7b`), "elasticloadbalancing:loadbalancer/net");
  assert.equal(typeOf(`arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/acme-legacy-clb`), "elasticloadbalancing:loadbalancer", "classic");
  assert.equal(typeOf(`arn:aws:elasticloadbalancing:${R}:${A}:listener/app/acme-production/5f2c1a9d3e7b4c60/9e8d7c6b5a4f3e2d`), "elasticloadbalancing:listener/app");
  assert.equal(typeOf(`arn:aws:elasticloadbalancing:${R}:${A}:listener-rule/app/acme-production/5f2c1a9d3e7b4c60/9e8d7c6b5a4f3e2d/1a2b3c4d5e6f7a8b`), "elasticloadbalancing:listener-rule/app");
  assert.equal(typeOf(`arn:aws:elasticloadbalancing:${R}:${A}:targetgroup/acme-api/0a1b2c3d4e5f6a7b`), "elasticloadbalancing:targetgroup");
  assert.equal(typeOf(`arn:aws:apigateway:${R}::/restapis/p9q8r7s6t5`), "apigateway:restapis");
  assert.equal(typeOf(`arn:aws:apigateway:${R}::/restapis/p9q8r7s6t5/stages/prod`), "apigateway:restapis/stages");
  assert.equal(typeOf(`arn:aws:apigateway:${R}::/restapis/p9q8r7s6t5/resources/abc123/methods/GET`), "apigateway:restapis/resources/methods");
  assert.equal(typeOf(`arn:aws:apigateway:${R}::/apis/a1b2c3d4e5/routes/r1`), "apigateway:apis/routes");
  assert.equal(typeOf(`arn:aws:lambda:${R}:${A}:function:orders:live`), "lambda:function/version");
  assert.equal(typeOf(`arn:aws:lambda:${R}:${A}:function:orders:7`), "lambda:function/version");
  assert.equal(typeOf(`arn:aws:lambda:${R}:${A}:layer:acme-common:3`), "lambda:layer/version");
  assert.equal(typeOf(`arn:aws:lambda:${R}:${A}:event-source-mapping:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b`), "lambda:event-source-mapping");
  assert.equal(typeOf(`arn:aws:wafv2:${R}:${A}:regional/webacl/acme-production-web/0acme0e5`), "wafv2:webacl");
  assert.equal(typeOf(`arn:aws:wafv2:us-east-1:${A}:global/webacl/acme-cloudfront-web/0acme0e5`), "wafv2:webacl");
  assert.equal(typeOf(`arn:aws:globalaccelerator::${A}:accelerator/0acme/listener/0abc`), "globalaccelerator:accelerator/listener");
  assert.equal(typeOf(`arn:aws:amplify:${R}:${A}:apps/d0acme0mkt0site/branches/main`), "amplify:apps/branches");
  assert.equal(typeOf(`arn:aws:vpc-lattice:${R}:${A}:service/svc-0acme/listener/listener-0abc`), "vpc-lattice:service/listener");
  assert.equal(typeOf(`arn:aws:bedrock:${R}:${A}:flow/FLOW1/alias/ALIAS1`), "bedrock:flow/alias");
  assert.equal(typeOf(`arn:aws:logs:${R}:${A}:log-group:/ecs/acme-production/api:*`), "logs:log-group");
  assert.equal(typeOf(`arn:aws:logs:${R}:${A}:log-group:/ecs/acme-production/api:log-stream:ecs/api/abc`), "logs:log-stream");
});

test("everything else splits at the first / before any :, else at the first :", () => {
  assert.equal(typeOf(`arn:aws:ecs:${R}:${A}:task-definition/api-production:120`), "ecs:task-definition", "a / before the :");
  assert.equal(typeOf(`arn:aws:rds:${R}:${A}:db:acme-production-pg`), "rds:db");
  assert.equal(typeOf(`arn:aws:codedeploy:${R}:${A}:deploymentgroup:acme-legacy-admin/acme-legacy-admin-prod`), "codedeploy:deploymentgroup", "a : before the /");
  assert.equal(typeOf(`arn:aws:autoscaling:${R}:${A}:autoScalingGroup:0f1e:autoScalingGroupName/acme-workers`), "autoscaling:autoScalingGroup");
  assert.equal(typeOf(`arn:aws:iam::${A}:role/service-role/acme-codebuild`), "iam:role");
  assert.equal(typeOf(`arn:aws:secretsmanager:${R}:${A}:secret:acme/production/api-Ab12Cd`), "secretsmanager:secret");
  assert.equal(typeOf(`arn:aws:ec2:${R}:${A}:security-group/sg-prod-api`), "ec2:security-group");
  assert.equal(typeOf(`arn:aws:kafka:${R}:${A}:cluster/acme-events/0acme-1`), "kafka:cluster");
});

test("arnName: Name tag first, then the per-service rule", () => {
  const alb = `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/app/acme-production/5f2c1a9d3e7b4c60`;
  assert.equal(nameOf(alb), "acme-production");
  assert.equal(nameOf(alb, { Name: "Storefront ALB" }), "Storefront ALB");
  assert.equal(nameOf(alb, { Name: "  " }), "acme-production", "a blank Name tag doesn't count");
  assert.equal(nameOf(`arn:aws:ecs:${R}:${A}:service/acme-production/api`), "api");
  assert.equal(nameOf(`arn:aws:ecs:${R}:${A}:service/api`), "api", "old ARN format");
  assert.equal(nameOf(`arn:aws:cloudformation:${R}:${A}:stack/acme-network/0acme0f1-3333-4444-8555-000000000001`), "acme-network");
  assert.equal(nameOf(`arn:aws:codedeploy:${R}:${A}:deploymentgroup:acme-legacy-admin/acme-legacy-admin-prod`), "acme-legacy-admin-prod");
  assert.equal(nameOf(`arn:aws:ssm:${R}:${A}:parameter/acme/production/api/JWT_SIGNING_KEY`), "/acme/production/api/JWT_SIGNING_KEY");
  assert.equal(nameOf(`arn:aws:iam::${A}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS`), "AWSServiceRoleForECS");
  assert.equal(nameOf(`arn:aws:kafka:${R}:${A}:cluster/acme-events/0acme0c3-1`), "acme-events");
  assert.equal(nameOf(`arn:aws:wafv2:${R}:${A}:regional/webacl/acme-production-web/0acme0e5`), "acme-production-web");
  assert.equal(nameOf(`arn:aws:mq:${R}:${A}:broker:acme-legacy-mq:b-0acme0d4`), "acme-legacy-mq");
  assert.equal(nameOf(`arn:aws:autoscaling:${R}:${A}:autoScalingGroup:0f1e:autoScalingGroupName/acme-workers`), "acme-workers");
  assert.equal(nameOf(`arn:aws:events:${R}:${A}:rule/acme-shop-events/acme-production-order-placed`), "acme-production-order-placed");
  assert.equal(nameOf(`arn:aws:ec2:${R}:${A}:vpc/vpc-prod`), "vpc-prod", "id-only ARNs: the id");
  assert.equal(nameOf(`arn:aws:redshift-serverless:${R}:${A}:workgroup/0acme0b2`), "0acme0b2");
  assert.equal(nameOf(`arn:aws:secretsmanager:${R}:${A}:secret:acme/production/api-Ab12Cd`), "acme/production/api-Ab12Cd", "never strip -xxxxxx by regex");
  assert.equal(nameOf("arn:aws:s3:::acme-logs"), "acme-logs");
});

test("arnBase: log group :*, Lambda qualifier, secret JSON key / stage / version", () => {
  assert.equal(arnBase(`arn:aws:logs:${R}:${A}:log-group:/aws/lambda/orders:*`), `arn:aws:logs:${R}:${A}:log-group:/aws/lambda/orders`);
  assert.equal(arnBase(`arn:aws:logs:${R}:${A}:log-group:/aws/lambda/orders`), `arn:aws:logs:${R}:${A}:log-group:/aws/lambda/orders`);
  assert.equal(arnBase(`arn:aws:lambda:${R}:${A}:function:orders:live`), `arn:aws:lambda:${R}:${A}:function:orders`);
  assert.equal(arnBase(`arn:aws:lambda:${R}:${A}:function:orders`), `arn:aws:lambda:${R}:${A}:function:orders`);
  const secret = `arn:aws:secretsmanager:${R}:${A}:secret:acme/production/api-Ab12Cd`;
  assert.equal(arnBase(`${secret}:stripe_key::`), secret);
  assert.equal(arnBase(`${secret}:stripe_key:AWSCURRENT:`), secret);
  assert.equal(arnBase(secret), secret);
  assert.equal(arnBase("not-an-arn"), "not-an-arn");
});

test("arnOf builds the ARN AWS returns, in the region's partition", () => {
  assert.equal(arnOf.securityGroup(R, A, "sg-prod-api"), `arn:aws:ec2:${R}:${A}:security-group/sg-prod-api`);
  assert.equal(arnOf.logGroup(R, A, "/ecs/acme-production/api"), `arn:aws:logs:${R}:${A}:log-group:/ecs/acme-production/api`, "logGroupArn: no :*");
  assert.equal(arnOf.ssmParameter(R, A, "/acme/production/api/JWT_SIGNING_KEY"), `arn:aws:ssm:${R}:${A}:parameter/acme/production/api/JWT_SIGNING_KEY`);
  assert.equal(arnOf.ssmParameter(R, A, "plain"), `arn:aws:ssm:${R}:${A}:parameter/plain`);
  assert.equal(arnOf.secretPartial(R, A, "acme/production/api"), `arn:aws:secretsmanager:${R}:${A}:secret:acme/production/api`);
  assert.equal(arnOf.kmsAlias(R, A, "aws/rds"), `arn:aws:kms:${R}:${A}:alias/aws/rds`);
  assert.equal(arnOf.kmsAlias(R, A, "alias/acme-production"), `arn:aws:kms:${R}:${A}:alias/acme-production`);
  assert.equal(arnOf.iamRole(A, "acme-codebuild", "/service-role/"), `arn:aws:iam::${A}:role/service-role/acme-codebuild`);
  assert.equal(arnOf.iamRole(A, "acme-lambda-exec"), `arn:aws:iam::${A}:role/acme-lambda-exec`);
  assert.equal(arnOf.iamRole(A, "x", "aws-service-role/ecs.amazonaws.com"), `arn:aws:iam::${A}:role/aws-service-role/ecs.amazonaws.com/x`);
  assert.equal(arnOf.healthCheck("4f9a"), "arn:aws:route53:::healthcheck/4f9a");
  assert.equal(arnOf.pipeline(R, A, "acme-billing-release"), `arn:aws:codepipeline:${R}:${A}:acme-billing-release`);
  assert.equal(arnOf.sagemakerEndpoint(R, A, "Acme-Recs"), `arn:aws:sagemaker:${R}:${A}:endpoint/acme-recs`, "SageMaker lower-cases names");
  assert.equal(arnOf.classicElb(R, A, "acme-legacy-clb"), `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/acme-legacy-clb`);
  assert.equal(arnOf.rdsDb("cn-north-1", A, "db1"), `arn:aws-cn:rds:cn-north-1:${A}:db:db1`);
  assert.equal(partitionOf("us-gov-west-1"), "aws-us-gov");
  assert.equal(partitionOf("eu-west-1"), "aws");
  assert.equal(partitionOf("us-isob-east-1"), "aws-iso-b");
  assert.equal(partitionOf("eusc-de-east-1"), "aws-eusc");
  assert.equal(arnOf.iamRole(A, "acme-lambda-exec", "/", partitionOf("cn-north-1")), `arn:aws-cn:iam::${A}:role/acme-lambda-exec`, "global builders take the home partition");
  assert.equal(arnOf.healthCheck("4f9a", "aws-us-gov"), "arn:aws-us-gov:route53:::healthcheck/4f9a");
  assert.equal(parseArn(arnOf.iamRole(A, "x", "/", "aws-us-gov"))?.partition, "aws-us-gov");
});

test("every arnOf builder's key parses back to a type Resource Explorer knows (or a known gap)", () => {
  // Types Resource Explorer doesn't index (CC-8): their keys are still ARNs, the catch-all just never lists them. A KMS
  // alias ARN is an alias of a key, never a key itself.
  const NOT_INDEXED = new Set(["kms:alias", "elasticache:serverlesscache", "scheduler:schedule", "redshift-serverless:workgroup", "lightsail:Instance", "lightsail:ContainerService", "lightsail:RelationalDatabase", "bedrock:provisioned-model", "codedeploy:deploymentgroup", "servicediscovery:namespace"]);
  const o = arnOf;
  const examples: Record<keyof typeof arnOf, string> = {
    vpc: o.vpc(R, A, "vpc-prod"), subnet: o.subnet(R, A, "subnet-prod-a"), natGateway: o.natGateway(R, A, "nat-0prod"), internetGateway: o.internetGateway(R, A, "igw-prod"),
    egressOnlyInternetGateway: o.egressOnlyInternetGateway(R, A, "eigw-0prod"), vpcEndpoint: o.vpcEndpoint(R, A, "vpce-0prod"), vpcPeering: o.vpcPeering(R, A, "pcx-0acme"),
    transitGatewayAttachment: o.transitGatewayAttachment(R, A, "tgw-attach-0acme"), eip: o.eip(R, A, "eipalloc-0acme"), vpnConnection: o.vpnConnection(R, A, "vpn-0acme"),
    routeTable: o.routeTable(R, A, "rtb-prod"), networkAcl: o.networkAcl(R, A, "acl-prod"), securityGroup: o.securityGroup(R, A, "sg-prod-api"), ec2Instance: o.ec2Instance(R, A, "i-0acme"),
    ebsVolume: o.ebsVolume(R, A, "vol-0acme"), cloudMapNamespace: o.cloudMapNamespace(R, A, "ns-acme"), cloudMapService: o.cloudMapService(R, A, "srv-acme"),
    networkFirewall: o.networkFirewall(R, A, "acme-egress-fw"), resolverEndpoint: o.resolverEndpoint(R, A, "rslvr-out-0acme"), resolverRule: o.resolverRule(R, A, "rslvr-rr-0acme"),
    latticeServiceNetwork: o.latticeServiceNetwork(R, A, "sn-0acme"), latticeService: o.latticeService(R, A, "svc-0acme"), iamRole: o.iamRole(A, "acme-lambda-exec"),
    iamInstanceProfile: o.iamInstanceProfile(A, "acme-ecs-instance"), kmsKey: o.kmsKey(R, A, "mrk-0acme"), kmsAlias: o.kmsAlias(R, A, "acme-production"), acmCertificate: o.acmCertificate(R, A, "0acme"),
    secretPartial: o.secretPartial(R, A, "acme/production/api"), ssmParameter: o.ssmParameter(R, A, "/acme/x"), wafAcl: o.wafAcl(R, A, "regional", "acme-production-web", "0acme"),
    cognitoUserPool: o.cognitoUserPool(R, A, `${R}_AcMe12345`), backupPlan: o.backupPlan(R, A, "0acme"), backupVault: o.backupVault(R, A, "acme-backups"), logGroup: o.logGroup(R, A, "/ecs/acme-production/api"),
    cloudwatchAlarm: o.cloudwatchAlarm(R, A, "acme-production-pg-cpu-high"), syntheticsCanary: o.syntheticsCanary(R, A, "acme-checkout-canary"), healthCheck: o.healthCheck("4f9a1c2e"),
    cloudtrailTrail: o.cloudtrailTrail(R, A, "acme-trail"), ecrRepository: o.ecrRepository(R, A, "acme/storefront-api"), pipeline: o.pipeline(R, A, "acme-billing-release"),
    codebuildProject: o.codebuildProject(R, A, "acme-billing-build"), codedeployGroup: o.codedeployGroup(R, A, "acme-legacy-admin", "acme-legacy-admin-prod"),
    cfnStack: o.cfnStack(R, A, "acme-network", "0acme0f1"), rdsDb: o.rdsDb(R, A, "acme-production-pg"), rdsCluster: o.rdsCluster(R, A, "acme-analytics"), rdsProxy: o.rdsProxy(R, A, "prx-0acme"),
    elasticacheRg: o.elasticacheRg(R, A, "acme-production-valkey"), elasticacheCluster: o.elasticacheCluster(R, A, "acme-production-valkey-001"),
    elasticacheServerless: o.elasticacheServerless(R, A, "acme-sessions-cache"), memorydbCluster: o.memorydbCluster(R, A, "acme-ratelimits"), opensearchDomain: o.opensearchDomain(R, A, "acme-search"),
    redshiftCluster: o.redshiftCluster(R, A, "acme-analytics-dw"), redshiftWorkgroup: o.redshiftWorkgroup(R, A, "0acme0b2"), glueJob: o.glueJob(R, A, "acme-nightly-etl"),
    glueCrawler: o.glueCrawler(R, A, "acme-orders-crawler"), athenaWorkgroup: o.athenaWorkgroup(R, A, "acme-analysts"), efs: o.efs(R, A, "fs-0acme"), efsAccessPoint: o.efsAccessPoint(R, A, "fsap-0acme"),
    fsx: o.fsx(R, A, "fs-0acme"), mskCluster: o.mskCluster(R, A, "acme-events", "0acme-1"), mqBroker: o.mqBroker(R, A, "acme-legacy-mq", "b-0acme"), firehose: o.firehose(R, A, "acme-clickstream-to-s3"),
    schedule: o.schedule(R, A, "default", "acme-daily-digest"), pipe: o.pipe(R, A, "acme-orders-to-checkout"), sesIdentity: o.sesIdentity(R, A, "acme.example"),
    globalAccelerator: o.globalAccelerator(A, "0acme"), classicElb: o.classicElb(R, A, "acme-legacy-clb"), transferServer: o.transferServer(R, A, "s-0acme"), appsyncApi: o.appsyncApi(R, A, "acme0catalog"),
    amplifyApp: o.amplifyApp(R, A, "d0acme"), lightsailInstance: o.lightsailInstance(R, A, "0acme"), lightsailContainer: o.lightsailContainer(R, A, "0acme"), lightsailDatabase: o.lightsailDatabase(R, A, "0acme"),
    batchEnvironment: o.batchEnvironment(R, A, "acme-batch-spot"), batchQueue: o.batchQueue(R, A, "acme-reports"), sagemakerEndpoint: o.sagemakerEndpoint(R, A, "acme-recs"),
    sagemakerNotebook: o.sagemakerNotebook(R, A, "acme-notebook"), bedrockAgent: o.bedrockAgent(R, A, "ACMEAGENT1"), bedrockKnowledgeBase: o.bedrockKnowledgeBase(R, A, "ACMEKB0001"),
    bedrockProvisionedModel: o.bedrockProvisionedModel(R, A, "acme0pt"), ecsService: o.ecsService(R, A, "acme-production", "api"),
  };
  for (const [name, arn] of Object.entries(examples)) {
    const p = parseArn(arn);
    assert.ok(p, `${name}: ${arn} parses`);
    const type = arnType(p);
    assert.ok(SNAPSHOT.has(type) || NOT_INDEXED.has(type), `${name}: ${arn} → ${type}, not a Resource Explorer type`);
  }
  assert.equal(parseArn(examples.ecsService)!.id, "acme-production/api");
  assert.equal(nameOf(examples.ecsService), "api");
});

test("keys.*: an @region suffix only outside the home region (CC-6); keyRegion reads it back", () => {
  assert.equal(keys.ecsService("acme-production", "api"), "ecs:service/acme-production/api", "single-region keys are unchanged");
  assert.equal(keys.ecsService("acme-production", "api", "us-east-1", "us-east-1"), "ecs:service/acme-production/api");
  assert.equal(keys.ecsService("acme-production", "api", "eu-west-1", "us-east-1"), "ecs:service/acme-production/api@eu-west-1");
  assert.equal(keys.ecsService("acme-production", "api", "eu-west-1"), "ecs:service/acme-production/api", "no home given: region-less");
  assert.equal(keys.rds("acme-production-eu-pg", "eu-west-1", "us-east-1"), "rds:acme-production-eu-pg@eu-west-1");
  assert.equal(keys.loadBalancer("acme-production", "eu-west-1", "us-east-1"), "elb:acme-production@eu-west-1");
  assert.equal(keys.elasticache("acme-production-valkey", "us-east-1", "us-east-1"), "elasticache:acme-production-valkey");
  assert.equal(keys.ec2("i-0acme", "eu-west-1", "us-east-1"), "ec2:i-0acme@eu-west-1");
  assert.equal(keyRegion("ecs:service/acme-production/api@eu-west-1", "us-east-1"), "eu-west-1");
  assert.equal(keyRegion("rds:acme-staging-pg", "us-east-1"), "us-east-1");
  assert.equal(keyRegion(`arn:aws:rds:eu-west-1:${A}:cluster:acme-analytics-eu`, "us-east-1"), "eu-west-1");
  assert.equal(keyRegion(`arn:aws:iam::${A}:role/acme-lambda-exec`, "us-east-1"), "us-east-1", "global ARNs: home");
  assert.equal(keyRegion("arn:aws:s3:::acme-logs", "eu-central-1"), "eu-central-1");
  assert.equal(keyRegion("external:status.acme.example", "us-east-1"), "us-east-1");
  assert.equal(keyRegion("ec2:i-0acme@us-gov-west-1", "us-east-1"), "us-gov-west-1");
  assert.equal(keyRegion("workload:name@not-a-region", "us-east-1"), "us-east-1");
  assert.equal(keyRegion("rds:acme-iso-pg@us-isob-east-1", "us-east-1"), "us-isob-east-1", "every partition's region codes");
  assert.equal(keyRegion("rds:acme-eu-pg@eusc-de-east-1", "us-east-1"), "eusc-de-east-1");
  assert.equal(keyRegion(`arn:aws:ses:eu-west-1:${A}:identity/ops@acme.example`, "us-east-1"), "eu-west-1", "an @ inside an ARN is not a region suffix");
});
