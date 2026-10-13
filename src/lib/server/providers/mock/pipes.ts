// Simulated EventBridge Pipes of the Acme account (names from ../mock-names.ts), as ListPipes + DescribePipe return
// them, per region. us-east-1: acme-orders-to-checkout reads placed orders from the orders queue (filtered on
// status PLACED) and starts the checkout state machine with a small input template. Other regions: none. Read-only.
import type { RawPipe } from "../../../inventory/scheduling.ts";
import { PIPES, REGION, SFN, SQS } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

export function simPipes(region: string, now: number = Date.now()): RawPipe[] {
  if (region !== REGION) return [];
  const p = PIPES.orders;
  return [
    {
      Arn: p.arn, Name: p.name, DesiredState: "RUNNING", CurrentState: "RUNNING", Source: SQS.orders.arn, Target: SFN.checkout.arn,
      CreationTime: new Date(now - 90 * DAY), LastModifiedTime: new Date(now - 9 * DAY), Description: "Placed orders start a checkout",
      SourceParameters: { SqsQueueParameters: { BatchSize: 10 }, FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ body: { status: ["PLACED"] } }) }] } },
      TargetParameters: { InputTemplate: '{"orderId": <$.body.orderId>, "channel": "orders-pipe"}' },
      LogConfiguration: { Level: "OFF" },
      Tags: { Environment: "production" }, described: true, enrichment: { describe: "ok" },
    },
  ];
}
