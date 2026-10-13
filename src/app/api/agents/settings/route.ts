// The agents switch (master plan §3.5). GET (any signed-in person) → { enabled: { on, source }, stop, worker }. POST (admin)
// { enabled: boolean } → the same, plus `overridden: true` when CONSOLE_AGENTS is set (then the toggle has no effect
// until it is unset). Off: agent tokens and runs are refused (503) and the worker claims nothing.
// `worker` (an addition to §3.5) is this console's step worker: { started, draining, inflight, handlers }. It is started
// by instrumentation.ts after boot reconciliation, so `started: false` on a running console means it never came up.
import { HttpError } from "@/lib/server/errors";
import { handle, json, readJson, requirePerm } from "@/lib/server/http";
import { agentsEnabled, isEmergencyStopped, setAgentsEnabled } from "@/lib/server/agents/stop";
import { workerStatus } from "@/lib/server/agents/worker";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  personOf(req);
  const w = workerStatus(); // the worker's state lives on globalThis, so this route sees the instrumentation bundle's loop
  return json({ enabled: await agentsEnabled(), stop: await isEmergencyStopped(), worker: { started: w.started, draining: w.draining, inflight: w.inflight, handlers: w.handlers } });
});

export const POST = handle(async (req) => {
  const c = personOf(req);
  requirePerm(c.user, "admin");
  const b = await readJson(req);
  if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
  const r = await setAgentsEnabled(b.enabled, c.user.email, c.ip);
  return json({
    enabled: { on: r.on, source: r.source },
    stop: await isEmergencyStopped(),
    ...(r.overridden ? { overridden: true, note: "CONSOLE_AGENTS is set on this console, so it decides; the toggle applies once it is unset." } : {}),
  });
});
