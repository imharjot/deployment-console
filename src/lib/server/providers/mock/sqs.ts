// Simulated SQS queues of the Acme account (names from ../mock-names.ts): the orders queue (polled by the order-events
// Lambda) redriving into its dead-letter queue, which holds 3 failed messages; the emails queue the notifications topic
// fans out to (encrypted with the application KMS key); the staging orders queue (AWS-managed key alias/aws/sqs); and
// an export queue nobody has used for months. Only us-east-1 has queues. Attributes are what GetQueueAttributes(All)
// returns; actions change them (send adds a message, redrive moves them back, purge empties).
import type { RawQueue } from "../../../inventory/serverless-messaging.ts";
import { KMS_KEYS, REGION, SQS } from "../mock-names.ts";
import { DAY, HOUR, MIN, simState } from "./serverless-sim.ts";

interface SimQueue {
  url: string;
  arn: string;
  visible: number;
  inFlight: number;
  attrs: Record<string, string>;
  tags: Record<string, string>;
  activeAgo: number;
  createdAgo: number;
  rate: number; // messages per hour (charts)
  moveTasks: { handle: string; status: string; moved: number; toMove: number; startedAt: number }[];
}

function build(): Record<string, SimQueue> {
  const q = (def: { name: string; arn: string; url: string }, o: Partial<SimQueue> & { attrs?: Record<string, string> }): SimQueue => ({
    url: def.url, arn: def.arn, visible: 0, inFlight: 0, tags: {}, activeAgo: 2 * MIN, createdAgo: 400 * DAY, rate: 60, moveTasks: [], ...o,
    attrs: { VisibilityTimeout: "30", MessageRetentionPeriod: "345600", MaximumMessageSize: "262144", DelaySeconds: "0", ReceiveMessageWaitTimeSeconds: "20", SqsManagedSseEnabled: "true", ...o.attrs },
  });
  const prod = { Environment: "production", Team: "shop" };
  return {
    [SQS.orders.name]: q(SQS.orders, {
      visible: 12, inFlight: 3, tags: prod, activeAgo: 30_000, rate: 900,
      attrs: { VisibilityTimeout: "180", RedrivePolicy: JSON.stringify({ deadLetterTargetArn: SQS.ordersDlq.arn, maxReceiveCount: 5 }) },
    }),
    [SQS.ordersDlq.name]: q(SQS.ordersDlq, {
      visible: 3, tags: prod, activeAgo: 5 * HOUR, rate: 0.2,
      attrs: { MessageRetentionPeriod: "1209600", RedriveAllowPolicy: JSON.stringify({ redrivePermission: "byQueue", sourceQueueArns: [SQS.orders.arn] }) },
    }),
    [SQS.emails.name]: q(SQS.emails, { visible: 0, inFlight: 1, tags: prod, activeAgo: 6 * MIN, rate: 210, attrs: { KmsMasterKeyId: KMS_KEYS.app.alias, SqsManagedSseEnabled: "false" } }),
    [SQS.ordersStaging.name]: q(SQS.ordersStaging, { visible: 1, tags: { Environment: "staging", Team: "shop" }, activeAgo: 40 * MIN, rate: 5, attrs: { KmsMasterKeyId: "alias/aws/sqs", SqsManagedSseEnabled: "false" } }),
    [SQS.exportsOld.name]: q(SQS.exportsOld, { visible: 0, activeAgo: 120 * DAY, createdAgo: 900 * DAY, rate: 0, attrs: { SqsManagedSseEnabled: "false" } }),
  };
}

const state = () => simState("__dcSimSqs", build);

export const simQueue = (name: string): SimQueue | undefined => state()[name];
export const simQueueByArn = (arn: string): SimQueue | undefined => Object.values(state()).find((q) => q.arn === arn);

// Move tasks finish a few seconds after they start.
function settle(q: SimQueue, now: number) {
  for (const t of q.moveTasks) if (t.status === "RUNNING" && now - t.startedAt > 4_000) {
    t.status = "COMPLETED";
    t.moved = t.toMove;
  }
}

export function simSqs(region: string = REGION): RawQueue[] {
  if (region !== REGION) return [];
  const now = Date.now();
  return Object.values(state()).map((q) => {
    settle(q, now);
    const created = Math.floor((now - q.createdAgo) / 1000);
    return {
      url: q.url,
      attributes: {
        ...q.attrs, QueueArn: q.arn, ApproximateNumberOfMessages: String(q.visible), ApproximateNumberOfMessagesNotVisible: String(q.inFlight),
        ApproximateNumberOfMessagesDelayed: "0", CreatedTimestamp: String(created), LastModifiedTimestamp: String(created + 3 * 86_400),
      },
      tags: { ...q.tags },
      lastActivityAt: now - q.activeAgo,
    };
  });
}

function must(name: string): SimQueue {
  const q = simQueue(name);
  if (!q) throw Object.assign(new Error(`The specified queue does not exist: ${name}`), { name: "QueueDoesNotExist" });
  return q;
}

export function simSend(name: string): { messageId: string } {
  const q = must(name);
  q.visible += 1;
  q.activeAgo = 0;
  return { messageId: crypto.randomUUID() };
}

// Like StartMessageMoveTask without a destination: every message goes back to the queue it came from.
export function simRedrive(dlqName: string): { taskHandle: string; moved: number } {
  const dlq = must(dlqName);
  const sources = Object.values(state()).filter((q) => q.attrs.RedrivePolicy?.includes(dlq.arn));
  const moved = dlq.visible;
  const target = sources[0];
  if (target) target.visible += moved;
  dlq.visible = 0;
  const handle = Buffer.from(JSON.stringify({ taskId: crypto.randomUUID(), sourceArn: dlq.arn })).toString("base64");
  dlq.moveTasks.unshift({ handle, status: "RUNNING", moved: 0, toMove: moved, startedAt: Date.now() });
  return { taskHandle: handle, moved };
}

export function simPurge(name: string): { purged: number } {
  const q = must(name);
  const purged = q.visible + q.inFlight;
  q.visible = 0;
  q.inFlight = 0;
  return { purged };
}

export const simMoveTasks = (name: string) => {
  const q = must(name);
  settle(q, Date.now());
  return q.moveTasks.slice(0, 5);
};
export const simQueueRate = (name: string) => simQueue(name)?.rate ?? 0;
