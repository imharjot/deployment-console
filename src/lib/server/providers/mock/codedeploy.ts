// Simulated CodeDeploy of the Acme account (names from ../mock-names.ts), as BatchGetDeploymentGroups, tags and the
// panel's deployments would return them, per region (the provider sets multiRegionMock). us-east-1: the legacy admin's
// in-place deployment group, targeting the EC2 instance tagged Name=acme-legacy-cron — which is stopped, so the last
// deployment failed (an error on the map). Other regions: none. Read-only.
import type { CodeDeployRaw, RawDeployment, RawDeploymentGroup } from "../../../inventory/cicd.ts";
import { CODEDEPLOY, EC2, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

const G = CODEDEPLOY.legacyAdmin;
const FAILED = "d-ACME0FAIL1";
const LAST_OK = "d-ACME0OK001";

export function simDeploymentGroups(region: string, now: number = Date.now()): RawDeploymentGroup[] {
  if (region !== REGION) return [];
  return [
    {
      applicationName: G.app, deploymentGroupName: G.group, deploymentConfigName: "CodeDeployDefault.OneAtATime", computePlatform: "Server",
      deploymentStyle: { deploymentType: "IN_PLACE", deploymentOption: "WITHOUT_TRAFFIC_CONTROL" },
      ec2TagFilters: [{ Key: "Name", Value: EC2.legacyCron.name, Type: "KEY_AND_VALUE" }],
      lastAttemptedDeployment: { deploymentId: FAILED, status: G.last, createTime: new Date(now - 6 * DAY), endTime: new Date(now - 6 * DAY + 20 * 60_000) },
      lastSuccessfulDeployment: { deploymentId: LAST_OK, status: "Succeeded", createTime: new Date(now - 95 * DAY), endTime: new Date(now - 95 * DAY + 8 * 60_000) },
    },
  ];
}

export function simCodeDeploy(region: string, now: number = Date.now()): CodeDeployRaw {
  const groups = simDeploymentGroups(region, now);
  return { groups, tags: region === REGION ? { [G.arn]: { value: [{ Key: "Environment", Value: "production" }, { Key: "team", Value: "admin" }], state: "ok" } } : {} };
}

export function simDeployments(region: string, group: string, now: number = Date.now()): RawDeployment[] {
  if (region !== REGION || group !== G.group) return [];
  return [
    {
      deploymentId: FAILED, status: "Failed", createTime: new Date(now - 6 * DAY), completeTime: new Date(now - 6 * DAY + 20 * 60_000), creator: "user",
      errorInformation: { code: "HEALTH_CONSTRAINTS", message: "The overall deployment failed because too many individual instances failed deployment, too few healthy instances are available for deployment, or some instances in your deployment group are experiencing problems." },
    },
    { deploymentId: LAST_OK, status: "Succeeded", createTime: new Date(now - 95 * DAY), completeTime: new Date(now - 95 * DAY + 8 * 60_000), creator: "user" },
  ];
}
