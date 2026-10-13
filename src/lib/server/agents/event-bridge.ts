// Feeds the persisted event stream (./events.ts) from the console's in-process listeners, once per process: resource
// state transitions from the sampler (`state`), finished actions (`action`, every mutate() caller) and operations
// (`operation`, with the agent run that made them). Approvals publish themselves (ops/approvals.ts publishApproval,
// agents/grants.ts). Started by instrumentation.ts and, in case a route bundle runs first, by the events route; the
// flag lives on globalThis so it registers once whichever bundle gets there first. Payloads keep the shapes the
// stream always sent, so existing clients see no change.
import "server-only";
import { onAction, onTransition } from "../console.ts";
import { onMutation } from "../mutations.ts";
import { publishSafe } from "./events.ts";

const g = globalThis as { __consoleEventBridge?: boolean };

export function startEventBridge(): void {
  if (g.__consoleEventBridge) return;
  g.__consoleEventBridge = true;
  onTransition(({ env, r, previous }) =>
    publishSafe("state", { env: env.id, key: r.key, kind: r.kind, name: r.name, state: r.state, previous, reasons: r.reasons.slice(0, 5), at: Date.now() }, { topic: env.id }),
  );
  onAction((a) =>
    publishSafe("action", { env: a.env.id, target: a.target, action: a.action, user: a.user, result: a.result, reason: a.reason, detail: a.detail?.slice(0, 300), at: Date.now() }, { topic: a.env.id }),
  );
  onMutation((e) =>
    publishSafe(
      "operation",
      { id: e.operationId, action: e.action, target: e.target, env: e.env?.id, state: e.state, actor: e.actor.display, actorKind: e.actor.kind, detail: e.detail?.slice(0, 300), at: e.at },
      { runId: e.actor.runId ?? null, topic: e.env?.id },
    ),
  );
}
