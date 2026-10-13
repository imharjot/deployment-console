// Monitoring providers: CloudWatch log groups and alarms, Synthetics canaries and CloudTrail trails.
// Each lives in its own file (discovery, detail, IAM lists); see ./types.ts for the contract.
import "server-only";
import { alarmsProvider } from "./alarms.ts";
import { cloudtrailProvider } from "./cloudtrail.ts";
import { logsProvider } from "./logs.ts";
import { syntheticsProvider } from "./synthetics.ts";
import type { Provider } from "./types.ts";

export const providers: Provider[] = [logsProvider, alarmsProvider, syntheticsProvider, cloudtrailProvider];
