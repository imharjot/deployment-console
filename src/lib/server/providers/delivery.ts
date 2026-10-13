// Build and delivery providers: ECR repositories, CodePipeline, CodeBuild, CodeDeploy and CloudFormation stacks.
// Each lives in its own file (discovery, detail, IAM lists); see ./types.ts for the contract.
import "server-only";
import { cloudformationProvider } from "./cloudformation.ts";
import { codebuildProvider } from "./codebuild.ts";
import { codedeployProvider } from "./codedeploy.ts";
import { codepipelineProvider } from "./codepipeline.ts";
import { ecrProvider } from "./ecr.ts";
import type { Provider } from "./types.ts";

export const providers: Provider[] = [ecrProvider, codepipelineProvider, codebuildProvider, codedeployProvider, cloudformationProvider];
