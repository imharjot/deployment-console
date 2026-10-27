// The credentials the console signs its AWS calls with, for one sign-in choice (src/lib/connection-rules.ts): the SDK's
// default chain (a task or instance role, AWS_PROFILE, keys in the environment), a named profile from ~/.aws (a
// profile named here wins over keys in the environment), or a role assumed from the default chain. Built once per
// connection generation (connection.ts) and for each connection test; the console stores no credentials.
// sts:AssumeRole is a permission of the identity the console runs as, not of the console's role, so this file is
// outside the IAM policy scan (src/lib/iam-policy.test.ts) like the agents' model adapters; docs/connect-aws.md says
// what to grant.
import "server-only";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { SignIn } from "../connection-rules.ts";
import { limitedClient } from "./aws-limiter.ts";
import { connectionState, perGeneration } from "./connection-state.ts";

export type CredentialsProvider = ReturnType<typeof defaultProvider>;
type Identity = Awaited<ReturnType<CredentialsProvider>>;

const REFRESH_BEFORE_MS = 5 * 60_000; // assume the role again this long before its session ends
const SESSION_S = 3600;

export function credentialsFor(signIn: SignIn, region: string): CredentialsProvider {
  if (signIn.kind === "profile") return defaultProvider({ profile: signIn.profile });
  const base = defaultProvider();
  if (signIn.kind === "chain") return base;
  const sts = limitedClient(new STSClient({ region, credentials: base, maxAttempts: 2 }), "sts", region);
  let held: Identity | undefined;
  let pending: Promise<Identity> | undefined;
  const assume = async (): Promise<Identity> => {
    const r = await sts.send(
      new AssumeRoleCommand({ RoleArn: signIn.roleArn, RoleSessionName: "deployment-console", DurationSeconds: SESSION_S, ...(signIn.externalId ? { ExternalId: signIn.externalId } : {}) }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );
    const c = r.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error(`sts:AssumeRole on ${signIn.roleArn} returned no credentials`);
    return (held = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration });
  };
  // The SDK asks again shortly before `expiration`; concurrent asks share one AssumeRole.
  return async () => {
    if (held?.expiration && held.expiration.getTime() - Date.now() > REFRESH_BEFORE_MS) return held;
    pending ??= assume().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

// The current connection's credentials, as one function every client config can hold (sdkConfig, aws.ts cfg): the
// SDK keeps an identity per client and every client is rebuilt per generation, so each generation's clients ask this
// generation's provider. Before the connection is loaded, the SDK's default chain (AWS_PROFILE included), as ever.
// With the simulated account, none: work still running from an AWS connection must not sign real calls with whatever
// credentials the machine has.
const simulated: CredentialsProvider = async () => {
  throw Object.assign(new Error("the console reads the simulated account and signs no AWS calls"), { name: "CredentialsProviderError" });
};
const active = perGeneration((): CredentialsProvider => {
  const c = connectionState().effective;
  return !c ? defaultProvider() : c.source === "aws" ? credentialsFor(c.signIn, c.home) : simulated;
});
export const connectionCredentials: CredentialsProvider = (...args) => active()(...args);
