// Messaging and application-platform providers: MSK, Amazon MQ, Firehose, SES, EventBridge Scheduler and Pipes,
// AWS Batch, Transfer Family, AppSync, Amplify Hosting and Lightsail.
// Each lives in its own file (discovery, detail, IAM lists); see ./types.ts for the contract.
import "server-only";
import { amplifyProvider } from "./amplify.ts";
import { appsyncProvider } from "./appsync.ts";
import { batchProvider } from "./batch.ts";
import { firehoseProvider } from "./firehose.ts";
import { lightsailProvider } from "./lightsail.ts";
import { mqProvider } from "./mq.ts";
import { mskProvider } from "./msk.ts";
import { pipesProvider } from "./pipes.ts";
import { schedulerProvider } from "./scheduler.ts";
import { sesProvider } from "./ses.ts";
import { transferProvider } from "./transfer.ts";
import type { Provider } from "./types.ts";

export const providers: Provider[] = [
  mskProvider, mqProvider, firehoseProvider, sesProvider, schedulerProvider, pipesProvider, batchProvider, transferProvider,
  appsyncProvider, amplifyProvider, lightsailProvider,
];
