// Turns console happenings into integration events: resource state transitions (from the sampler) and actions.
import "server-only";
import type { State } from "../types.ts";
import { onAction, onTransition } from "./console.ts";
import { consoleUrl, emit, serviceUrl } from "./events.ts";

const BAD = new Set<State>(["DOWN", "DEGRADED", "UNKNOWN"]);

export function startNotifications() {
  const g = globalThis as { __consoleNotify?: boolean };
  if (g.__consoleNotify) return;
  g.__consoleNotify = true;
  onTransition(({ env, r, previous }) => {
    // Deliberate states (stopped, deploying) aren't incidents; UNKNOWN only counts as recovered-from.
    const type = r.state === "DOWN" ? "service.down" : r.state === "DEGRADED" ? "service.degraded" : r.state === "UP" && BAD.has(previous) ? "service.recovered" : undefined;
    if (!type) return;
    emit({ type, at: Date.now(), url: consoleUrl(`/?env=${encodeURIComponent(env.id)}&r=${r.key}`), env: env.id, envLabel: env.label, protected: env.protected, key: r.key, name: r.name, state: r.state, previous, reasons: r.reasons });
  });
  onAction((a) => {
    emit({ type: "action", at: Date.now(), url: serviceUrl(a.env.id, a.target), env: a.env.id, envLabel: a.env.label, protected: a.env.protected, target: a.target, action: a.action, actor: a.user, reason: a.reason, result: a.result, detail: a.detail });
  });
}
