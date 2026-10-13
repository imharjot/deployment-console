"use client";
// The agents' emergency stop (master plan §6 C8 item 7): while it is on, a banner on every Automation tab says so — who
// turned it on, when and why — and admins can lift it there. Admins turn it on from the page header, with a reason.
// While on, no agent can change anything (the registry answers 423 and the worker holds execute steps), whatever the
// policies say; reads and investigations go on.
import { OctagonX, Power } from "lucide-react";
import useSWR, { useSWRConfig } from "swr";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { Button, TimeAgo } from "@/components/ui";
import { postJson } from "@/lib/client/api";
import { stopBannerText } from "@/components/agents/rules";
import type { StopState } from "@/components/agents/types";

export const STOP_KEY = "/api/agents/emergency-stop";
const refreshSwitches = (k: unknown) => typeof k === "string" && (k.startsWith(STOP_KEY) || k.startsWith("/api/agents/settings"));

export function useStop() {
  return useSWR<StopState>(STOP_KEY, { refreshInterval: 15_000 });
}

export function useSetStop() {
  const ask = useConfirm();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  return (on: boolean) =>
    ask({
      env: "",
      title: on ? "Turn on the emergency stop?" : "Lift the emergency stop?",
      description: on
        ? "Every agent stops changing things at once — whatever its policy says. Changes waiting for approval stay waiting; changes already sent to AWS keep being checked. Reads and investigations go on. Everyone sees the banner and your reason."
        : "Agents may change things again, within their policies and approvals.",
      danger: on,
      expected: on ? "STOP" : "yes",
      needReason: on,
      confirmLabel: on ? "Stop all agents" : "Lift the stop",
      run: async ({ reason }) => {
        await postJson<StopState>(STOP_KEY, { on, reason });
        toast.push({ tone: "ok", title: on ? "Emergency stop on" : "Emergency stop lifted" });
        await mutate(refreshSwitches);
      },
    });
}

// Header button for admins: on when off, nothing when already on (the banner lifts it).
export function StopButton() {
  const { data } = useStop();
  const set = useSetStop();
  if (!data || data.on) return null;
  return (
    <Button variant="danger" onClick={() => set(true)} className="max-sm:flex-1">
      <OctagonX className="size-4" /> Emergency stop
    </Button>
  );
}

export function StopBanner({ admin }: { admin: boolean }) {
  const { data } = useStop();
  const set = useSetStop();
  const text = stopBannerText(data);
  if (!data?.on || !text) return null;
  return (
    <div role="alert" className="flex flex-wrap items-start gap-3 rounded-2xl border border-down/35 bg-down/8 px-4 py-3">
      <OctagonX className="mt-0.5 size-5 flex-none text-down" aria-hidden />
      <div className="min-w-0 flex-1 basis-64 text-[14px] leading-relaxed text-fg">
        <b className="font-semibold text-down">Emergency stop is on.</b> No agent can change anything until an admin lifts it; reads and investigations go on.
        <div className="mt-0.5 text-[13px] text-fg-2 [overflow-wrap:anywhere]">
          {data.by && <>Turned on by {data.by}</>}
          {data.at ? <> <TimeAgo at={data.at} /></> : null}
          {data.reason && <> · “{data.reason}”</>}
        </div>
      </div>
      {admin && (
        <Button variant="secondary" onClick={() => set(false)} className="max-sm:w-full">
          <Power className="size-4" /> Lift the stop
        </Button>
      )}
    </div>
  );
}
