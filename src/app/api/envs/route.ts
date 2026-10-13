import { latestOverview, samplerStatus, worstState } from "@/lib/server/console";
import { listEnvs } from "@/lib/server/discovery";
import { handle, json, userOf } from "@/lib/server/http";

// Discovered environments, each with its worst current state from the background sampler (no extra AWS calls). An env
// the sampler hasn't read for three intervals is stale: worst UNKNOWN with the reason, never its last good state (R21).
export const GET = handle(async (req) => {
  userOf(req);
  const envs = await listEnvs();
  const now = Date.now();
  return json(envs.map((e) => {
    const o = latestOverview(e.id);
    const s = samplerStatus(e.id, now);
    return {
      ...e,
      worst: s.stale ? "UNKNOWN" : o ? worstState(o) : undefined,
      summary: o?.summary,
      sampledAt: s.sampledAt,
      stale: s.stale,
      ...(s.reason ? { staleReason: s.reason } : {}),
    };
  }));
});
