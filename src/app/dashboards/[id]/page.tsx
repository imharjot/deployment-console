"use client";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { DashboardSkeleton, DashboardView } from "@/components/dashboards/dashboard-view";

// One dashboard (?edit=1 opens it in edit mode — a new blank one does). See docs/dashboards.md.
function Body() {
  const { id } = useParams<{ id: string }>();
  const edit = useSearchParams().get("edit") === "1";
  return <DashboardView key={id} id={id} startEditing={edit} />;
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <Body />
    </Suspense>
  );
}
