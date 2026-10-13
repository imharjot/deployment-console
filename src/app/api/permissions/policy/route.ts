import { baseStatements, buildPolicy, declarationOf, forRegions, type PolicyDocument, type PolicyResponse } from "@/lib/permissions";
import { consoleConfig } from "@/lib/server/discovery";
import { HttpError } from "@/lib/server/errors";
import { handle, json, requirePerm, userOf } from "@/lib/server/http";
import { PROVIDERS } from "@/lib/server/providers";
import { consoleRegions } from "@/lib/server/regions";
import full from "../../../../../infra/iam-policy.json";
import readonly from "../../../../../infra/iam-policy-readonly.json";

// The IAM policy for a mode and a set of providers: the shipped file's hand-written statements (bundled, so standalone
// builds have them) plus statements generated from the providers' declarations — the same rules as
// `npm run iam:policy` (src/lib/permissions.ts). Placeholders (REGION, ACCOUNT_ID…) are left for the page to fill —
// except that a console reading more than one region (or all enabled ones) gets REGION as "*" (forRegions), so its
// kms:ViaService conditions and its own ARNs hold outside the home region.
//   GET /api/permissions/policy?mode=read|full&providers=lambda,sqs   (empty = none)
// Without `providers`: the providers this console runs — console.config.json inventory.providers (include / exclude)
// when set, else all; `configured: true` says the config chose.
const BASE: Record<"read" | "full", PolicyDocument> = { read: readonly as PolicyDocument, full: full as PolicyDocument };

export const GET = handle(async (req) => {
  requirePerm(userOf(req), "view");
  const q = req.nextUrl.searchParams;
  const mode = q.get("mode") ?? "read";
  if (mode !== "read" && mode !== "full") throw new HttpError(400, "mode must be read or full");
  const raw = q.get("providers");
  const ids = raw === null ? null : raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids && (ids.length > 200 || ids.some((id) => !/^[a-z0-9-]{1,64}$/.test(id)))) throw new HttpError(400, "providers must be a comma-separated list of provider ids");
  const decls = PROVIDERS.map(declarationOf);
  const cfg = consoleConfig().config.inventory?.providers;
  const configured = ids === null && !!(cfg?.include || cfg?.exclude?.length);
  const runs = (id: string) => !cfg?.exclude?.includes(id) && (!cfg?.include || cfg.include.includes(id));
  const chosen = ids ? decls.filter((d) => ids.includes(d.id)) : configured ? decls.filter((d) => runs(d.id)) : decls;
  const built = buildPolicy(chosen, mode, baseStatements(BASE[mode]));
  const r = await consoleRegions();
  const policy = forRegions(built.policy, r.allEnabled ? [r.home, "*"] : r.regions);
  const skipped = built.skipped;
  const body: PolicyResponse & { configured?: true } = {
    mode,
    providers: chosen.map((d) => d.id).sort(),
    unknown: (ids ?? []).filter((id) => !decls.some((d) => d.id === id)),
    policy,
    skipped,
    ...(configured ? { configured: true as const } : {}),
  };
  return json(body);
});
