import { uptime } from "@/lib/history";
import { hostIssues, latestOverview, samplerStatus } from "@/lib/server/console";
import { listEnvs } from "@/lib/server/discovery";
import { handle, json, userOf } from "@/lib/server/http";
import type { State } from "@/lib/types";

const PROBLEM = new Set<State>(["DOWN", "DEGRADED", "UNKNOWN"]);

// Everything down, degraded or unreadable in any environment, from the sampler's latest pass. An env the sampler hasn't
// read for three intervals is one UNKNOWN issue ("not sampled since …"), not its last known states (R21). Hosts launched
// for a cluster that never joined it are issues too (R23).
export const GET = handle(async (req) => {
  userOf(req);
  const envs = await listEnvs();
  const now = Date.now();
  const out = envs.flatMap((e) => {
    const s = samplerStatus(e.id, now);
    if (s.stale) return [{ env: e.id, envLabel: e.label, protected: e.protected, key: "env", kind: "env", name: e.label, state: "UNKNOWN" as State, reasons: [s.reason ?? "not sampled recently"], since: s.sampledAt }];
    const o = latestOverview(e.id);
    return o
      ? [...o.services, ...o.infra].filter((r) => PROBLEM.has(r.state)).map((r) => ({ env: e.id, envLabel: e.label, protected: e.protected, key: r.key, kind: r.kind, name: r.name, state: r.state, reasons: r.reasons, since: uptime(`${e.id}/${r.key}`).since }))
      : [];
  });
  for (const h of await hostIssues().catch(() => [])) {
    const e = envs.find((x) => x.id === h.env);
    if (e) out.push({ env: e.id, envLabel: e.label, protected: e.protected, key: `box:${h.id}`, kind: "box", name: h.id, state: "DEGRADED", reasons: [h.reason], since: h.at });
  }
  return json(out);
});
