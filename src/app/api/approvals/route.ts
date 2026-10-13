// Approval requests. People see all of them; an API token sees only its own, an agent token its own run's.
// ?count=pending → { pending: n }.
import type { ApprovalStatus } from "@/lib/automation";
import { HttpError } from "@/lib/server/errors";
import { handle, json } from "@/lib/server/http";
import { listApprovalViews, pendingCount } from "@/lib/server/ops";
import { agentCallerOf } from "@/lib/server/ops/caller";

const STATUSES = ["pending", "approved", "rejected", "expired", "done", "failed", "all"];

export const GET = handle(async (req) => {
  const c = await agentCallerOf(req);
  const q = req.nextUrl.searchParams;
  if (q.get("count") === "pending") return json({ pending: await pendingCount(c) });
  const status = q.get("status") ?? "all";
  if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
  const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200);
  return json({ approvals: await listApprovalViews(c, { status: status as ApprovalStatus | "all", limit }) });
});
