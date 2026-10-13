// Simulated CloudFormation of the Acme account (names from ../mock-names.ts), as DescribeStacks, ListStackResources and
// DescribeStackEvents would return them, per region (the provider sets multiRegionMock). us-east-1: acme-network (both
// VPCs, their subnets, gateways and security groups; it has drifted — someone opened sg-stg-db by hand) and
// acme-production-data (the production database, cache, orders queue and carts table). Parameters carry a NoEcho
// password and an output a connection string: the map shows neither. Other regions: none. Read-only.
import type { RawStack, RawStackEvent, RawStackResource } from "../../../inventory/cloudformation.ts";
import { CFN, DYNAMO, EXISTING, NETWORK, REGION, SQS } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

export function simStacks(region: string, now: number = Date.now()): RawStack[] {
  if (region !== REGION) return [];
  return [
    {
      StackId: CFN.network.arn, StackName: CFN.network.name, StackStatus: "UPDATE_COMPLETE", Description: "Acme VPCs, subnets, gateways and security groups",
      CreationTime: new Date(now - 700 * DAY), LastUpdatedTime: new Date(now - 45 * DAY), EnableTerminationProtection: true,
      DriftInformation: { StackDriftStatus: "DRIFTED", LastCheckTimestamp: new Date(now - 2 * DAY) },
      Parameters: [{ ParameterKey: "ProductionCidr", ParameterValue: NETWORK.production.cidr }, { ParameterKey: "StagingCidr", ParameterValue: NETWORK.staging.cidr }],
      Outputs: [
        { OutputKey: "ProductionVpcId", OutputValue: NETWORK.production.vpc, ExportName: "acme-production-vpc" },
        { OutputKey: "StagingVpcId", OutputValue: NETWORK.staging.vpc, ExportName: "acme-staging-vpc" },
      ],
      Tags: [{ Key: "team", Value: "platform" }],
    },
    {
      StackId: CFN.data.arn, StackName: CFN.data.name, StackStatus: "UPDATE_COMPLETE", Description: "Production data stores",
      CreationTime: new Date(now - 600 * DAY), LastUpdatedTime: new Date(now - 12 * DAY), EnableTerminationProtection: true,
      DriftInformation: { StackDriftStatus: "IN_SYNC", LastCheckTimestamp: new Date(now - 2 * DAY) },
      Parameters: [{ ParameterKey: "DbInstanceClass", ParameterValue: "db.m7g.large" }, { ParameterKey: "DbPassword", ParameterValue: "****" }],
      Outputs: [
        { OutputKey: "DbEndpoint", OutputValue: EXISTING.rdsHost(EXISTING.rds.production), ExportName: "acme-production-db-endpoint" },
        { OutputKey: "OrdersQueueUrl", OutputValue: SQS.orders.url },
        { OutputKey: "DbConnection", OutputValue: `postgres://app:pg-api-production-pass@${EXISTING.rdsHost(EXISTING.rds.production)}:5432/shop` },
      ],
      Tags: [{ Key: "Environment", Value: "production" }, { Key: "team", Value: "platform" }],
    },
  ];
}

const r = (LogicalResourceId: string, ResourceType: string, PhysicalResourceId: string): RawStackResource => ({ LogicalResourceId, ResourceType, PhysicalResourceId, ResourceStatus: "UPDATE_COMPLETE" });

export function simStackResources(region: string, stackId: string): RawStackResource[] {
  if (region !== REGION) return [];
  if (stackId === CFN.network.arn)
    return [
      r("ProductionVpc", "AWS::EC2::VPC", NETWORK.production.vpc),
      ...NETWORK.production.privateSubnets.map((s, i) => r(`ProductionPrivate${"AB"[i]}`, "AWS::EC2::Subnet", s)),
      ...NETWORK.production.publicSubnets.map((s, i) => r(`ProductionPublic${"AB"[i]}`, "AWS::EC2::Subnet", s)),
      r("ProductionIgw", "AWS::EC2::InternetGateway", NETWORK.production.igw),
      r("ProductionNat", "AWS::EC2::NatGateway", NETWORK.production.nat),
      r("ProductionIgwAttachment", "AWS::EC2::VPCGatewayAttachment", "acme-n-Produ-1A2B3C4D5E6F"),
      r("StagingVpc", "AWS::EC2::VPC", NETWORK.staging.vpc),
      ...NETWORK.staging.publicSubnets.map((s) => r("StagingPublicA", "AWS::EC2::Subnet", s)),
      ...NETWORK.staging.namedPrivateSubnets.map((s, i) => r(`StagingPrivate${"AB"[i]}`, "AWS::EC2::Subnet", s)),
      r("StagingIgw", "AWS::EC2::InternetGateway", NETWORK.staging.igw),
      r("StagingDbSecurityGroup", "AWS::EC2::SecurityGroup", EXISTING.securityGroups.stagingDb),
      r("ProductionDbSecurityGroup", "AWS::EC2::SecurityGroup", EXISTING.securityGroups.prodDb),
    ];
  if (stackId === CFN.data.arn)
    return [
      r("Database", "AWS::RDS::DBInstance", EXISTING.rds.production),
      r("DatabaseSubnets", "AWS::RDS::DBSubnetGroup", "acme-production-db-subnets"),
      r("Cache", "AWS::ElastiCache::ReplicationGroup", EXISTING.valkey.id),
      r("OrdersQueue", "AWS::SQS::Queue", SQS.orders.url),
      r("OrdersDlq", "AWS::SQS::Queue", SQS.ordersDlq.url),
      r("CartsTable", "AWS::DynamoDB::Table", DYNAMO.carts.name),
      r("DbPasswordSecretAttachment", "AWS::SecretsManager::SecretTargetAttachment", "arn:aws:secretsmanager:us-east-1:123456789012:secret:acme/production/db-Xy12Zw"),
    ];
  return [];
}

export function simStackEvents(region: string, stackId: string, now: number = Date.now()): RawStackEvent[] {
  if (region !== REGION) return [];
  const name = stackId === CFN.network.arn ? CFN.network.name : CFN.data.name;
  const at = stackId === CFN.network.arn ? 45 : 12;
  return [
    { Timestamp: new Date(now - at * DAY + 300_000), LogicalResourceId: name, ResourceType: "AWS::CloudFormation::Stack", ResourceStatus: "UPDATE_COMPLETE" },
    { Timestamp: new Date(now - at * DAY + 240_000), LogicalResourceId: stackId === CFN.network.arn ? "ProductionNat" : "Database", ResourceType: stackId === CFN.network.arn ? "AWS::EC2::NatGateway" : "AWS::RDS::DBInstance", ResourceStatus: "UPDATE_COMPLETE" },
    { Timestamp: new Date(now - at * DAY), LogicalResourceId: name, ResourceType: "AWS::CloudFormation::Stack", ResourceStatus: "UPDATE_IN_PROGRESS", ResourceStatusReason: "User Initiated" },
  ];
}
