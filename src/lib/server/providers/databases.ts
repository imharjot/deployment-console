// Data and storage providers beyond RDS instances, ElastiCache and DynamoDB: RDS clusters and proxies, ElastiCache
// Serverless, MemoryDB, OpenSearch, Redshift, EFS, EBS, FSx, Glue and Athena.
// Each lives in its own file (discovery, detail, IAM lists); see ./types.ts for the contract.
import "server-only";
import { athenaProvider } from "./athena.ts";
import { ebsProvider } from "./ebs.ts";
import { efsProvider } from "./efs.ts";
import { elasticacheServerlessProvider } from "./elasticache-serverless.ts";
import { fsxProvider } from "./fsx.ts";
import { glueProvider } from "./glue.ts";
import { memorydbProvider } from "./memorydb.ts";
import { opensearchProvider } from "./opensearch.ts";
import { rdsClusterProvider } from "./rds-cluster.ts";
import { redshiftProvider } from "./redshift.ts";
import type { Provider } from "./types.ts";

export const providers: Provider[] = [
  rdsClusterProvider, elasticacheServerlessProvider, memorydbProvider, opensearchProvider, redshiftProvider, efsProvider,
  ebsProvider, fsxProvider, glueProvider, athenaProvider,
];
