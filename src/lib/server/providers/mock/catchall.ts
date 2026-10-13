// Simulated Resource Explorer for the catch-all, per region (the provider sets multiRegionMock). us-east-1: what no
// first-class provider reads — the Glue database and the SageMaker model (table rows) and the SageMaker endpoint (a map
// node until its provider ships) — plus rows the de-duplication must fold into first-class resources (the ALB, the
// production database, a Lambda function, a queue, a bucket; their extra tags are copied over) and sub-objects it
// must only count (a network interface, a task definition). The global pass: an IAM user (table row) and the shop's
// CloudFront distribution (folded). eu-west-1: the eu database (a generic row until the rds provider reads eu-west-1,
// then folded through its "@eu-west-1" key) and a network interface. Other regions: nothing.
import type { RawExplorerResource } from "../../../inventory/catchall.ts";
import { ACCT, CATCHALL, CLOUDFRONT, EU, EU_REGION, EXISTING, GLUE, LAMBDA, REGION, S3, SAGEMAKER, SQS } from "../mock-names.ts";

const row = (arn: string, type: string, region: string, tags?: Record<string, string>): RawExplorerResource => ({
  Arn: arn, ResourceType: type, Region: region, OwningAccountId: ACCT, Service: type.split(":")[0],
  LastReportedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  Properties: tags ? [{ Name: "tags", LastReportedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), Data: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }] : [],
});

// `global`: the "region:global" pass of the home run (CC-7).
export function simExplorer(region: string, global: boolean): RawExplorerResource[] {
  if (global)
    return [
      row(CATCHALL.iamUser.arn, "iam:user", "global", { team: "platform" }),
      row(`arn:aws:cloudfront::${ACCT}:distribution/${CLOUDFRONT.shop.id}`, "cloudfront:distribution", "global", { "cost-center": "storefront" }),
    ];
  if (region === REGION)
    return [
      row(GLUE.database.arn, "glue:database", REGION, { Environment: "production" }),
      row(SAGEMAKER.model.arn, "sagemaker:model", REGION, { team: "data" }),
      row(SAGEMAKER.endpoint.arn, "sagemaker:endpoint", REGION, { Environment: "production", team: "data" }),
      row(EXISTING.alb.arn, "elasticloadbalancing:loadbalancer/app", REGION, { "cost-center": "storefront" }),
      row(`arn:aws:rds:${REGION}:${ACCT}:db:${EXISTING.rds.production}`, "rds:db", REGION, { backup: "daily" }),
      row(LAMBDA.orderEvents.arn, "lambda:function", REGION),
      row(SQS.orders.arn, "sqs:queue", REGION),
      row(S3.assets.arn, "s3:bucket", REGION),
      row(CATCHALL.networkInterface, "ec2:network-interface", REGION),
      row(CATCHALL.taskDefinition, "ecs:task-definition", REGION),
    ];
  if (region === EU_REGION)
    return [
      row(EU.rds.arn, "rds:db", EU_REGION, { Environment: "production" }),
      row(CATCHALL.networkInterface.replace(`:${REGION}:`, `:${EU_REGION}:`), "ec2:network-interface", EU_REGION),
    ];
  return [];
}
