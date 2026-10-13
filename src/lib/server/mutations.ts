// The mutation coordinator on the console DB: every change to AWS, an integration or the console's own guarded state
// goes through mutate() (see src/lib/mutation-core.ts for the protocol). Canonical keys: src/lib/mutation-keys.ts.
//
//   const { result } = await mutate({ action: "services.restart", actor, env, target: service,
//       keys: [canonicalKey({ ecsService: { region: env.region, cluster: env.cluster, service } })], params, reason },
//     async (h) => {
//       const live = await cloud.service(...);            // read state under the lock
//       await h.intent({ from: live.taskDefinition });    // commit operation + audit intent, or refuse
//       const id = await cloud.updateService(...);        // only now touch AWS
//       h.requestId(id);
//       return { requestId: id };
//     });
//
// Errors: 409 busy (names the action and actor holding the resource), 503 audit unavailable or draining,
// 502 failed, 502 outcome unknown ("outcome unknown — check the resource before retrying"), 500 agent_bypass (a change
// inside an agent's call that isn't running in that agent's own mutation context — see agentGuard). All state is on
// globalThis.__consoleMutations, so routes and the instrumentation bundle contend on the same keys.
import "server-only";
import { createMutations, type MutationContext, type MutationEvent, type MutationHandle, type MutationResult, type MutationSpec } from "../mutation-core.ts";
import { currentAgentContext } from "./agents/principals.ts";
import { writeAudit } from "./audit.ts";
import { getDb } from "./db.ts";
import { HttpError, isOutcomeUnknown } from "./errors.ts";

export type { MutationActor, MutationContext, MutationEvent, MutationHandle, MutationResult, MutationSpec } from "../mutation-core.ts";
export { MutationError } from "../mutation-core.ts";

export const coordinator = createMutations({
  db: getDb,
  audit: (e, db) => writeAudit(e, db),
  outcomeUnknown: isOutcomeUnknown,
  guard: agentGuard,
});

// Defence in depth (AGENT_ARCHITECTURE §3): inside an agent's call, a change runs only in that agent's own mutation
// context — the one invoke() sets for it. Agent code that skips invoke() and calls an operation or the cloud directly
// is refused here too, not only at the registry.
function agentGuard(ctx: MutationContext | undefined): void {
  const agent = currentAgentContext();
  if (agent && (ctx?.kind !== "agent" || ctx.runId !== agent.runId))
    throw Object.assign(new HttpError(500, "agent runs must change resources through invoke() as the agent"), { code: "agent_bypass" });
}

export async function mutate<T>(spec: MutationSpec, body: (h: MutationHandle) => Promise<T>): Promise<MutationResult<T>> {
  return coordinator.mutate(spec, body);
}

// Listeners never throw (a throwing listener is ignored); the return value unsubscribes.
export function onMutation(f: (e: MutationEvent) => void): () => void {
  return coordinator.onMutation(f);
}

// Run ids, step, grant, approval, token, idempotency key and plan hash that every mutate() inside fn inherits.
export function runWithMutationContext<T>(ctx: MutationContext, fn: () => Promise<T>): Promise<T> {
  return coordinator.runWithMutationContext(ctx, fn);
}

// SIGTERM: refuse new changes (503) and wait up to timeoutMs for the ones in flight.
export async function drain(timeoutMs: number): Promise<void> {
  return coordinator.drain(timeoutMs);
}

export function isDraining(): boolean {
  return coordinator.isDraining();
}
