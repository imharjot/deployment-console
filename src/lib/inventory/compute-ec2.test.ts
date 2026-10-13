import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asgOwnedProblem, asgOwner, asgResource, capacityDelta, desiredProblem, instanceEndpoints, instanceHealth, instanceLinks, instanceResource, isPublicInstance, mostCommon, powerProblem,
  profileName, stoppedSince,
} from "./compute-ec2.ts";

test("stopped-since comes from the user-initiated transition reason", () => {
  assert.equal(stoppedSince("User initiated (2026-05-30 10:12:03 GMT)"), Date.UTC(2026, 4, 30, 10, 12, 3));
  assert.equal(stoppedSince("Server.ScheduledStop: Stopped due to scheduled retirement"), undefined);
  assert.equal(stoppedSince(undefined), undefined);
});

test("instance health: running ok, impaired checks and scheduled events warn, stopped says since when", () => {
  assert.deepEqual(instanceHealth({ state: "running" }), { health: "ok" });
  assert.deepEqual(instanceHealth({ state: "running", checks: { system: "ok", instance: "impaired" } }), { health: "warning", healthReason: "instance status check impaired" });
  assert.equal(instanceHealth({ state: "running", events: ["instance-retirement 2026-10-01"] }).healthReason, "scheduled: instance-retirement 2026-10-01");
  assert.deepEqual(instanceHealth({ state: "stopped", reason: "User initiated (2026-05-30 10:12:03 GMT)" }), { health: "stopped", healthReason: "stopped since 2026-05-30" });
  assert.deepEqual(instanceHealth({ state: "stopped" }), { health: "stopped", healthReason: "stopped" });
  assert.equal(instanceHealth({ state: "pending" }).health, "warning");
});

test("endpoints and profile names", () => {
  assert.deepEqual(instanceEndpoints({ privateIp: "10.0.0.1", publicIp: "203.0.113.5", elasticIps: ["203.0.113.5"], publicDns: "" }), ["10.0.0.1", "203.0.113.5"]);
  assert.equal(profileName("arn:aws:iam::123456789012:instance-profile/ops/bastion"), "bastion");
});

test("power guard: ASG members can't be stopped, protected ECS hosts can't be stopped or rebooted, start is free", () => {
  assert.equal(powerProblem("stop", { state: "running" }), undefined);
  assert.match(powerProblem("stop", { state: "running", asg: "eks-general-1" })!, /scale the group instead/);
  assert.equal(powerProblem("reboot", { state: "running", asg: "eks-general-1" }), undefined);
  const prod = { cluster: "acme-production", env: "production", protected: true };
  assert.match(powerProblem("stop", { state: "running", ecs: prod })!, /protected environment production/);
  assert.match(powerProblem("reboot", { state: "running", ecs: prod })!, /rebooting it would stop every task/);
  assert.equal(powerProblem("start", { state: "stopped", ecs: prod }), undefined);
  assert.equal(powerProblem("stop", { state: "running", ecs: { ...prod, protected: false } }), undefined);
  assert.equal(powerProblem("start", { state: "running" }), "already running");
  assert.equal(powerProblem("stop", { state: "stopped" }), "already stopped");
  assert.match(powerProblem("stop", { state: "stopping" })!, /wait for it to settle/);
});

test("ASG desired capacity stays within min..max and owned groups are refused", () => {
  const g = { min: 1, max: 4, desired: 2 };
  assert.equal(desiredProblem(3, g), undefined);
  assert.match(desiredProblem(5, g)!, /between the group's min 1 and max 4/);
  assert.match(desiredProblem(0, g)!, /between/);
  assert.match(desiredProblem(2, g)!, /already 2/);
  assert.match(desiredProblem(1.5, g)!, /whole number/);
  assert.deepEqual(asgOwner({ "eks:cluster-name": "data", "eks:nodegroup-name": "general" }), { by: "eks", name: "data/general" });
  assert.match(asgOwnedProblem({ "eks:cluster-name": "data", "eks:nodegroup-name": "general" })!, /Scale nodegroup/);
  assert.match(asgOwnedProblem({ "elasticbeanstalk:environment-name": "admin-prod" })!, /Beanstalk/);
  assert.equal(asgOwnedProblem({ AmazonECSManaged: "" }), undefined);
  assert.equal(asgOwner({ AmazonECSManaged: "" })?.by, "ecs");
});

test("capacity delta at list price, negative when shrinking, none without a price", () => {
  const up = capacityDelta("m6i.large", 2, 3)!;
  assert.equal(up.monthlyUsd.toFixed(2), (0.096 * 730).toFixed(2));
  assert.match(up.note, /^\+1 × m6i\.large/);
  const down = capacityDelta("m6i.large", 3, 1)!;
  assert.ok(down.monthlyUsd < 0);
  assert.match(down.note, /saving/);
  assert.equal(capacityDelta("x9.large", 1, 2), undefined);
  assert.equal(capacityDelta("m6i.large", 2, 2), undefined);
  assert.equal(mostCommon(["t3.small", "m6i.large", "m6i.large", undefined]), "m6i.large");
});

test("instance → resource: ECS host prop and env hint, stopped-since as last activity, no terminate-worthy secrets", () => {
  const r = instanceResource(
    { id: "i-1", type: "t3.small", state: "stopped", reason: "User initiated (2026-05-30 10:12:03 GMT)", securityGroups: ["sg-1"], vpcId: "vpc-1", subnetId: "subnet-1", privateIp: "10.0.0.5", tags: { Name: "box", "aws:autoscaling:groupName": "g" } },
    "us-east-1", { cluster: "prod", env: "production", protected: true },
  );
  assert.equal(r.key, "ec2:i-1");
  assert.equal(r.name, "box");
  assert.equal(r.health, "stopped");
  assert.equal(r.lastActivityAt, Date.UTC(2026, 4, 30, 10, 12, 3));
  assert.equal(r.envHint, "production");
  assert.equal(r.props.find((p) => p.label === "ECS cluster")?.value, "prod (production, protected)");
  assert.equal(r.props.find((p) => p.label === "Auto Scaling group")?.value, "g");
  assert.deepEqual([r.vpcId, r.subnetIds, r.securityGroups, r.endpoints], ["vpc-1", ["subnet-1"], ["sg-1"], ["10.0.0.5"]]);
  assert.equal(instanceResource({ id: "i-2", type: "t3.small", state: "running", securityGroups: [], tags: {} }, "us-east-1").lastActivityAt, undefined);
});

test("ASG → resource, member links, target-group mentions, health", () => {
  const g = {
    name: "web", arn: "arn:aws:autoscaling:us-east-1:1:autoScalingGroup:x:autoScalingGroupName/web", min: 1, max: 4, desired: 3,
    instances: [{ id: "i-1", lifecycle: "InService", health: "Healthy", type: "m6i.large" }, { id: "i-2", lifecycle: "Pending", health: "Healthy", type: "m6i.large" }],
    instanceTypes: [], targetGroups: ["arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/web/abc"], classicLbs: [], subnets: ["subnet-a"], suspended: [], tags: {},
  };
  const m = asgResource(g, "us-east-1");
  assert.deepEqual([m.resource.health, m.resource.healthReason], ["warning", "1/3 in service"]);
  assert.equal(m.resource.props.find((p) => p.label === "Instance type")?.value, "m6i.large");
  assert.deepEqual(m.links.map((l) => [l.from, l.to, l.kind, l.label]), [[g.arn, "ec2:i-1", "uses", "member"], [g.arn, "ec2:i-2", "uses", "member"]]);
  assert.deepEqual(m.mentions, [{ from: g.arn, refs: g.targetGroups, via: "target group" }]);
  assert.equal(asgResource({ ...g, desired: 0, instances: [] }, "us-east-1").resource.health, "stopped");
});

test("the console never stops or reboots the instance it runs on", () => {
  assert.match(powerProblem("stop", { state: "running", self: true })!, /never stops or reboots itself/);
  assert.match(powerProblem("reboot", { state: "running", self: true })!, /never stops or reboots itself/);
  assert.equal(powerProblem("start", { state: "stopped", self: true }), undefined);
});

test("instance wiring: its instance profile (assumes), publicly addressable when it has a public or Elastic IP, its ARN as an alias", () => {
  const base = { id: "i-9", type: "t3.small", state: "running", securityGroups: [], tags: {} };
  const pub = instanceResource({ ...base, publicIp: "203.0.113.9", profileArn: "arn:aws:iam::123456789012:instance-profile/web" }, "us-east-1", undefined, "123456789012", "us-east-1");
  assert.deepEqual(pub.facts, { public: true });
  assert.equal(pub.key, "ec2:i-9");
  assert.deepEqual(pub.aliases, ["i-9", "arn:aws:ec2:us-east-1:123456789012:instance/i-9"]);
  assert.deepEqual(instanceResource(base, "us-east-1").facts, { public: false });
  assert.equal(isPublicInstance({ elasticIps: ["198.51.100.1"] }), true, "a stopped instance keeps its Elastic IP");
  assert.deepEqual(instanceLinks({ id: "i-9", profileArn: "arn:aws:iam::123456789012:instance-profile/web" }), [
    { from: "ec2:i-9", to: "arn:aws:iam::123456789012:instance-profile/web", kind: "assumes", label: "instance profile", evidence: "IamInstanceProfile.Arn" },
  ]);
  assert.deepEqual(instanceLinks({ id: "i-9" }), []);
});

test("outside the home region an instance is keyed ec2:<id>@<region> (the key VPC/EBS parents and ARN resolution use); the bare key stays an alias", () => {
  const base = { id: "i-9", type: "t3.small", state: "running", securityGroups: [], tags: {}, profileArn: "arn:aws:iam::123456789012:instance-profile/web" };
  const eu = instanceResource(base, "eu-west-1", undefined, "123456789012", "us-east-1");
  assert.equal(eu.key, "ec2:i-9@eu-west-1");
  assert.deepEqual(eu.aliases, ["i-9", "ec2:i-9", "arn:aws:ec2:eu-west-1:123456789012:instance/i-9"]);
  assert.equal(instanceLinks(base, "123456789012", "eu-west-1", "us-east-1")[0].from, eu.key);
  const g = { name: "web", arn: "arn:aws:autoscaling:eu-west-1:123456789012:autoScalingGroup:1:autoScalingGroupName/web", min: 1, max: 2, desired: 1,
    instances: [{ id: "i-9", lifecycle: "InService", health: "Healthy" }], instanceTypes: [], targetGroups: [], classicLbs: [], subnets: [], suspended: [], tags: {} };
  assert.deepEqual(asgResource(g, "eu-west-1", "us-east-1").links.map((l) => l.to), ["ec2:i-9@eu-west-1"]);
  assert.deepEqual(asgResource(g, "us-east-1", "us-east-1").links.map((l) => l.to), ["ec2:i-9"]);
});
