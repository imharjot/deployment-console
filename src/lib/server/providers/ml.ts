// Machine-learning providers: SageMaker endpoints and notebooks, and Bedrock agents, knowledge bases and provisioned
// throughput (inventory only: the console never invokes a model through these).
// Each lives in its own file (discovery, detail, IAM lists); see ./types.ts for the contract.
import "server-only";
import { bedrockProvider } from "./bedrock.ts";
import { sagemakerProvider } from "./sagemaker.ts";
import type { Provider } from "./types.ts";

export const providers: Provider[] = [sagemakerProvider, bedrockProvider];
