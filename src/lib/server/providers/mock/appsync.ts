// Simulated AppSync of the Acme account (names from ../mock-names.ts), as ListGraphqlApis + ListDataSources return it,
// per region. us-east-1: acme-catalog-graphql, the storefront's GraphQL API — customers sign in through the Cognito pool,
// resolvers read the carts table directly and call the public-api Lambda for prices. Other regions: none. API keys are
// never simulated (the provider never lists them). Read-only.
import type { RawGraphqlApi } from "../../../inventory/app-platforms.ts";
import { APPSYNC, COGNITO, LAMBDA, REGION } from "../mock-names.ts";

export function simAppsync(region: string): RawGraphqlApi[] {
  if (region !== REGION) return [];
  const a = APPSYNC.catalog;
  const host = `${a.id}.appsync-api.${REGION}.amazonaws.com`;
  return [
    {
      name: a.name, apiId: a.id, arn: a.arn, apiType: "GRAPHQL", visibility: "GLOBAL", authenticationType: "AMAZON_COGNITO_USER_POOLS",
      userPoolConfig: { userPoolId: COGNITO.customers.id, awsRegion: REGION }, additionalAuthenticationProviders: [{ authenticationType: "AWS_IAM" }],
      uris: { GRAPHQL: `https://${host}/graphql`, REALTIME: `wss://${a.id}.appsync-realtime-api.${REGION}.amazonaws.com/graphql` },
      xrayEnabled: false,
      tags: { Environment: "production", Team: "storefront" },
      dataSources: [
        { dataSourceArn: `${a.arn}/datasources/carts`, name: "carts", type: "AMAZON_DYNAMODB", dynamodbConfig: { tableName: a.table, awsRegion: REGION } },
        { dataSourceArn: `${a.arn}/datasources/prices`, name: "prices", type: "AWS_LAMBDA", lambdaConfig: { lambdaFunctionArn: LAMBDA.apiHandler.arn } },
        { dataSourceArn: `${a.arn}/datasources/local`, name: "local", type: "NONE" },
      ],
      enrichment: { dataSources: "ok" },
    },
  ];
}
