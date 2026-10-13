"use client";
// The home page (/): the person's choice in /api/me/prefs — a dashboard ("dashboard:<id>"), the Incident view
// ("incident") or the Overview (the default). A skeleton shows until the preference arrives; anything that goes wrong
// (no prefs API, a dashboard deleted or no longer shared) falls back to the Overview.
//
// Links into the Overview always win: "/?r=<key>" (a resource panel — the palette, notifications, the issues list),
// "/?env=<id>" (an environment, e.g. an issues row for an env that isn't being sampled) and "/?view=overview" render
// it whatever the preference says, and it stays for the rest of the visit (closing the panel removes ?r= but must not
// swap the page under the person).
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Overview } from "@/components/overview/overview";
import { Skeleton } from "@/components/ui";
import { homeTarget, overviewLink } from "@/lib/dashboards";
import { Page } from "@/app/_components/page-frame";
import { DashboardSkeleton, DashboardView } from "./dashboard-view";
import { useApi, usePrefs } from "./data";
import { IncidentView } from "./incident-view";

export function HomeSkeleton() {
  return (
    <Page width="wide">
      <Skeleton className="h-10 w-56" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}
      </div>
    </Page>
  );
}

function HomeDashboard({ id }: { id: string }) {
  const r = useApi<unknown>(`/api/dashboards/${encodeURIComponent(id)}`, 60_000);
  const { set } = usePrefs();
  if (r.error && !r.data) {
    const status = (r.error as { status?: number }).status;
    return (
      <>
        <div className="mx-auto w-full max-w-[1400px] px-4 pt-4 sm:px-6">
          <div role="status" className="rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[13.5px] text-fg-2">
            {status === 404 || status === 403 ? "Your home dashboard was deleted or is no longer shared with you" : `Your home dashboard didn't load (${r.error.message})`} — showing the Overview.{" "}
            {status === 404 || status === 403 ? (
              <button type="button" onClick={() => set({ home: null }).catch(() => {})} className="text-accent hover:underline">Make the Overview my home page</button>
            ) : (
              <Link href={`/dashboards/${encodeURIComponent(id)}`} className="text-accent hover:underline">Open it</Link>
            )}
          </div>
        </div>
        <Overview />
      </>
    );
  }
  if (!r.data) return <DashboardSkeleton />;
  return <DashboardView id={id} home />;
}

export function Home() {
  const sp = useSearchParams();
  const wantsOverview = overviewLink(sp);
  const [stay, setStay] = useState(wantsOverview);
  if (wantsOverview && !stay) setStay(true);
  const { prefs, error } = usePrefs();
  if (stay) return <Overview />;
  if (!prefs) return error ? <Overview /> : <HomeSkeleton />;
  const t = homeTarget(prefs.home);
  if (t.kind === "incident") return <IncidentView home />;
  if (t.kind === "dashboard") return <HomeDashboard id={t.id} />;
  return <Overview />;
}
