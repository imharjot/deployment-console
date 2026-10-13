// Call one operation: { input, dryRun? } → { result } | { plan } | 202 { approval }. The name may be the operation
// name ("services.restart") or its tool name ("services_restart"). Everything is checked in invoke().
import { HttpError } from "@/lib/server/errors";
import { handle, json } from "@/lib/server/http";
import { invoke } from "@/lib/server/ops";
import { callerOf, readBody, withProblems } from "@/lib/server/ops/caller";

export const POST = handle<RouteContext<"/api/ops/[name]">>(async (req, ctx) =>
  withProblems(async () => {
    const c = callerOf(req);
    const { name } = await ctx.params;
    const b = await readBody(req);
    const extra = Object.keys(b).filter((k) => k !== "input" && k !== "dryRun");
    if (extra.length) throw new HttpError(400, `unknown field(s): ${extra.join(", ")} — the body is { "input": { … }, "dryRun": false }`);
    if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") throw new HttpError(400, "dryRun must be a boolean");
    const r = await invoke(name, b.input, c, { dryRun: b.dryRun === true });
    if (r.kind === "approval") return json({ approval: r.approval }, 202);
    if (r.kind === "plan") return json({ plan: r.plan });
    return json({ result: r.result });
  }),
);
