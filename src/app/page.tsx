import { Suspense } from "react";
import { Home, HomeSkeleton } from "@/components/dashboards/home";

// The home page: the Overview, or the dashboard / Incident view the person chose (docs/dashboards.md).
export default function Page() {
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <Home />
    </Suspense>
  );
}
