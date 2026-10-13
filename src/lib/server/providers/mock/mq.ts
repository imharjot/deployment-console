// Simulated Amazon MQ of the Acme account (names from ../mock-names.ts), as ListBrokers + DescribeBroker return it, per
// region. us-east-1: acme-legacy-mq, a single-instance ActiveMQ broker the old order system still talks to, private,
// in a production subnet, on an AWS-owned key. Other regions: none. Read-only.
import type { RawBroker } from "../../../inventory/streaming.ts";
import { MQ, NETWORK, REGION } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

export function simMq(region: string, now: number = Date.now()): RawBroker[] {
  if (region !== REGION) return [];
  const h = MQ.host;
  return [
    {
      BrokerArn: MQ.arn, BrokerId: MQ.id, BrokerName: MQ.name, BrokerState: "RUNNING", Created: new Date(now - 700 * DAY), DeploymentMode: "SINGLE_INSTANCE", EngineType: "ACTIVEMQ",
      HostInstanceType: "mq.t3.micro", EngineVersion: "5.18", PubliclyAccessible: false, SubnetIds: [NETWORK.production.privateSubnets[0]], AuthenticationStrategy: "SIMPLE", StorageType: "EFS",
      BrokerInstances: [{ ConsoleURL: `https://${h}:8162`, IpAddress: "10.20.2.31", Endpoints: [`ssl://${h}:61617`, `amqp+ssl://${h}:5671`, `stomp+ssl://${h}:61614`, `mqtt+ssl://${h}:8883`, `wss://${h}:61619`] }],
      EncryptionOptions: { UseAwsOwnedKey: true }, Logs: { General: false, Audit: false }, Users: [{ Username: "orders-legacy" }],
      Tags: { Environment: "production", Owner: "orders" }, described: true, enrichment: { describe: "ok" },
    },
  ];
}
