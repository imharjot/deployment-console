import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clusterLinks, clusterResource, isNodeOf, nodeLink, k8sAccessNote, mapK8s, nodegroupScalingProblem, parseWorkloadKey, presignedUrl, replicaHealth, restartPatch, selectorMatches,
  stsHost, tokenFromUrl, workloadKey, workloadPath, workloadScaleProblem, workloadTags, type K8sObjects,
} from "./compute-eks.ts";
import { keys } from "./types.ts";

test("token: presigned STS URL → k8s-aws-v1. + unpadded base64url, like aws eks get-token", () => {
  const url = presignedUrl({
    protocol: "https:", hostname: stsHost("us-east-1"), path: "/",
    query: {
      Action: "GetCallerIdentity", Version: "2011-06-15", "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": "AKIDEXAMPLE/20260927/us-east-1/sts/aws4_request", "X-Amz-Date": "20260927T000000Z", "X-Amz-Expires": "60",
      "X-Amz-SignedHeaders": "host;x-k8s-aws-id", "X-Amz-Security-Token": "a+b/c=", "X-Amz-Signature": "abc123", Empty: undefined,
    },
  });
  assert.ok(url.startsWith("https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&"));
  assert.match(url, /X-Amz-Credential=AKIDEXAMPLE%2F20260927%2Fus-east-1%2Fsts%2Faws4_request/);
  assert.match(url, /X-Amz-Security-Token=a%2Bb%2Fc%3D/);
  assert.match(url, /X-Amz-SignedHeaders=host%3Bx-k8s-aws-id/);
  assert.ok(!url.includes("Empty"));
  const token = tokenFromUrl(url);
  assert.ok(token.startsWith("k8s-aws-v1."));
  assert.ok(!/[+/=]/.test(token.slice(11)));
  assert.equal(Buffer.from(token.slice(11), "base64url").toString(), url);
  assert.equal(stsHost("cn-north-1"), "sts.cn-north-1.amazonaws.com.cn");
});

test("replica health: ready vs desired, rollouts, stuck, scaled to zero, DaemonSets", () => {
  assert.equal(replicaHealth("Deployment", { metadata: { name: "a" }, spec: { replicas: 3 }, status: { readyReplicas: 3, updatedReplicas: 3 } }).health, "ok");
  assert.deepEqual(replicaHealth("Deployment", { metadata: { name: "a" }, spec: { replicas: 3 }, status: { readyReplicas: 2, updatedReplicas: 3 } }).healthReason, "2/3 ready");
  assert.match(replicaHealth("Deployment", { metadata: { name: "a" }, spec: { replicas: 3 }, status: { readyReplicas: 3, updatedReplicas: 1 } }).healthReason!, /rolling out: 1\/3/);
  assert.equal(replicaHealth("StatefulSet", { metadata: { name: "a" }, spec: { replicas: 2 }, status: {} }).health, "error");
  assert.equal(replicaHealth("Deployment", { metadata: { name: "a" }, spec: { replicas: 0 }, status: {} }).health, "stopped");
  const stuck = replicaHealth("Deployment", { metadata: { name: "a" }, spec: { replicas: 1 }, status: { readyReplicas: 1, conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }] } });
  assert.deepEqual([stuck.health, stuck.healthReason], ["error", "rollout stuck: ProgressDeadlineExceeded"]);
  const ds = replicaHealth("DaemonSet", { metadata: { name: "a" }, status: { desiredNumberScheduled: 4, numberReady: 4, updatedNumberScheduled: 4 } });
  assert.deepEqual([ds.health, ds.desired, ds.ready], ["ok", 4, 4]);
  assert.equal(selectorMatches({ app: "a" }, { app: "a", tier: "web" }), true);
  assert.equal(selectorMatches({ app: "a", tier: "db" }, { app: "a" }), false);
  assert.equal(selectorMatches({}, { app: "a" }), false);
});

const CLUSTER = { name: "data", arn: "arn:aws:eks:us-east-1:123456789012:cluster/data", region: "us-east-1", vpcId: "vpc-1" };
const OBJS: K8sObjects = {
  deployments: [
    {
      metadata: { name: "web", namespace: "shop", labels: { app: "web" }, creationTimestamp: "2026-01-01T00:00:00Z" },
      spec: { replicas: 2, template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "web", image: "r/web:1", env: [{ name: "QUEUE_URL", value: "https://sqs/q" }, { name: "TOKEN", valueFrom: { secretKeyRef: {} } }, { name: "EMPTY", value: "" }] }] } } },
      status: { readyReplicas: 2, updatedReplicas: 2 },
    },
    { metadata: { name: "coredns", namespace: "kube-system" }, spec: { replicas: 2, template: { metadata: { labels: { k8s: "dns" } } } }, status: { readyReplicas: 2 } },
  ],
  statefulsets: [{ metadata: { name: "db", namespace: "shop" }, spec: { replicas: 1, template: { metadata: { labels: { app: "db" } } } }, status: { readyReplicas: 1 } }],
  daemonsets: [],
  services: [
    { metadata: { name: "web", namespace: "shop" }, spec: { type: "LoadBalancer", selector: { app: "web" } }, status: { loadBalancer: { ingress: [{ hostname: "nlb-1.elb.amazonaws.com" }] } } },
    { metadata: { name: "db", namespace: "shop" }, spec: { selector: { app: "db" } } },
  ],
  ingresses: [
    {
      metadata: { name: "front", namespace: "shop" },
      spec: { ingressClassName: "alb", rules: [{ host: "shop.example", http: { paths: [{ path: "/", backend: { service: { name: "web", port: { number: 80 } } } }] } }] },
      status: { loadBalancer: { ingress: [{ hostname: "k8s-shop-front-1.elb.amazonaws.com" }] } },
    },
  ],
};

test("k8s objects → workloads, ingress, links, mentions; kube-system skipped; no env values in props", () => {
  const m = mapK8s(CLUSTER, OBJS, new Set(["kube-system"]));
  const web = keys.eksWorkload("data", "shop", "Deployment", "web");
  const db = keys.eksWorkload("data", "shop", "StatefulSet", "db");
  const ing = keys.eksWorkload("data", "shop", "Ingress", "front");
  assert.deepEqual(m.resources.map((r) => r.key).sort(), [db, web, ing].sort());
  const w = m.resources.find((r) => r.key === web)!;
  assert.equal(w.kind, "eks-workload");
  assert.deepEqual(w.endpoints, []);
  assert.deepEqual(w.aliases, ["web.shop.svc.cluster.local", "web.shop.svc", "nlb-1.elb.amazonaws.com"]);
  assert.ok(m.links.some((l) => l.from === "nlb-1.elb.amazonaws.com" && l.to === web && l.kind === "route"));
  assert.equal(w.props.find((p) => p.label === "Replicas")!.value, "2/2 ready");
  assert.ok(!JSON.stringify(w.props).includes("https://sqs/q"));
  assert.deepEqual(m.mentions, [{ from: web, refs: ["https://sqs/q"], via: "env QUEUE_URL" }]);
  assert.ok(m.links.some((l) => l.from === CLUSTER.arn && l.to === web && l.kind === "uses" && l.label === "runs"));
  assert.ok(m.links.some((l) => l.from === ing && l.to === web && l.kind === "route" && l.label === "shop.example/ → web:80"));
  assert.ok(!m.links.some((l) => l.from === ing && l.to === db));
  const i = m.resources.find((r) => r.key === ing)!;
  assert.deepEqual(i.endpoints, ["shop.example"]);
  assert.deepEqual(i.aliases, ["k8s-shop-front-1.elb.amazonaws.com"]);
  assert.ok(m.links.some((l) => l.from === "k8s-shop-front-1.elb.amazonaws.com" && l.to === ing && l.kind === "route"));
  assert.equal(i.health, "ok");
  assert.deepEqual(m.summaries.get(web)!.containers[0].env, "QUEUE_URL, TOKEN, EMPTY");
  assert.equal(mapK8s(CLUSTER, OBJS, new Set()).resources.length, 4);
});

test("nodegroup and replica validation, workload keys and patch paths", () => {
  assert.equal(nodegroupScalingProblem(1, 2, 4), undefined);
  assert.equal(nodegroupScalingProblem(0, 0, 1), undefined);
  assert.match(nodegroupScalingProblem(2, 1, 4)!, /min ≤ desired ≤ max/);
  assert.match(nodegroupScalingProblem(0, 0, 0)!, /max must be at least 1/);
  assert.match(nodegroupScalingProblem(-1, 0, 2)!, /whole numbers/);
  assert.equal(workloadScaleProblem("Deployment", 5), undefined);
  assert.match(workloadScaleProblem("DaemonSet", 1)!, /can't be scaled/);
  assert.match(workloadScaleProblem("StatefulSet", 51)!, /0 to 50/);
  assert.deepEqual(parseWorkloadKey(keys.eksWorkload("data", "ml", "Deployment", "rec")), { cluster: "data", namespace: "ml", kind: "Deployment", name: "rec" });
  assert.equal(parseWorkloadKey("ec2:i-1"), undefined);
  assert.equal(workloadPath({ namespace: "ml", kind: "StatefulSet", name: "fs" }, "/scale"), "/apis/apps/v1/namespaces/ml/statefulsets/fs/scale");
  assert.deepEqual(restartPatch("t"), { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": "t" } } } } });
});

test("access notes explain how to grant read access or reach the endpoint", () => {
  assert.match(k8sAccessNote("data", { status: 401 }, {}), /create-access-entry --cluster-name data .*AmazonEKSViewPolicy/);
  assert.match(k8sAccessNote("data", { status: 401 }, { authMode: "CONFIG_MAP" }), /API_AND_CONFIG_MAP/);
  assert.match(k8sAccessNote("data", { status: 403 }, {}), /associate-access-policy/);
  assert.match(k8sAccessNote("data", { code: "ETIMEDOUT" }, { publicAccess: false }), /private/);
});

test("cluster → resource: nodegroups as props, endpoint host, health from status / issues / nodegroups; node tags", () => {
  const c = {
    name: "data", arn: CLUSTER.arn, status: "ACTIVE", version: "1.33", platformVersion: "eks.9", endpoint: "https://ABC.gr7.us-east-1.eks.amazonaws.com", vpcId: "vpc-1",
    subnetIds: ["subnet-a"], securityGroups: ["sg-eks"], publicAccess: true, privateAccess: false, authMode: "API", tags: {}, fargateProfiles: [], addons: ["vpc-cni"], issues: [],
    nodegroups: [{ name: "general", status: "ACTIVE", min: 1, desired: 2, max: 4, instanceTypes: ["m6i.large"], amiType: "AL2023_x86_64_STANDARD", capacityType: "ON_DEMAND", asgs: [], issues: [] }],
  };
  const r = clusterResource(c, "us-east-1");
  assert.equal(r.kind, "eks-cluster");
  assert.equal(r.health, "ok");
  assert.deepEqual(r.endpoints, ["ABC.gr7.us-east-1.eks.amazonaws.com"]);
  assert.equal(r.props.find((p) => p.label === "Nodegroup general")?.value, "2 × m6i.large · min 1 / max 4 · AL2023_x86_64_STANDARD · ON_DEMAND");
  assert.equal(r.props.find((p) => p.label === "Endpoint access")?.value, "public");
  const degraded = clusterResource({ ...c, nodegroups: [{ ...c.nodegroups[0], status: "DEGRADED", issues: ["Ec2LaunchTemplateNotFound: gone"] }] }, "us-east-1");
  assert.deepEqual([degraded.health, degraded.healthReason], ["warning", "nodegroup general degraded: Ec2LaunchTemplateNotFound: gone"]);
  assert.equal(clusterResource({ ...c, status: "FAILED" }, "us-east-1").health, "error");
  assert.equal(isNodeOf("data", { "eks:cluster-name": "data" }), true);
  assert.equal(isNodeOf("data", { "kubernetes.io/cluster/data": "owned" }), true);
  assert.equal(isNodeOf("data", { "eks:cluster-name": "other" }), false);
  assert.deepEqual(nodeLink(CLUSTER.arn, "i-1", { "eks:nodegroup-name": "general" }), { from: CLUSTER.arn, to: "ec2:i-1", kind: "uses", label: "node · general", evidence: "instance tag eks:nodegroup-name=general" });
  assert.equal(nodeLink(CLUSTER.arn, "i-1", {}, "eu-west-1", "us-east-1").to, "ec2:i-1@eu-west-1", "a node outside home: the EC2 provider's regional key");
});

test("cluster wiring: cluster and node roles (one edge per role), the secrets KMS key, the control-plane log group", () => {
  const c = {
    name: "data", arn: CLUSTER.arn, status: "ACTIVE", subnetIds: [], securityGroups: [], tags: {}, fargateProfiles: [], addons: [], issues: [],
    nodegroups: [
      { name: "general", status: "ACTIVE", min: 1, desired: 2, max: 4, instanceTypes: [], asgs: [], issues: [], nodeRole: "arn:aws:iam::123456789012:role/eks-node" },
      { name: "spot", status: "ACTIVE", min: 0, desired: 0, max: 4, instanceTypes: [], asgs: [], issues: [], nodeRole: "arn:aws:iam::123456789012:role/eks-node" },
    ],
    roleArn: "arn:aws:iam::123456789012:role/eks-cluster", kmsKeys: ["arn:aws:kms:us-east-1:123456789012:key/k1"], logTypes: ["api", "audit"],
  };
  assert.deepEqual(clusterLinks(c, "us-east-1", "123456789012").map((l) => [l.from, l.to, l.kind, l.label]), [
    [CLUSTER.arn, "arn:aws:iam::123456789012:role/eks-cluster", "assumes", "cluster role"],
    [CLUSTER.arn, "arn:aws:iam::123456789012:role/eks-node", "assumes", "node role · general, node role · spot"],
    ["arn:aws:kms:us-east-1:123456789012:key/k1", CLUSTER.arn, "encrypts", "Kubernetes secrets"],
    [CLUSTER.arn, "arn:aws:logs:us-east-1:123456789012:log-group:/aws/eks/data/cluster", "logs", "control plane"],
  ]);
  // No log type on: no log group; no account: no log group ARN to build.
  assert.ok(!clusterLinks({ ...c, logTypes: [] }, "us-east-1", "123456789012").some((l) => l.kind === "logs"));
  assert.ok(!clusterLinks(c, "us-east-1").some((l) => l.kind === "logs"));
  const r = clusterResource(c, "us-east-1");
  assert.equal(r.props.find((p) => p.label === "Control-plane logs")?.value, "api, audit");
  assert.equal(r.props.find((p) => p.label === "Secrets encryption")?.value, "KMS envelope encryption");
});

test("workloads outside the home region get an @region key; every workload inherits the cluster's console:* tags", () => {
  const eu = { ...CLUSTER, region: "eu-west-1", home: "us-east-1", tags: { "console:protected": "true", Team: "data" } };
  const m = mapK8s(eu, OBJS, new Set(["kube-system"]));
  const web = workloadKey(eu, "shop", "Deployment", "web");
  assert.equal(web, `${keys.eksWorkload("data", "shop", "Deployment", "web")}@eu-west-1`);
  assert.ok(m.resources.every((r) => r.key.endsWith("@eu-west-1")), m.resources.map((r) => r.key).join(", "));
  assert.equal(m.resources.find((r) => r.key === web)?.tags["console:protected"], "true");
  assert.equal(m.resources.find((r) => r.key === web)?.tags.Team, undefined, "only console:* tags are inherited");
  assert.ok(m.links.some((l) => l.from === CLUSTER.arn && l.to === web));
  assert.deepEqual(parseWorkloadKey(web), { cluster: "data", namespace: "shop", kind: "Deployment", name: "web", region: "eu-west-1" });
  // Home region (or no home given): today's keys, unchanged.
  assert.equal(workloadKey({ ...CLUSTER, home: CLUSTER.region }, "shop", "Deployment", "web"), keys.eksWorkload("data", "shop", "Deployment", "web"));
  assert.deepEqual(workloadTags({ app: "web" }, { "console:self": "true", Environment: "production" }), { app: "web", "console:self": "true" });
});
