// Simulated Athena workgroups of the Acme account (names from ../mock-names.ts), as ListWorkGroups + GetWorkGroup return
// them, per region. Both simulated regions have the untouched default "primary" (no result location: hidden); us-east-1
// also has acme-analysts, which writes query results to the data lake bucket, encrypted with the application KMS key.
// Regions outside the simulation: none. Read-only.
import type { RawWorkGroup } from "../../../inventory/athena.ts";
import { ATHENA, KMS_KEYS, MOCK_REGIONS, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

const ENGINE = { SelectedEngineVersion: "AUTO", EffectiveEngineVersion: "Athena engine version 3" };

export function simAthena(region: string, now: number = Date.now()): RawWorkGroup[] {
  if (!MOCK_REGIONS.includes(region)) return [];
  const primary: RawWorkGroup = {
    Name: ATHENA.primary.name, State: "ENABLED", Description: "", CreationTime: new Date(now - 900 * DAY), EngineVersion: ENGINE, enrichment: { config: "ok" },
    config: { ResultConfiguration: {}, EnforceWorkGroupConfiguration: false, PublishCloudWatchMetricsEnabled: true, RequesterPaysEnabled: false, EngineVersion: ENGINE },
  };
  if (region !== REGION) return [primary];
  return [
    primary,
    {
      Name: ATHENA.analysts.name, State: "ENABLED", Description: "Ad-hoc analysis of the data lake", CreationTime: new Date(now - 300 * DAY), EngineVersion: ENGINE, enrichment: { config: "ok" },
      config: {
        ResultConfiguration: { OutputLocation: ATHENA.analysts.output, EncryptionConfiguration: { EncryptionOption: "SSE_KMS", KmsKey: KMS_KEYS.app.arn } },
        EnforceWorkGroupConfiguration: true, PublishCloudWatchMetricsEnabled: true, BytesScannedCutoffPerQuery: 10 * 1024 ** 3, EngineVersion: ENGINE,
      },
    },
  ];
}
