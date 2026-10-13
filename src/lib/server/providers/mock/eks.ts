// Simulated EKS: the production data platform (nodegroup "general" on m6i.large; secrets encrypted with the app KMS key,
// API and audit logs on) and what its Kubernetes API would answer — the recommender Deployment and feature-store
// StatefulSet in namespace "ml" (their env names the clickstream stream and the sessions / carts tables), their
// Services, the recommender's ALB Ingress, and kube-system add-ons. Home region only.
import type { ClusterView, K8sObjects, K8sWorkload } from "../../../inventory/compute-eks.ts";
import { ACCT, DYNAMO, EKS, EXISTING, KINESIS, KMS_KEYS, REGION } from "../mock-names.ts";
import { EKS_ENDPOINT, EKS_SG, NODE_ASG, RECOMMENDER_LB, mockState } from "./compute-state.ts";

const ECR = `${ACCT}.dkr.ecr.${REGION}.amazonaws.com`;
const ROLL_MS = 20_000;

export function mockClusters(): ClusterView[] {
  const s = mockState();
  const ng = s.nodegroup;
  return [{
    name: EKS.cluster.name, arn: EKS.cluster.arn, status: "ACTIVE", version: EKS.cluster.version, platformVersion: "eks.9", endpoint: EKS_ENDPOINT,
    vpcId: EXISTING.vpc.production, subnetIds: EXISTING.subnets.production, securityGroups: [EKS_SG], publicAccess: true, privateAccess: true,
    authMode: "API_AND_CONFIG_MAP", tags: { Environment: "production", Team: "data" }, createdAt: s.t0 - 200 * 86_400_000,
    nodegroups: [{
      name: EKS.nodegroup.name, status: ng.status, min: ng.min, desired: ng.desired, max: ng.max, instanceTypes: [EKS.nodegroup.instanceType],
      amiType: "AL2023_x86_64_STANDARD", capacityType: "ON_DEMAND", asgs: [NODE_ASG], issues: [], nodeRole: `arn:aws:iam::${ACCT}:role/acme-eks-node`,
    }],
    fargateProfiles: [], addons: ["coredns", "kube-proxy", "vpc-cni", "eks-pod-identity-agent", "aws-ebs-csi-driver"], issues: [],
    roleArn: `arn:aws:iam::${ACCT}:role/acme-eks-cluster`, kmsKeys: [KMS_KEYS.app.arn], logTypes: ["api", "audit"],
  }];
}

const env = (pairs: Record<string, string>) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

export function mockK8s(): K8sObjects {
  const s = mockState();
  const now = Date.now();
  const created = new Date(s.t0 - 90 * 86_400_000).toISOString();
  const workload = (ns: string, name: string, image: string, port: number, vars: Record<string, string>): K8sWorkload => {
    const w = s.workloads.get(`${ns}/${name}`)!;
    const scaling = now - w.changedAt < 12_000;
    const rolling = !!w.restartedAt && now - w.restartedAt < ROLL_MS;
    const ready = scaling ? Math.min(w.prev, w.replicas) : rolling ? Math.max(0, w.replicas - 1) : w.replicas;
    return {
      metadata: { name, namespace: ns, labels: { app: name, "app.kubernetes.io/part-of": "ml-platform" }, creationTimestamp: created },
      spec: {
        replicas: w.replicas,
        template: {
          metadata: { labels: { app: name }, annotations: w.restartedAt ? { "kubectl.kubernetes.io/restartedAt": new Date(w.restartedAt).toISOString() } : {} },
          spec: {
            serviceAccountName: name,
            containers: [{
              name, image, ports: [{ containerPort: port, protocol: "TCP" }],
              env: [...env(vars), { name: "API_TOKEN", valueFrom: { secretKeyRef: { name: `${name}-secrets`, key: "token" } } }],
            }],
          },
        },
      },
      status: { readyReplicas: ready, updatedReplicas: rolling ? Math.max(0, w.replicas - 1) : w.replicas, availableReplicas: ready },
    };
  };
  const system = (name: string, kind: "Deployment" | "DaemonSet"): K8sWorkload => ({
    metadata: { name, namespace: "kube-system", labels: { "k8s-app": name }, creationTimestamp: created },
    spec: { replicas: kind === "Deployment" ? 2 : undefined, template: { metadata: { labels: { "k8s-app": name } }, spec: { containers: [{ name, image: `602401143452.dkr.ecr.${REGION}.amazonaws.com/eks/${name}:v1` }] } } },
    status: kind === "Deployment" ? { readyReplicas: 2, updatedReplicas: 2 } : { desiredNumberScheduled: s.nodegroup.desired, numberReady: s.nodegroup.desired, updatedNumberScheduled: s.nodegroup.desired },
  });
  const [rec, fs] = EKS.workloads;
  return {
    deployments: [
      workload(rec.namespace, rec.name, `${ECR}/recommender:1.8.2`, 8080, { LOG_LEVEL: "info", KINESIS_STREAM_ARN: KINESIS.clickstream.arn, SESSIONS_TABLE: DYNAMO.sessions.name, FEATURE_STORE_URL: `http://${fs.name}.${fs.namespace}.svc.cluster.local:6566` }),
      system("coredns", "Deployment"),
    ],
    statefulsets: [workload(fs.namespace, fs.name, `${ECR}/feature-store:0.9.4`, 6566, { CARTS_TABLE: DYNAMO.carts.name, AWS_REGION: REGION })],
    daemonsets: [system("aws-node", "DaemonSet"), system("kube-proxy", "DaemonSet")],
    services: [
      { metadata: { name: rec.name, namespace: rec.namespace }, spec: { type: "ClusterIP", selector: { app: rec.name }, ports: [{ port: 80 }] } },
      { metadata: { name: fs.name, namespace: fs.namespace }, spec: { type: "ClusterIP", selector: { app: fs.name }, ports: [{ port: 6566 }] } },
      { metadata: { name: "kube-dns", namespace: "kube-system" }, spec: { type: "ClusterIP", selector: { "k8s-app": "coredns" }, ports: [{ port: 53 }] } },
    ],
    ingresses: [{
      metadata: { name: rec.name, namespace: rec.namespace, annotations: { "alb.ingress.kubernetes.io/scheme": "internet-facing" }, creationTimestamp: created },
      spec: { ingressClassName: "alb", rules: [{ http: { paths: [{ path: "/", backend: { service: { name: rec.name, port: { number: 80 } } } }] } }] },
      status: { loadBalancer: { ingress: [{ hostname: RECOMMENDER_LB }] } },
    }],
  };
}
