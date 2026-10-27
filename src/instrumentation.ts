// Starts the background state sampler once per server process (uptime history must not depend on who has the page open),
// and the agent platform's worker (durable runs; it claims steps only while agents are on).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // The AWS connection Settings saved (environment variables that are set still decide their part), before anything
    // reads AWS; then whose data the console holds, forgetting a previous account's (src/lib/server/connection.ts).
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      const c = await import("./lib/server/connection");
      // A database that isn't up yet (Postgres starting next to the console) gets 20 s. After that the connection stays
      // unknown (pages answer 503) until the sampler can read it: never the simulated account in its place.
      for (let attempt = 1; ; attempt++) {
        try {
          await c.loadConnection();
          break;
        } catch (e) {
          if (attempt === 10) {
            c.markConnectionUnknown();
            console.error(`[deployment-console] AWS connection unknown, the console database is unavailable: ${(e as Error).message}`);
            break;
          }
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
      await Promise.race([c.ensureScope().catch(() => {}), new Promise((r) => setTimeout(r, 8_000).unref?.())]); // the sampler retries until AWS answers
    }
    await import("./lib/server/capability"); // registers the AWS-call observer: refusals and successes of console writes
    const { startSampler } = await import("./lib/server/console");
    (await import("./lib/server/notify")).startNotifications(); // state changes + actions → Slack/webhook integrations
    startSampler();
    (await import("./lib/server/events")).startCiWatcher(); // ci.failed notifications; no-ops during next build
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      // First run: create CONSOLE_ADMIN_EMAIL or print the setup token at boot (retried lazily on first request if the DB is down).
      (await import("./lib/server/auth/bootstrap")).ensureBootstrap().catch((e) => console.error(`[deployment-console] auth bootstrap: ${(e as Error).message}`));
      // Changes a stopped console left in flight can't finish: mark them outcome_unknown and free their resources. At
      // boot, then every minute — a console that was still running next to this one (rolling upgrade) and then crashed
      // is only given up on once its liveness row lapses (src/lib/mutation-core.ts).
      const { reconcileOnBoot } = await import("./lib/server/operations");
      const reconcile = () =>
        reconcileOnBoot()
          .then((n) => n && console.warn(`[deployment-console] ${n} operation(s) were in flight when a console stopped — marked outcome unknown; check those resources`))
          .catch((e) => console.error(`[deployment-console] reconciliation: ${(e as Error).message}`));
      const g = globalThis as { __consoleSignals?: boolean; __consoleReconciler?: ReturnType<typeof setInterval> };
      // Agents: the persisted event stream's feed, then the worker — after the coordinator's own reconciliation, so a
      // lapsed execute step finds its operation already settled (src/lib/server/agents/reconcile.ts runs in its loop).
      // The worker starts in both modes; it claims steps only while agents are on (src/lib/server/agents/stop.ts).
      (await import("./lib/server/agents/event-bridge")).startEventBridge();
      const booted = reconcile();
      void booted
        .then(async () => {
          await (await import("./lib/server/agents/reconcile")).reconcileAgents().catch((e) => console.error(`[deployment-console] agent reconciliation: ${(e as Error).message}`));
          await (await import("./lib/server/agents/worker")).startWorker();
        })
        .catch((e) => console.error(`[deployment-console] agent worker: ${(e as Error).message}`));
      g.__consoleReconciler ??= setInterval(() => void reconcile(), 60_000);
      g.__consoleReconciler.unref?.();
      // Graceful stop (F67): with NEXT_MANUAL_SIG_HANDLE=true Next leaves SIGTERM/SIGINT to us — refuse new changes,
      // let the ones in flight finish (up to 25 s, inside ECS's 30 s stop timeout), then exit.
      if (process.env.NEXT_MANUAL_SIG_HANDLE === "true" && !g.__consoleSignals) {
        g.__consoleSignals = true;
        const { drain } = await import("./lib/server/mutations");
        const { drainWorker } = await import("./lib/server/agents/worker");
        const stop = (signal: string) => {
          console.warn(`[deployment-console] ${signal}: draining in-flight changes`);
          // The agent worker stops claiming at the same time: it interrupts model, tool and verify steps at once and
          // gives execute steps 20 s to record their change; whatever it leaves behind is settled by reconciliation.
          Promise.all([drainWorker(20_000).catch(() => {}), drain(25_000)])
            .catch((e) => console.error(`[deployment-console] drain: ${(e as Error).message}`))
            .finally(() => process.exit(0));
        };
        process.once("SIGTERM", () => stop("SIGTERM"));
        process.once("SIGINT", () => stop("SIGINT"));
      }
    }
  }
}
