// ALB health check. No dependency checks (a slow AWS/GitHub must never get the console killed), but configuration
// that makes every request fail or silently misbehave (see config-check.ts) fails the check, so a misconfigured
// deployment rolls back instead of going "healthy". In AWS mode, errors in console.config.json (or a file that failed
// closed, or a broken file whose last good version is in force) answer "degraded" with 200 (F05): the console works,
// someone should look. Reasons stay in the server log, not the reply.
// ?deep=1 adds when the background sampler last finished a pass (no environment data), for operators and monitors.
import { samplerHealth } from "@/lib/server/console";
import { degradedConfigProblem, fatalConfigProblem } from "@/lib/server/config-check";
import type { NextRequest } from "next/server";

export const GET = (req: NextRequest) => {
  const problem = fatalConfigProblem();
  if (problem) console.error(JSON.stringify({ level: 50, msg: "health check failed: misconfigured", err: problem }));
  const degraded = problem ? undefined : degradedConfigProblem();
  if (degraded) console.warn(JSON.stringify({ level: 40, msg: "health check degraded: config", err: degraded }));
  const headers = { "Cache-Control": "no-store" };
  if (req.nextUrl.searchParams.get("deep") === "1") {
    const s = samplerHealth();
    return Response.json(
      { ok: !problem, ...(degraded ? { degraded: ["config"] } : {}), sampler: { running: s.running, lastTickAt: s.lastTickAt ?? null, lastTickMs: s.lastTickMs ?? null } },
      { status: problem ? 500 : 200, headers },
    );
  }
  return new Response(problem ? "misconfigured" : degraded ? "degraded" : "ok", { status: problem ? 500 : 200, headers });
};
