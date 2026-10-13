// Serverless & messaging providers: Lambda, SQS, SNS, EventBridge, Step Functions, Kinesis, DynamoDB and API Gateway.
// Each lives in its own file (discovery, detail, actions, IAM lists); the pure mapping from API shapes to resources
// and links is in src/lib/inventory/serverless-*.ts, and the simulated Acme estate in ./mock/<id>.ts.
import "server-only";
import { apigatewayProvider } from "./apigateway.ts";
import { dynamodbProvider } from "./dynamodb.ts";
import { eventbridgeProvider } from "./eventbridge.ts";
import { kinesisProvider } from "./kinesis.ts";
import { lambdaProvider } from "./lambda.ts";
import { snsProvider } from "./sns.ts";
import { sqsProvider } from "./sqs.ts";
import { stepfunctionsProvider } from "./stepfunctions.ts";
import type { Provider } from "./types.ts";

export const providers: Provider[] = [lambdaProvider, sqsProvider, snsProvider, eventbridgeProvider, stepfunctionsProvider, kinesisProvider, dynamodbProvider, apigatewayProvider];
