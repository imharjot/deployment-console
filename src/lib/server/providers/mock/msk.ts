// Simulated MSK of the Acme account (names from ../mock-names.ts), as ListClustersV2 + GetBootstrapBrokers return it,
// per region. us-east-1: acme-events, a provisioned two-broker cluster in the production private
// subnets, IAM authentication only, data volumes encrypted with the application KMS key. Other regions: none.
// Read-only.
import type { RawMskCluster } from "../../../inventory/msk.ts";
import { KMS_KEYS, MSK, NETWORK, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

export function simMsk(region: string, now: number = Date.now()): RawMskCluster[] {
  if (region !== REGION) return [];
  const hosts = MSK.brokers.map((b) => b.replace(/:\d+$/, ""));
  return [
    {
      ClusterArn: MSK.arn, ClusterName: MSK.name, ClusterType: "PROVISIONED", State: "ACTIVE", CreationTime: new Date(now - 240 * DAY), CurrentVersion: "K3AEGXETSR30VB",
      Tags: { Environment: "production", Team: "platform" },
      Provisioned: {
        BrokerNodeGroupInfo: { ClientSubnets: [...NETWORK.production.privateSubnets], InstanceType: "kafka.m7g.large", StorageInfo: { EbsStorageInfo: { VolumeSize: 100 } }, ConnectivityInfo: { PublicAccess: { Type: "DISABLED" } } },
        CurrentBrokerSoftwareInfo: { KafkaVersion: "3.6.0" },
        ClientAuthentication: { Sasl: { Iam: { Enabled: true }, Scram: { Enabled: false } }, Tls: { Enabled: false }, Unauthenticated: { Enabled: false } },
        EncryptionInfo: { EncryptionAtRest: { DataVolumeKMSKeyId: KMS_KEYS.app.arn }, EncryptionInTransit: { ClientBroker: "TLS", InCluster: true } },
        NumberOfBrokerNodes: hosts.length, StorageMode: "LOCAL", CustomerActionStatus: "NONE",
      },
      bootstrap: { BootstrapBrokerStringSaslIam: MSK.brokers.join(","), BootstrapBrokerStringTls: hosts.map((h) => `${h}:9094`).join(",") },
      enrichment: { bootstrap: "ok" },
    },
  ];
}
