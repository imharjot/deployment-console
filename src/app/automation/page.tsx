"use client";
// Automation: where people meet the agents that use the console (AGENT_ARCHITECTURE §10). Approvals (changes agents
// asked for), Runs (what agents did, live), Workflows and Agents (templates, drafts, previews, versions, the agents
// switch), Connections (model access and who pays), Connect (an MCP client such as Claude Code or Gemini CLI), API
// tokens and the operations catalog. The tab lives in the URL hash so links such as /automation#tokens or
// /automation#runs/<id> work; with no hash it opens Approvals when something waits for a decision, else Runs. The
// emergency stop shows on every tab while it is on; approvals refresh live from the event stream.
import { BookOpen } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Swap } from "@/components/motion";
import { useToast } from "@/components/toast";
import { Chip, Empty, Skeleton, Tabs } from "@/components/ui";
import { useMe } from "@/components/user-menu";
import { parseAutomationHash, type AutomationTab } from "@/components/agents/rules";
import { Page, PageHeader } from "../_components/page-frame";
import { AgentsTab } from "./agents-tab";
import { ApprovalsTab, refreshApprovals } from "./approvals-tab";
import { ConnectTab } from "./connect-tab";
import { ConnectionsTab } from "./connections-tab";
import { OperationsTab } from "./operations-tab";
import { RunsTab } from "./runs-tab";
import { StopBanner, StopButton } from "./stop-banner";
import { TokensTab } from "./tokens-tab";
import { WorkflowsTab } from "./workflows-tab";

// Every same-document URL change: hashchange (a typed hash, a plain #link), popstate (back / forward) and, where the
// Navigation API exists, pushState / replaceState too. Next's router moves between /automation#a and /automation#b
// (or back to plain /automation from the sidebar) with pushState, which fires neither of the other two. It does so
// inside a React insertion effect, where scheduling an update is not allowed, hence the microtask.
const subscribeHash = (cb: () => void) => {
  const nav = (window as Window & { navigation?: EventTarget }).navigation;
  const later = () => queueMicrotask(cb);
  window.addEventListener("hashchange", cb);
  window.addEventListener("popstate", cb);
  nav?.addEventListener("currententrychange", later);
  return () => {
    window.removeEventListener("hashchange", cb);
    window.removeEventListener("popstate", cb);
    nav?.removeEventListener("currententrychange", later);
  };
};
const readHash = () => window.location.hash;

// Approval events → refresh every approvals list (and the nav badge). EventSource reconnects by itself.
function useLiveApprovals() {
  const { mutate } = useSWRConfig();
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/events");
    const on = () => void mutate(refreshApprovals);
    // Agent runs, their states and the emergency stop change with the same stream.
    const runs = () => void mutate((k) => typeof k === "string" && (k.startsWith("/api/agents/runs") || k.startsWith("/api/agents/metrics") || k.startsWith("/api/agents/emergency-stop") || k.startsWith("/api/agents/settings")));
    es.addEventListener("approval", on);
    es.addEventListener("run", runs);
    es.addEventListener("action", runs);
    return () => {
      es.removeEventListener("approval", on);
      es.removeEventListener("run", runs);
      es.removeEventListener("action", runs);
      es.close();
    };
  }, [mutate]);
}

// The ChatGPT sign-in comes back to /automation?chatgpt=<code>#connections: say how it went, once.
const CHATGPT_RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "ChatGPT plan connected." },
  reconnected: { ok: true, text: "Signed in to ChatGPT again." },
  loopback: { ok: false, text: "Open the console at http://127.0.0.1:<port> to sign in with ChatGPT (OpenAI only allows a loopback redirect)." },
  denied: { ok: false, text: "The sign-in was cancelled or refused." },
  account: { ok: false, text: "That ChatGPT account isn't the one this connection belongs to." },
  scope: { ok: false, text: "The sign-in didn't grant plan usage for this app." },
  revoked: { ok: false, text: "The plan session was revoked. Sign in again." },
  temporary: { ok: false, text: "OpenAI is unavailable right now. Try again in a minute." },
};
function useChatgptResult() {
  const toast = useToast();
  useEffect(() => {
    const u = new URL(window.location.href);
    const code = u.searchParams.get("chatgpt");
    if (!code) return;
    const r = CHATGPT_RESULT[code] ?? { ok: false, text: `Sign in with ChatGPT failed (${code.replace(/[^a-z_]/g, "").slice(0, 30)}).` };
    toast.push({ tone: r.ok ? "ok" : "error", title: r.ok ? "ChatGPT" : "ChatGPT sign-in", body: r.text }, r.ok ? undefined : 10_000);
    u.searchParams.delete("chatgpt");
    history.replaceState(null, "", u.pathname + (u.search === "?" ? "" : u.search) + u.hash);
  }, [toast]);
}

export default function AutomationPage() {
  const hash = useSyncExternalStore(subscribeHash, readHash, () => "");
  const [, force] = useState(0);
  const { data: me, error } = useMe();
  const pendingQ = useSWR<{ pending: number }>("/api/approvals?count=pending", { refreshInterval: 30_000 });
  const pending = pendingQ.data?.pending ?? 0;
  useLiveApprovals();
  useChatgptResult();
  // No hash: wait for the pending count before choosing between Approvals and Runs, so the page doesn't jump.
  const deciding = !hash && !pendingQ.data && !pendingQ.error;
  const { tab, runId, workflowId } = parseAutomationHash(hash, pending);
  const admin = !!me?.perms.includes("admin");

  const select = (t: AutomationTab) => {
    history.replaceState(null, "", `#${t}`); // no new history entry, no scroll
    force((n) => n + 1); // browsers without the Navigation API get no event for replaceState
  };

  return (
    <Page>
      <PageHeader
        title="Automation"
        description="Agents use the console through its operations API and MCP — as a delegate of one person, never with more access than that person, inside a policy you can read. Changes they ask for wait here for a person; every run shows who asked, who pays and what really happened."
        actions={
          <>
            {admin && <StopButton />}
            <Link href="/docs/automation" className="press inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-panel px-3.5 text-[14px] font-medium text-fg shadow-card hover:border-line-strong hover:bg-panel-2 max-sm:flex-1 max-sm:justify-center pointer-coarse:h-10">
              <BookOpen className="size-4" /> Agents &amp; API docs
            </Link>
          </>
        }
      />
      <StopBanner admin={admin} />
      <Tabs
        id="automation"
        value={tab}
        onChange={select}
        tabs={[
          { value: "approvals", label: "Approvals", badge: pending > 0 ? <Chip tone="accent" className="tabular-nums">{pending}</Chip> : undefined },
          { value: "runs", label: "Runs" },
          { value: "workflows", label: "Workflows" },
          { value: "agents", label: "Agents" },
          { value: "connections", label: "Connections" },
          { value: "connect", label: "Connect your agent" },
          { value: "tokens", label: "API tokens" },
          { value: "operations", label: "Operations" },
        ]}
      />
      <Swap id={deciding ? "deciding" : tab}>
        {deciding ? (
          <Skeleton className="h-64 rounded-2xl" />
        ) : tab === "approvals" ? (
          <ApprovalsTab />
        ) : tab === "runs" ? (
          <RunsTab runId={runId} admin={admin} />
        ) : tab === "operations" ? (
          <OperationsTab />
        ) : error ? (
          <Empty title="Couldn't load your account" hint={(error as Error).message} />
        ) : !me ? (
          <Skeleton className="h-64 rounded-2xl" />
        ) : tab === "workflows" ? (
          <WorkflowsTab me={me} workflowId={workflowId} />
        ) : tab === "agents" ? (
          <AgentsTab me={me} />
        ) : tab === "connections" ? (
          <ConnectionsTab me={me} />
        ) : tab === "connect" ? (
          <ConnectTab me={me} />
        ) : (
          <TokensTab me={me} />
        )}
      </Swap>
    </Page>
  );
}
