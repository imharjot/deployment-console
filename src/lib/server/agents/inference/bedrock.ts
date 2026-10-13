// Amazon Bedrock connections: ConverseStream with the CONNECTION's credentials — its own keys, or a role assumed with
// its own base keys. Every client here is built with explicit credentials, so the SDK never falls back to the console's
// identity (the task role or the default credential chain): the identity that can change infrastructure never runs
// inference. That is why this directory is outside the console-role IAM policy test and the SDK-limiter scan, and why
// the Bedrock runtime client may be imported nowhere else (src/lib/iam-policy.test.ts).
import "server-only";
import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand, type InferenceProfileSummary } from "@aws-sdk/client-bedrock";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { createBedrockAdapter, type AwsKeys } from "../../../agents/inference/bedrock-adapter.ts";
import { inferenceCache } from "./fetch.ts";

const creds = (k: AwsKeys) => ({ accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, ...(k.sessionToken ? { sessionToken: k.sessionToken } : {}) });
// Model calls retry once at most (the runner owns backoff); listing and role sessions get a short timeout.
const LIST_TIMEOUT_MS = 15_000;

// The event stream, closing its per-call client once it is read to the end, abandoned or broken.
async function* owned<T>(stream: AsyncIterable<T>, client: { destroy(): void }): AsyncGenerator<T> {
  try {
    yield* stream;
  } finally {
    client.destroy();
  }
}

export const bedrockAdapter = createBedrockAdapter({
  cache: inferenceCache(),
  async converseStream(input, o) {
    const client = new BedrockRuntimeClient({ region: o.region, credentials: creds(o.credentials), maxAttempts: 2 });
    let out;
    try {
      out = await client.send(new ConverseStreamCommand(input as unknown as ConverseStreamCommandInput), { abortSignal: o.signal });
    } catch (e) {
      client.destroy();
      throw e;
    }
    if (!out.stream) {
      client.destroy();
      return { requestId: out.$metadata.requestId };
    }
    return { stream: owned(out.stream as AsyncIterable<unknown>, client), requestId: out.$metadata.requestId };
  },
  async listModels(o) {
    const client = new BedrockClient({ region: o.region, credentials: creds(o.credentials), maxAttempts: 2 });
    const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]) : AbortSignal.timeout(LIST_TIMEOUT_MS);
    try {
      const fm = await client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }), { abortSignal: signal });
      const profiles: InferenceProfileSummary[] = [];
      try {
        let token: string | undefined;
        for (let page = 0; page < 10; page++) {
          const r = await client.send(new ListInferenceProfilesCommand({ maxResults: 1000, nextToken: token }), { abortSignal: signal });
          profiles.push(...(r.inferenceProfileSummaries ?? []));
          token = r.nextToken;
          if (!token) break;
        }
      } catch (e) {
        // Profiles are optional: credentials allowed to list models but not profiles still list the models.
        if ((e as Error)?.name !== "AccessDeniedException") throw e;
      }
      return { foundation: fm.modelSummaries ?? [], profiles };
    } finally {
      client.destroy();
    }
  },
  async assumeRole(o) {
    const client = new STSClient({ region: o.region, credentials: creds(o.source), maxAttempts: 2 });
    const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]) : AbortSignal.timeout(LIST_TIMEOUT_MS);
    try {
      const r = await client.send(new AssumeRoleCommand({ RoleArn: o.roleArn, RoleSessionName: "deployment-console-inference", DurationSeconds: 3600, ...(o.externalId ? { ExternalId: o.externalId } : {}) }), { abortSignal: signal });
      const c = r.Credentials;
      return { accessKeyId: c?.AccessKeyId ?? "", secretAccessKey: c?.SecretAccessKey ?? "", sessionToken: c?.SessionToken, expiresAt: c?.Expiration?.getTime() };
    } finally {
      client.destroy();
    }
  },
});
