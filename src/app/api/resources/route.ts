import { latestOverview } from "@/lib/server/console";
import { listEnvs } from "@/lib/server/discovery";
import { handle, json, userOf } from "@/lib/server/http";

// Every resource in every environment (name, kind, state) for the command palette — from the sampler, no AWS calls.
export const GET = handle(async (req) => {
  userOf(req);
  const envs = await listEnvs();
  return json(envs.flatMap((e) => {
    const o = latestOverview(e.id);
    return o ? [...o.services, ...o.infra].map((r) => ({ env: e.id, envLabel: e.label, key: r.key, id: r.id, kind: r.kind, name: r.name, subtitle: r.subtitle, state: r.state, logs: r.tabs.includes("logs") })) : [];
  }));
});
