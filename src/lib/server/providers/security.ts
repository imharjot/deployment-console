// Security and identity providers: IAM roles, KMS keys, ACM certificates, Secrets Manager and Parameter Store
// metadata (never values), WAF, Cognito user pools and AWS Backup.
// Each lives in its own file (discovery, detail, IAM lists); see ./types.ts for the contract.
import "server-only";
import { acmProvider } from "./acm.ts";
import { backupProvider } from "./backup.ts";
import { cognitoProvider } from "./cognito.ts";
import { iamProvider } from "./iam.ts";
import { kmsProvider } from "./kms.ts";
import { secretsProvider } from "./secrets.ts";
import { ssmProvider } from "./ssm.ts";
import { wafProvider } from "./waf.ts";
import type { Provider } from "./types.ts";

export const providers: Provider[] = [
  iamProvider, kmsProvider, acmProvider, secretsProvider, ssmProvider, wafProvider, cognitoProvider, backupProvider,
];
