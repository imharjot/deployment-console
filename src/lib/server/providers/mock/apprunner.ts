// Simulated App Runner: the staging preview of the storefront, deployed from its ECR repository (through App Runner's
// ECR access role) with auto-deploy on. Home region only.
import type { AppRunnerView } from "../../../inventory/compute-paas.ts";
import { ACCT, APPRUNNER, DYNAMO } from "../mock-names.ts";
import { PREVIEW_IMAGE, mockState, type MOp } from "./compute-state.ts";

export function mockServices(): AppRunnerView[] {
  const s = mockState();
  const p = APPRUNNER.preview;
  return [{
    name: p.name, arn: p.arn, status: s.apprunner.status, url: p.url,
    source: { image: PREVIEW_IMAGE, imageRepoType: "ECR", port: "3000" }, autoDeploy: true, cpu: "1024", memory: "2048",
    instanceRole: `arn:aws:iam::${ACCT}:role/acme-staging-preview`, accessRole: `arn:aws:iam::${ACCT}:role/service-role/AppRunnerECRAccessRole`,
    egress: "DEFAULT", publicIngress: true, subnetIds: [], securityGroups: [],
    tags: { Environment: "staging", Team: "storefront" },
    env: [{ name: "NODE_ENV", value: "staging" }, { name: "SESSIONS_TABLE", value: DYNAMO.sessionsStaging.name }, { name: "PORT", value: "3000" }],
    createdAt: s.t0 - 60 * 86_400_000, updatedAt: s.apprunner.ops[0]?.startedAt,
  }];
}

export const mockOperations = (): MOp[] => mockState().apprunner.ops.slice(0, 10);
