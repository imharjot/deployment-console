"use client";
// The Incident view (/incident, or the home page when chosen): the built-in Incident template, read-only for everyone —
// open issues, firing alarms, failing CI, deploys and rollbacks in the last 6 hours, a CPU chart for each unhealthy
// service (worked out live from /api/issues) and pending approvals. Each widget shows only what the viewer may see.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CopyPlus, House, Siren } from "lucide-react";
import { useMemo } from "react";
import { useSWRConfig } from "swr";
import { useToast } from "@/components/toast";
import { Button, Chip } from "@/components/ui";
import { incidentWidgets, unhealthyServices, type Dashboard, type IssueLike } from "@/lib/dashboards";
import { Page, PageHeader } from "@/app/_components/page-frame";
import { send, useApi, usePrefs, useRefresh } from "./data";
import { DashboardGrid } from "./grid";

export function IncidentView({ home }: { home?: boolean }) {
  const issues = useApi<IssueLike[]>("/api/issues", 15_000);
  const list = useMemo(() => (Array.isArray(issues.data) ? issues.data : []), [issues.data]);
  // Recompute the board only when the set of unhealthy services changes, not on every poll.
  const sig = unhealthyServices(list).map((i) => `${i.env}/${i.key}`).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the unhealthy set
  const widgets = useMemo(() => incidentWidgets(list), [sig]);
  const { prefs, set } = usePrefs();
  const isHome = prefs?.home === "incident";
  const toast = useToast();
  const router = useRouter();
  const refresh = useRefresh();
  const { mutate } = useSWRConfig();
  const unhealthy = sig ? sig.split(",").length : 0;

  const setHome = async () => {
    try {
      await set({ home: isHome ? null : "incident" });
      toast.push({ tone: "ok", title: isHome ? "Home page is the Overview again" : "The Incident view is your home page" }, 3000);
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't change your home page", body: (e as Error).message });
    }
  };
  const copy = async () => {
    try {
      const out = await send<{ dashboard: Dashboard }>("POST", "/api/dashboards", { name: "Incident", template: "incident", widgets });
      await Promise.all([refresh("/api/dashboards"), mutate("/api/dashboards")]);
      router.push(`/dashboards/${out.dashboard.id}`);
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't copy the board", body: (e as Error).message });
    }
  };

  return (
    <Page width="wide">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-3">
            <Siren className="size-7 flex-none text-down" strokeWidth={1.5} aria-hidden /> Incident view
          </span>
        }
        description={
          <>
            Everything you need while something is wrong, on one screen: open issues, firing alarms, failing CI, deploys and rollbacks in the last 6 hours, a
            chart for each unhealthy service and pending approvals. Read-only — every panel links to where you can act.
            {home && (
              <>
                {" "}
                <Link href="/?view=overview" className="text-accent hover:underline">Overview</Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {issues.data && (
              <Chip tone={list.length ? "bad" : "ok"} className="tabular-nums">
                {list.length ? `${list.length} open issue${list.length === 1 ? "" : "s"}` : "No open issues"}
                {unhealthy ? ` · ${unhealthy} unhealthy service${unhealthy === 1 ? "" : "s"}` : ""}
              </Chip>
            )}
            <Button variant={isHome ? "secondary" : "ghost"} aria-pressed={isHome} onClick={setHome} disabled={!prefs} title={isHome ? "Make the Overview your home page again" : "Open this view when you open the console"}>
              <House className="size-3.5" aria-hidden /> {isHome ? "Home page" : "Set as my home page"}
            </Button>
            <Button variant="ghost" onClick={copy} title="A dashboard of your own from this board, to change">
              <CopyPlus className="size-3.5" aria-hidden /> Copy to my dashboards
            </Button>
          </>
        }
      />
      <DashboardGrid widgets={widgets} />
    </Page>
  );
}
