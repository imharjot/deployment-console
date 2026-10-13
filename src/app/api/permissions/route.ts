import { combine } from "@/lib/capability-rules";
import { describeProvider, type PermissionsCatalog } from "@/lib/permissions";
import { capabilityView, refreshCapability, watchActions } from "@/lib/server/capability";
import { consoleConfig } from "@/lib/server/discovery";
import { handle, json, requirePerm, userOf } from "@/lib/server/http";
import { PROVIDERS } from "@/lib/server/providers";
import type { CapState } from "@/lib/types";

// What each cloud-map provider needs (IAM actions by class, Cloudflare token scopes), whether it's configured, what it
// discovers and which actions it offers — for Settings → AWS permissions. Plus, per provider, whether the console's AWS
// identity can run its actions (`writeCapability`: its declared write actions × GET /api/capability's states) and the
// console.config.json inventory.providers lists (the policy builder starts from them). Declarations, the simulation's
// verdicts and config only: no other AWS calls, no secrets.
interface WriteCapability {
  state: CapState; // the worst of its write actions
  allowed: number;
  total: number;
  missing: string[]; // denied or probably denied
}

export const GET = handle(async (req) => {
  requirePerm(userOf(req), "view");
  watchActions(PROVIDERS.flatMap((p) => [...(p.write ?? []), ...(p.actions ?? []).flatMap((a) => a.iam ?? [])]));
  await refreshCapability();
  const states = capabilityView().actions;
  const providers = PROVIDERS.map(describeProvider).sort((a, b) => a.label.localeCompare(b.label));
  const writeCapability: Record<string, WriteCapability> = {};
  for (const p of providers) {
    if (p.planned || !p.write.length) continue;
    const list = p.write.map((a) => [a, Object.hasOwn(states, a) ? states[a] : "unknown"] as const);
    writeCapability[p.id] = {
      state: combine(list.map(([, s]) => s)),
      allowed: list.filter(([, s]) => s === "allowed").length,
      total: list.length,
      missing: list.filter(([, s]) => s === "denied" || s === "probably-denied").map(([a]) => a),
    };
  }
  const cfg = consoleConfig().config.inventory?.providers;
  const body: PermissionsCatalog & { writeCapability: Record<string, WriteCapability>; inventoryProviders: { include?: string[]; exclude?: string[] } } = {
    providers,
    writeCapability,
    inventoryProviders: { ...(cfg?.include ? { include: [...cfg.include] } : {}), ...(cfg?.exclude?.length ? { exclude: [...cfg.exclude] } : {}) },
  };
  return json(body);
});
