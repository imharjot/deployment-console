"use client";
// The buttons under a change the assistant proposed (the <PlanCard> footer in the drawer): "Review in Approvals" always,
// and approve / reject right here when this person may decide it (the approval's own `canDecide`, from
// GET /api/approvals/[id] — the same rules as the Approvals tab: role, protection, four-eyes). Approving binds the exact
// plan: the agent's run executes it as the agent, never as the approver, and a plan that changed in the meantime is
// refused (409) and has to be proposed again.
import { Check, UserCheck, X } from "lucide-react";
import Link from "next/link";
import useSWR, { useSWRConfig } from "swr";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";
import { Button } from "../ui";
import { getJson, postJson } from "@/lib/client/api";
import { useEnvInfo } from "@/lib/client/env";
import type { ApprovalView } from "@/lib/server/ops";

interface ProposalLike {
  grantId: string;
  approvalId: string | null;
  state: string;
  op: string;
  plan?: { summary?: string; warnings?: string[] } | null;
}

const approvalKey = (id: string) => ["assistant-approval", `/api/approvals/${encodeURIComponent(id)}`] as const;
const fetchApproval = async ([, url]: readonly [string, string]) => (await getJson<{ approval?: ApprovalView }>(url)).approval;

export function ProposalDecision({ proposal, runId }: { proposal: ProposalLike; runId: string }) {
  const pending = proposal.state === "pending";
  const id = proposal.approvalId && /^[A-Za-z0-9_-]{1,100}$/.test(proposal.approvalId) ? proposal.approvalId : undefined;
  const { data: a } = useSWR(pending && id ? approvalKey(id) : null, fetchApproval, { refreshInterval: 30_000 });
  const ask = useConfirm();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const envLabel = useEnvInfo(a?.env ?? "")?.label ?? a?.env ?? undefined;
  // The run (the Automation UI's RunView reads it under its plain URL), this request, and every approvals list.
  const refresh = () =>
    mutate((k) => {
      const url = Array.isArray(k) ? k[1] : k;
      return typeof url === "string" && (url === `/api/agents/runs/${encodeURIComponent(runId)}` || url.startsWith("/api/approvals"));
    });
  const summary = a?.plan?.summary ?? proposal.plan?.summary ?? proposal.op;
  const review = (
    <Link
      href="/automation#approvals"
      className="press inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13.5px] font-medium text-fg-2 hover:bg-panel-3 hover:text-fg pointer-coarse:h-10"
    >
      <UserCheck className="size-3.5" aria-hidden /> Review in Approvals
    </Link>
  );
  if (!pending) return null;
  if (!id || !a || a.status !== "pending" || !a.canDecide) return review;

  const approve = () =>
    ask({
      env: a.env ?? "",
      protectedEnv: a.protected,
      envLabel,
      title: `Approve: ${summary}?`,
      description: (
        <>
          The assistant&apos;s run executes <b className="font-medium text-fg">exactly this plan</b>, as the agent — not as you — and then checks whether it
          worked. If anything in the plan changes before it runs, the approval is refused and the assistant has to ask again. The audit log records you
          approving it.
        </>
      ),
      warnings: a.plan?.warnings,
      danger: a.risk === "danger",
      expected: a.confirm,
      needReason: a.needsReason,
      confirmLabel: "Approve",
      run: async ({ confirm, reason }) => {
        await postJson(`/api/approvals/${encodeURIComponent(id)}`, { decision: "approve", confirm, reason });
        toast.push({ tone: "ok", title: "Approved", body: "The run executes the plan and reports whether the service becomes healthy." });
        await refresh();
      },
    });

  const reject = () =>
    ask({
      env: a.env ?? "",
      title: "Reject this proposal?",
      description: <>Nothing runs. The assistant can read your reason.</>,
      danger: true,
      expected: "yes",
      needReason: true,
      confirmLabel: "Reject",
      run: async ({ reason }) => {
        await postJson(`/api/approvals/${encodeURIComponent(id)}`, { decision: "reject", reason });
        toast.push({ tone: "ok", title: "Proposal rejected" });
        await refresh();
      },
    });

  return (
    <>
      {review}
      <Button size="sm" onClick={reject} className="max-sm:h-10 max-sm:flex-1">
        <X className="size-3.5" /> Reject
      </Button>
      <Button size="sm" variant={a.risk === "danger" ? "danger" : "primary"} onClick={approve} className="max-sm:h-10 max-sm:flex-1">
        <Check className="size-3.5" /> Approve
      </Button>
    </>
  );
}
