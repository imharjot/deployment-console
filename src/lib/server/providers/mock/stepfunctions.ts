// Simulated Step Functions of the Acme account (names from ../mock-names.ts): the checkout workflow — reserve stock
// with the checkout-reserve Lambda (retried), then publish to the notifications topic, or fail. The definition is
// real ASL, so the same parser that reads real state machines finds its Links; it logs errors to its vended log group
// and is encrypted with the application KMS key. Only us-east-1 has it. start-execution adds an execution that
// succeeds a few seconds later.
import type { RawStateMachine } from "../../../inventory/serverless-sfn.ts";
import { ACCT, KMS_KEYS, LAMBDA, LOG_GROUPS, REGION, SFN, SNS } from "../mock-names.ts";
import { DAY, MIN, simState } from "./serverless-sim.ts";

// The log group the console creates for a state machine's logging (not in mock-names: the logs simulation may list it).
export const CHECKOUT_LOG_GROUP = "/aws/vendedlogs/states/acme-production-checkout";

export interface SimExecution {
  name: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  startDate: Date;
  stopDate?: Date;
}

const CHECKOUT_ASL = {
  Comment: "Checkout: reserve stock, then tell the customer",
  StartAt: "Reserve stock",
  States: {
    "Reserve stock": {
      Type: "Task",
      Resource: "arn:aws:states:::lambda:invoke",
      Parameters: { FunctionName: `${LAMBDA.checkoutStep.arn}:$LATEST`, "Payload.$": "$" },
      Retry: [{ ErrorEquals: ["Lambda.TooManyRequestsException", "Lambda.ServiceException"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2 }],
      Catch: [{ ErrorEquals: ["States.ALL"], Next: "Checkout failed" }],
      ResultPath: "$.reservation",
      Next: "Reserved?",
    },
    "Reserved?": {
      Type: "Choice",
      Choices: [{ Variable: "$.reservation.Payload.ok", BooleanEquals: true, Next: "Notify customer" }],
      Default: "Checkout failed",
    },
    "Notify customer": {
      Type: "Task",
      Resource: "arn:aws:states:::sns:publish",
      Parameters: { TopicArn: SNS.notifications.arn, "Message.$": "States.JsonToString($.reservation.Payload)", MessageAttributes: { channel: { DataType: "String", StringValue: "email" } } },
      End: true,
    },
    "Checkout failed": { Type: "Fail", Error: "CheckoutFailed", Cause: "stock could not be reserved" },
  },
};

function build() {
  const now = Date.now();
  const executions: SimExecution[] = Array.from({ length: 6 }, (_, i) => {
    const start = now - (i + 1) * 7 * MIN;
    const failed = i === 3;
    return { name: `order-${(981_240 - i * 17).toString()}`, status: failed ? "FAILED" : "SUCCEEDED", startDate: new Date(start), stopDate: new Date(start + 1_800 + i * 90) };
  });
  const machines: (RawStateMachine & { executions: SimExecution[] })[] = [
    {
      stateMachineArn: SFN.checkout.arn, name: SFN.checkout.name, type: "STANDARD", status: "ACTIVE", definition: JSON.stringify(CHECKOUT_ASL, null, 2),
      roleArn: `arn:aws:iam::${ACCT}:role/acme-production-checkout-sfn`, description: "Order checkout workflow", creationDate: new Date(now - 200 * DAY),
      loggingConfiguration: { level: "ERROR", destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: `${LOG_GROUPS.arn(CHECKOUT_LOG_GROUP)}:*` } }] },
      tracingConfiguration: { enabled: true }, encryptionConfiguration: { type: "CUSTOMER_MANAGED_KMS_KEY", kmsKeyId: KMS_KEYS.app.arn },
      tags: { Environment: "production", Team: "shop" }, executions,
    },
  ];
  return machines;
}

const state = () => simState("__dcSimSfn", build);

export const simMachine = (arn: string) => state().find((m) => m.stateMachineArn === arn);

function settle(m: { executions: SimExecution[] }, now: number) {
  for (const e of m.executions) if (e.status === "RUNNING" && now - e.startDate.getTime() > 3_000) {
    e.status = "SUCCEEDED";
    e.stopDate = new Date(e.startDate.getTime() + 2_400);
  }
}

export function simSfn(region: string = REGION): RawStateMachine[] {
  if (region !== REGION) return [];
  const now = Date.now();
  return state().map(({ executions, ...m }) => {
    settle({ executions }, now);
    return { ...m, lastActivityAt: executions[0]?.startDate.getTime() };
  });
}

export function simExecutions(arn: string): SimExecution[] {
  const m = simMachine(arn);
  if (!m) return [];
  settle(m, Date.now());
  return m.executions.slice(0, 10);
}

export function simStart(arn: string, name?: string): { executionArn: string; startDate: Date } {
  const m = simMachine(arn);
  if (!m) throw Object.assign(new Error(`State Machine Does Not Exist: '${arn}'`), { name: "StateMachineDoesNotExist" });
  const exec: SimExecution = { name: name ?? crypto.randomUUID(), status: "RUNNING", startDate: new Date() };
  m.executions.unshift(exec);
  m.executions.length = Math.min(m.executions.length, 50);
  return { executionArn: `${arn.replace(":stateMachine:", ":execution:")}:${exec.name}`, startDate: exec.startDate };
}
