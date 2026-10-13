// Simulated Amplify Hosting of the Acme account (names from ../mock-names.ts), as ListApps + ListBranches +
// ListDomainAssociations + ListJobs return it, per region. us-east-1: acme-marketing-site, the static marketing site —
// main is production (built yesterday) on marketing.acme.example, and a preview branch whose last build failed (a
// warning on the app). Variables are the kind real sites carry; basic auth is on for the preview branch only (its
// credentials are never simulated: the mapper never reads them). Other regions: none. Read-only.
import type { RawAmplifyApp } from "../../../inventory/app-platforms.ts";
import { AMPLIFY, REGION } from "../mock-names.ts";
import { DAY, HOUR, MIN } from "./serverless-sim.ts";

export function simAmplify(region: string, now: number = Date.now()): RawAmplifyApp[] {
  if (region !== REGION) return [];
  const a = AMPLIFY.marketing;
  const defaultDomain = a.domain.slice(a.branch.length + 1); // "main.<id>.amplifyapp.com" → "<id>.amplifyapp.com"
  const branch = (name: string) => `${a.arn}/branches/${name}`;
  return [
    {
      appId: a.id, appArn: a.arn, name: a.name, platform: "WEB", repository: "https://github.com/acme/marketing-site", defaultDomain,
      tags: { Team: "marketing" }, environmentVariables: { PUBLIC_API_URL: "https://api.acme.example", _LIVE_UPDATES: "[]" }, enableBasicAuth: false,
      productionBranch: { branchName: a.branch, status: "SUCCEED", lastDeployTime: new Date(now - DAY) },
      branches: [
        { branchArn: branch(a.branch), branchName: a.branch, displayName: a.branch, stage: "PRODUCTION", framework: "Astro", enableAutoBuild: true, updateTime: new Date(now - DAY), environmentVariables: { PUBLIC_ANALYTICS_ID: "acme-mkt" } },
        { branchArn: branch("preview"), branchName: "preview", displayName: "preview", stage: "DEVELOPMENT", framework: "Astro", enableAutoBuild: true, enableBasicAuth: true, updateTime: new Date(now - 3 * HOUR) },
      ],
      domains: [{ domainName: "acme.example", domainStatus: "AVAILABLE", subDomains: [{ subDomainSetting: { prefix: "marketing", branchName: a.branch }, verified: true }], certificate: { type: "AMPLIFY_MANAGED" } }],
      jobs: {
        [a.branch]: { jobId: "41", status: "SUCCEED", jobType: "RELEASE", commitId: "8c1f2e0", startTime: new Date(now - DAY - 4 * MIN), endTime: new Date(now - DAY) },
        preview: { jobId: "7", status: "FAILED", jobType: "RELEASE", commitId: "b37d9a1", startTime: new Date(now - 3 * HOUR), endTime: new Date(now - 3 * HOUR + 2 * MIN) },
      },
      enrichment: { branches: "ok", domains: "ok", jobs: "ok" },
    },
  ];
}
