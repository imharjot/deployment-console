import { test } from "node:test";
import assert from "node:assert/strict";
import { ecrRepoRef, kmsRef, profileRef, roleRef } from "./compute-common.ts";
import {
  apprunnerHealth, apprunnerLinks, apprunnerResource, beanstalkEnvMentions, beanstalkHealth, beanstalkLinks, beanstalkPlacement, beanstalkResource, beanstalkRoleLinks, lbName,
  versionProblem,
} from "./compute-paas.ts";
import { keys } from "./types.ts";

const SENTINEL = "SENTINEL-c0ffee-never-in-output";

test("App Runner and Beanstalk health", () => {
  assert.equal(apprunnerHealth("RUNNING").health, "ok");
  assert.deepEqual(apprunnerHealth("PAUSED"), { health: "stopped", healthReason: "paused" });
  assert.equal(apprunnerHealth("CREATE_FAILED").health, "error");
  assert.deepEqual(beanstalkHealth({ status: "Ready", health: "Yellow", healthStatus: "Warning" }), { health: "warning", healthReason: "health Yellow (Warning)" });
  assert.deepEqual(beanstalkHealth({ status: "Ready", health: "Red", cause: "100% of requests failing" }), { health: "error", healthReason: "100% of requests failing" });
  assert.equal(beanstalkHealth({ status: "Ready", health: "Green" }).health, "ok");
  assert.deepEqual(beanstalkHealth({ status: "Updating", health: "Grey" }), { health: "warning", healthReason: "updating" });
});

test("Beanstalk resources → links: LB routes to the env, env uses its ASG and instances, worker polls its queue", () => {
  const env = "arn:aws:elasticbeanstalk:us-east-1:123456789012:environment/app/app-prod";
  const links = beanstalkLinks(env, {
    autoScalingGroups: ["awseb-e-1-stack-AWSEBAutoScalingGroup-X"],
    instances: ["i-1"],
    loadBalancers: ["arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/awseb-AWSEB-ABC/50dc6c495c0c9188", "classic-lb"],
    queues: [{ name: "WorkerQueue", url: "https://sqs.us-east-1.amazonaws.com/123456789012/q" }],
  });
  assert.deepEqual(links.map((l) => [l.from, l.to, l.kind]), [
    [keys.loadBalancer("awseb-AWSEB-ABC"), env, "route"],
    [keys.loadBalancer("classic-lb"), env, "route"],
    [env, "awseb-e-1-stack-AWSEBAutoScalingGroup-X", "uses"],
    [env, keys.ec2("i-1"), "uses"],
    [env, "https://sqs.us-east-1.amazonaws.com/123456789012/q", "poll"],
  ]);
  assert.equal(lbName("my-classic"), "my-classic");
  // Outside the home region the load balancer and instance keys carry the region, like their providers' keys (CC-6).
  const eu = beanstalkLinks(env, { autoScalingGroups: [], instances: ["i-1"], loadBalancers: ["classic-lb"], queues: [] }, "eu-west-1", "us-east-1");
  assert.deepEqual(eu.map((l) => [l.from, l.to]), [[keys.loadBalancer("classic-lb", "eu-west-1", "us-east-1"), env], [env, "ec2:i-1@eu-west-1"]]);
});

test("option settings → placement and env mentions; versions are validated", () => {
  const o = [
    { Namespace: "aws:ec2:vpc", OptionName: "VPCId", Value: "vpc-1" },
    { Namespace: "aws:ec2:vpc", OptionName: "Subnets", Value: "subnet-a, subnet-b" },
    { Namespace: "aws:autoscaling:launchconfiguration", OptionName: "SecurityGroups", Value: "sg-1,awseb-e-1-stack-AWSEBSecurityGroup-X" },
    { Namespace: "aws:ec2:instances", OptionName: "InstanceTypes", Value: "t3.small,t3.medium" },
    { Namespace: "aws:elasticbeanstalk:application:environment", OptionName: "DB_HOST", Value: "db.example" },
    { Namespace: "aws:elasticbeanstalk:application:environment", OptionName: "EMPTY", Value: "" },
  ];
  assert.deepEqual(beanstalkPlacement(o), {
    vpcId: "vpc-1", subnetIds: ["subnet-a", "subnet-b"], securityGroups: ["sg-1"], instanceType: "t3.small", instanceProfile: undefined, serviceRole: undefined, envType: undefined,
  });
  assert.deepEqual(beanstalkEnvMentions("k", o), [{ from: "k", refs: ["db.example"], via: "env DB_HOST" }]);
  const versions = [{ label: "v2", status: "PROCESSED" }, { label: "v1", status: "FAILED" }];
  assert.equal(versionProblem("v2", versions, "v3"), undefined);
  assert.match(versionProblem("v2", versions, "v2")!, /already deployed/);
  assert.match(versionProblem("v1", versions)!, /failed/);
  assert.match(versionProblem("v9", versions)!, /no application version/);
});

test("Beanstalk env → resource: answers on its CNAME; its LB's DNS links in (and is an alias), an EIP stays a prop", () => {
  const base = {
    name: "app-prod", id: "e-1", arn: "arn:aws:elasticbeanstalk:us-east-1:1:environment/app/app-prod", app: "app", status: "Ready", health: "Green", tags: {},
    cname: "app-prod.us-east-1.elasticbeanstalk.com", resources: { autoScalingGroups: ["asg-1"], instances: [], loadBalancers: [], queues: [] },
    options: [{ Namespace: "aws:elasticbeanstalk:application:environment", OptionName: "DB", Value: "postgres://u:secret@db.example:5432/x" }],
  };
  const lb = beanstalkResource({ ...base, endpointUrl: "awseb-AWSEB-1-123.us-east-1.elb.amazonaws.com" }, "us-east-1");
  assert.deepEqual(lb.resource.endpoints, ["app-prod.us-east-1.elasticbeanstalk.com"]);
  assert.ok(lb.resource.aliases!.includes("awseb-AWSEB-1-123.us-east-1.elb.amazonaws.com"));
  assert.deepEqual([lb.links[0].from, lb.links[0].to, lb.links[0].kind], ["awseb-AWSEB-1-123.us-east-1.elb.amazonaws.com", base.arn, "route"]);
  assert.equal(lb.resource.props.find((p) => p.label === "Load balancer")?.value, "awseb-AWSEB-1-123.us-east-1.elb.amazonaws.com");
  assert.ok(!JSON.stringify(lb.resource).includes("secret"));
  assert.deepEqual(lb.mentions, [{ from: base.arn, refs: ["postgres://u:secret@db.example:5432/x"], via: "env DB" }]);
  const single = beanstalkResource({ ...base, endpointUrl: "203.0.113.25" }, "us-east-1");
  assert.deepEqual(single.resource.endpoints, ["app-prod.us-east-1.elasticbeanstalk.com"]);
  assert.equal(single.resource.props.find((p) => p.label === "Elastic IP")?.value, "203.0.113.25");
  assert.equal(single.links.some((l) => l.from === "203.0.113.25"), false);
});

test("App Runner service → resource: URL endpoint, size, source; env values only as mentions", () => {
  const m = apprunnerResource({
    name: "preview", arn: "arn:aws:apprunner:us-east-1:1:service/preview/abc", status: "RUNNING", url: "x1.us-east-1.awsapprunner.com",
    source: { image: "1.dkr.ecr.us-east-1.amazonaws.com/web:1", imageRepoType: "ECR" }, autoDeploy: true, cpu: "1024", memory: "2048",
    subnetIds: [], securityGroups: [], tags: {}, env: [{ name: "TABLE", value: "sessions-x" }],
  }, "us-east-1");
  assert.deepEqual(m.resource.endpoints, ["x1.us-east-1.awsapprunner.com"]);
  assert.equal(m.resource.props.find((p) => p.label === "Instance")?.value, "1 vCPU · 2 GB");
  assert.ok(!JSON.stringify(m.resource).includes("sessions-x"));
  assert.deepEqual(m.mentions, [{ from: m.resource.key, refs: ["sessions-x"], via: "env TABLE" }]);
  assert.equal(m.resource.props.find((p) => p.label === "Ingress")?.value, "public");
  // Only listed (not described yet): what the list doesn't say isn't claimed — no ingress, no auto deploy, tags unread.
  const listed = apprunnerResource({ name: "preview", arn: "arn:aws:apprunner:us-east-1:1:service/preview/abc", status: "RUNNING", source: {}, subnetIds: [], securityGroups: [], env: [] }, "us-east-1");
  assert.deepEqual(listed.resource.props.filter((p) => p.label === "Ingress" || p.label === "Auto deploy"), []);
  assert.equal(listed.resource.tagsUnread, true);
});

test("support references: roles, instance profiles, KMS keys and ECR repositories as the ARNs their providers key", () => {
  assert.equal(roleRef("acme-app", "123456789012"), "arn:aws:iam::123456789012:role/acme-app");
  assert.equal(roleRef("service-role/AppRunnerECRAccessRole", "123456789012"), "arn:aws:iam::123456789012:role/service-role/AppRunnerECRAccessRole");
  assert.equal(roleRef("arn:aws:iam::210987654321:role/other"), "arn:aws:iam::210987654321:role/other", "an ARN stands as it is");
  assert.equal(roleRef("acme-app"), "acme-app", "no account: the name (resolved through the IAM provider's aliases, if at all)");
  assert.equal(roleRef("acme-app", "123456789012", "cn-north-1"), "arn:aws-cn:iam::123456789012:role/acme-app");
  assert.equal(roleRef(" "), undefined);
  assert.equal(profileRef("aws-elasticbeanstalk-ec2-role", "123456789012"), "arn:aws:iam::123456789012:instance-profile/aws-elasticbeanstalk-ec2-role");
  assert.equal(kmsRef("alias/acme", "eu-west-1", "123456789012"), "arn:aws:kms:eu-west-1:123456789012:alias/acme");
  assert.equal(kmsRef("mrk-1", "us-east-1", "123456789012"), "arn:aws:kms:us-east-1:123456789012:key/mrk-1");
  assert.equal(kmsRef("mrk-1", "us-east-1"), undefined, "a bare id needs the account");
  assert.equal(kmsRef("mrk-1", "unknown", "123456789012"), undefined);
  assert.equal(ecrRepoRef("123456789012.dkr.ecr.eu-west-1.amazonaws.com/acme/api:1.2"), "arn:aws:ecr:eu-west-1:123456789012:repository/acme/api");
  assert.equal(ecrRepoRef("123456789012.dkr.ecr.us-east-1.amazonaws.com/web@sha256:abc"), "arn:aws:ecr:us-east-1:123456789012:repository/web");
  assert.equal(ecrRepoRef("public.ecr.aws/nginx/nginx:1"), undefined);
  assert.equal(ecrRepoRef("ghcr.io/acme/api:1"), undefined);
});

test("Beanstalk runs as its instance profile and service role (names in the settings → ARNs)", () => {
  const env = "arn:aws:elasticbeanstalk:us-east-1:123456789012:environment/app/app-prod";
  const o = [
    { Namespace: "aws:autoscaling:launchconfiguration", OptionName: "IamInstanceProfile", Value: "aws-elasticbeanstalk-ec2-role" },
    { Namespace: "aws:elasticbeanstalk:environment", OptionName: "ServiceRole", Value: "aws-elasticbeanstalk-service-role" },
  ];
  assert.deepEqual(beanstalkRoleLinks(env, o, "123456789012", "us-east-1").map((l) => [l.from, l.to, l.kind, l.label]), [
    [env, "arn:aws:iam::123456789012:instance-profile/aws-elasticbeanstalk-ec2-role", "assumes", "instance profile"],
    [env, "arn:aws:iam::123456789012:role/aws-elasticbeanstalk-service-role", "assumes", "service role"],
  ]);
  assert.deepEqual(beanstalkRoleLinks(env, []), []);
  // Tags not read (the checkpointed list) → unread, never "no tags".
  const view = { name: "app-prod", id: "e-1", arn: env, app: "app", status: "Ready", resources: { autoScalingGroups: [], instances: [], loadBalancers: [], queues: [] }, options: o };
  const bare = beanstalkResource(view, "us-east-1", "123456789012");
  assert.equal(bare.resource.tagsUnread, true);
  assert.ok(bare.links.some((l) => l.kind === "assumes" && l.label === "service role"));
  assert.equal(bare.resource.props.find((p) => p.label === "Service role")?.value, "aws-elasticbeanstalk-service-role");
  const read = beanstalkResource({ ...view, tags: {}, options: [] }, "us-east-1", undefined, { details: "ok", tags: "ok" });
  assert.equal(read.resource.tagsUnread, undefined);
  assert.deepEqual(read.resource.enrichment, { details: "ok", tags: "ok" });
});

test("App Runner runs as its instance role, pulls from its ECR repository through the access role, is encrypted with its key; env values never leave the mentions", () => {
  const arn = "arn:aws:apprunner:us-east-1:123456789012:service/preview/abc";
  const s = {
    name: "preview", arn, status: "RUNNING", source: { image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/web:1", imageRepoType: "ECR" },
    instanceRole: "arn:aws:iam::123456789012:role/preview", accessRole: "arn:aws:iam::123456789012:role/service-role/AppRunnerECRAccessRole",
    kmsKey: "arn:aws:kms:us-east-1:123456789012:key/k1", subnetIds: [], securityGroups: [], env: [{ name: "DATABASE_URL", value: `postgres://u:${SENTINEL}@db:5432/x` }],
  };
  assert.deepEqual(apprunnerLinks(s, "us-east-1", "123456789012").map((l) => [l.from, l.to, l.kind, l.label]), [
    [arn, "arn:aws:iam::123456789012:role/preview", "assumes", "instance role"],
    [arn, "arn:aws:iam::123456789012:role/service-role/AppRunnerECRAccessRole", "assumes", "ECR access role"],
    [arn, "arn:aws:ecr:us-east-1:123456789012:repository/acme/web", "pulls", "image"],
    ["arn:aws:kms:us-east-1:123456789012:key/k1", arn, "encrypts", "service data"],
  ]);
  const connector = "arn:aws:apprunner:us-east-1:123456789012:vpcconnector/acme-vpc/1/0123456789abcdef";
  assert.deepEqual(apprunnerLinks({ ...s, vpcConnector: connector }, "us-east-1", "123456789012").find((l) => l.kind === "uses"), {
    from: arn, to: connector, kind: "uses", label: "VPC connector", evidence: "NetworkConfiguration.EgressConfiguration.VpcConnectorArn",
  });
  assert.deepEqual(apprunnerLinks({ ...s, source: { image: "public.ecr.aws/x/y:1", imageRepoType: "ECR_PUBLIC" }, accessRole: undefined, kmsKey: undefined, instanceRole: undefined }, "us-east-1").length, 0);
  const m = apprunnerResource(s, "us-east-1", "123456789012");
  assert.equal(m.resource.tagsUnread, true, "tags not read: unread, not empty");
  assert.equal(m.resource.props.find((p) => p.label === "Auto deploy"), undefined, "not described yet: no guess");
  const out = JSON.stringify({ resource: m.resource, links: m.links });
  assert.ok(!out.includes(SENTINEL), "an env value reached the resource or a link");
  assert.ok(m.mentions.some((x) => x.refs.some((r) => r.includes(SENTINEL))));
});
