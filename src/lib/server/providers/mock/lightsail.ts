// Simulated Lightsail of the Acme account (names from ../mock-names.ts), as GetInstances + GetContainerServices +
// GetRelationalDatabases return it, per region. us-east-1: the company blog — acme-wordpress (a running instance with a
// static IP, SSH and web open to anyone) on its private acme-wp-db database — and acme-status-page, a container
// service that polls the storefront API. Other regions: none. Read-only.
import type { LightsailInput } from "../../../inventory/app-platforms.ts";
import { LIGHTSAIL, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

export function simLightsail(region: string, now: number = Date.now()): LightsailInput {
  if (region !== REGION) return { instances: [], containers: [], databases: [] };
  const loc = { availabilityZone: `${REGION}a`, regionName: REGION };
  return {
    instances: [
      {
        name: LIGHTSAIL.instance.name, arn: LIGHTSAIL.instance.arn, createdAt: new Date(now - 900 * DAY), location: loc, tags: [{ key: "Team", value: "marketing" }],
        blueprintName: "WordPress", bundleId: "small_3_0", isStaticIp: true, publicIpAddress: "203.0.113.60", privateIpAddress: "172.26.4.10", state: { code: 16, name: "running" },
        networking: { ports: [
          { fromPort: 22, toPort: 22, protocol: "tcp", cidrs: ["0.0.0.0/0"] },
          { fromPort: 80, toPort: 80, protocol: "tcp", cidrs: ["0.0.0.0/0"] },
          { fromPort: 443, toPort: 443, protocol: "tcp", cidrs: ["0.0.0.0/0"] },
        ] },
      },
    ],
    containers: [
      {
        containerServiceName: LIGHTSAIL.container.name, arn: LIGHTSAIL.container.arn, createdAt: new Date(now - 200 * DAY), location: loc, tags: [{ key: "Team", value: "platform" }],
        power: "nano", scale: 1, state: "RUNNING", isDisabled: false, url: `https://${LIGHTSAIL.container.name}.0acme0ls.${REGION}.cs.amazonlightsail.com/`,
        privateDomainName: `${LIGHTSAIL.container.name}.service.local`, publicDomainNames: { "acme-status-cert": ["status.acme.example"] },
        currentDeployment: {
          version: 12, state: "ACTIVE",
          containers: { web: { image: "ghcr.io/acme/status-page:3.2", environment: { CHECK_URL: "https://api.acme.example/healthz", INTERVAL: "30" }, ports: { "8080": "HTTP" } } },
          publicEndpoint: { containerName: "web", containerPort: 8080 },
        },
      },
    ],
    databases: [
      {
        name: LIGHTSAIL.database.name, arn: LIGHTSAIL.database.arn, createdAt: new Date(now - 900 * DAY), location: loc, tags: [{ key: "Team", value: "marketing" }],
        engine: "mysql", engineVersion: "8.0.39", relationalDatabaseBundleId: "micro_2_0", state: "available", backupRetentionEnabled: true, publiclyAccessible: false,
        masterEndpoint: { address: `ls-0acme0wpdb0000001.c0example.${REGION}.rds.amazonaws.com`, port: 3306 },
      },
    ],
  };
}
