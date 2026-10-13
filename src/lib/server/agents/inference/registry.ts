// Which adapter serves a connection's provider (master plan §3.4). One adapter per provider and no fallback: a failing
// connection is never retried on another provider, connection, endpoint or model — that would change who pays and
// who sees the data. The runner pauses the run instead (recoveryFor: paused_auth / paused_budget, bounded retries).
//
// Runtime connections ("runtime:claude-code", "runtime:gemini-cli") are not inference adapters: the runner sends them to
// runtimeFor() (src/lib/server/agents/runtime/registry.ts). The ChatGPT-plan adapter (c-subscription-runtimes) is listed
// only with CONSOLE_CHATGPT_PLAN=eligible (it also refuses every call itself while the flag is off). Its module is
// imported either way: loading it registers the provider-side revoker, so disconnecting a plan connection created while
// the flag was on still signs the session out at OpenAI.
import "server-only";
import { isInferenceError, InferenceError, type GenerateRequest, type GenerateResult, type InferenceAdapter, type InferenceProvider, type ResolvedConnection } from "../../../agents/inference/types.ts";
import { cleanMessage, recoveryFor, toInferenceError, type InferenceRecovery } from "../../../agents/inference/errors.ts";
import { chatgptPlanAdapter, chatgptPlanOn } from "../chatgpt-plan.ts";
import { anthropicAdapter } from "./anthropic.ts";
import { bedrockAdapter } from "./bedrock.ts";
import { ollamaAdapter, openAiCompatibleAdapter } from "./openai-compatible.ts";
import { openAiAdapter } from "./openai.ts";
import { scriptedAdapter } from "./scripted.ts";

const ADAPTERS: Partial<Record<InferenceProvider, InferenceAdapter>> = {
  scripted: scriptedAdapter,
  anthropic: anthropicAdapter,
  openai: openAiAdapter,
  "openai-compatible": openAiCompatibleAdapter,
  ollama: ollamaAdapter,
  bedrock: bedrockAdapter,
  ...(chatgptPlanOn() ? { "chatgpt-plan": chatgptPlanAdapter } : {}),
};

export const inferenceProviders = (): InferenceProvider[] => Object.keys(ADAPTERS) as InferenceProvider[];

// The adapter for a provider; an unknown provider is refused ("unsupported"), never mapped to a similar one.
export function adapterFor(provider: string): InferenceAdapter {
  if (typeof provider === "string" && Object.hasOwn(ADAPTERS, provider)) return ADAPTERS[provider as InferenceProvider]!;
  throw new InferenceError("unsupported", `no inference adapter for provider "${cleanMessage(provider, 60)}"`, { code: "provider" });
}

// One model turn on exactly this connection. Whatever goes wrong comes back as an InferenceError (never a raw provider
// error), and the connection's provider is the only one ever called.
export async function generateWith(conn: ResolvedConnection, req: GenerateRequest): Promise<GenerateResult> {
  const adapter = adapterFor(conn.provider);
  try {
    return await adapter.generate(conn, req);
  } catch (e) {
    throw isInferenceError(e) ? e : toInferenceError(e, adapter.label, req.signal);
  }
}

// What the run does after a failed turn: pause (paused_auth / paused_budget) with the cause, retry the same request on
// the same connection after `afterMs`, fail, or follow its cancellation.
export function inferenceRecovery(e: unknown, attempt = 0, rand = 0): InferenceRecovery {
  return recoveryFor(e, attempt, rand);
}
