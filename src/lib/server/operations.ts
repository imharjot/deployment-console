// Operation records: one row per change that reached its audit intent (src/lib/mutation-core.ts writes them).
// Readers get the safe fields only (OperationView: never params, hashes or results), which is what an agent may see
// when it checks what happened to a change it asked for — including outcome_unknown.
import "server-only";
import type { OperationView } from "../types.ts";
import { coordinator } from "./mutations.ts";

export async function getOperation(id: string): Promise<OperationView | undefined> {
  return coordinator.getOperation(id);
}

export async function listOperations(f: { state?: string; runId?: string; limit?: number }): Promise<OperationView[]> {
  return coordinator.listOperations(f);
}

// At boot and then every minute (src/instrumentation.ts): operations a stopped console left running → outcome_unknown,
// audited "unknown" ("console restarted while this was in flight — check the resource before retrying"), their leases
// released. A console still alive next to this one (an ECS rolling upgrade) keeps its work. Returns how many were marked.
export async function reconcileOnBoot(): Promise<number> {
  return coordinator.reconcile();
}

// "AWS accepted" → verified healthy (or not): the sampler or a verify step records whether the change took effect.
export async function markVerified(id: string, ok: boolean, detail?: string): Promise<void> {
  return coordinator.markVerified(id, ok, detail);
}
