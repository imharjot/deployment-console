"use client";
// The card every widget sits in: an icon and title, an "open" link, its own freshness line (R21, from the widget's own
// data) and — in edit mode — the toolbar the grid passes down. Each widget also has its own error boundary, so one
// broken widget never takes the dashboard down, and it can still be removed.
import Link from "next/link";
import { ArrowUpRight, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import { Component, createContext, useContext, type ComponentType, type ReactNode } from "react";
import { FreshnessBanner } from "@/components/freshness-banner";
import { Skeleton, cx } from "@/components/ui";
import type { RegionFilter } from "@/lib/client/region";
import { WIDGETS, neededRole, type Widget } from "@/lib/dashboards";
import type { Freshness } from "@/lib/freshness";

export interface FrameInfo {
  widget: Widget;
  region: RegionFilter; // the global region filter
  toolbar?: ReactNode; // edit mode: move, resize, configure, remove
}

export const FrameCtx = createContext<FrameInfo | null>(null);
export const useFrame = () => useContext(FrameCtx)!;

type Icon = ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;

export function Frame({ icon: I, title, href, hrefLabel = "Open", freshness, onRetry, extra, children, bodyClassName }: {
  icon: Icon;
  title?: string;
  href?: string;
  hrefLabel?: string;
  freshness?: Freshness;
  onRetry?: () => void;
  extra?: ReactNode; // small header content (a count)
  children: ReactNode;
  bodyClassName?: string;
}) {
  const { widget, toolbar } = useFrame();
  const name = widget.title ?? title ?? WIDGETS[widget.type].label;
  return (
    <section aria-label={name} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
      {toolbar}
      <header className="flex min-w-0 flex-none items-center gap-2 px-3.5 pb-1.5 pt-3">
        <I className="size-3.5 flex-none text-fg-3" strokeWidth={1.75} aria-hidden />
        <h3 className="min-w-0 truncate text-[14px] font-medium tracking-[-0.005em]" title={name}>{name}</h3>
        {extra}
        {href && (
          <Link href={href} title={hrefLabel} aria-label={`${hrefLabel}: ${name}`} className="press -my-1 ml-auto grid size-7 flex-none place-items-center rounded-md text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:size-10">
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </header>
      {freshness && (
        <div className="flex min-w-0 flex-none items-center gap-1.5 px-3.5 pb-1">
          <FreshnessBanner f={freshness} compact />
          {onRetry && freshness.error && (
            <button type="button" onClick={onRetry} className="press -my-1 inline-flex flex-none items-center rounded-md p-1 text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:p-2.5" aria-label="Retry">
              <RefreshCw className="size-3" aria-hidden />
            </button>
          )}
        </div>
      )}
      <div className={cx("min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-3.5 pb-3", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 pt-1" aria-busy aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-7" />)}
    </div>
  );
}

export function Quiet({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="grid h-full min-h-14 place-items-center text-center">
      <div className="flex max-w-xs flex-col items-center gap-1.5 text-[13.5px] leading-snug text-fg-3">
        {icon}
        {children}
      </div>
    </div>
  );
}

// No data at all: say why. A 403 names the role this widget's data needs ("needs operator").
export function WidgetError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const status = (error as { status?: number })?.status;
  const message = (error as Error)?.message || "Something went wrong";
  if (status === 403) {
    const role = neededRole(message);
    return (
      <Quiet icon={<Lock className="size-4" aria-hidden />}>
        <span className="font-medium text-fg-2">{role ? `Needs ${role}` : "Not available to your role"}</span>
        <span>{role ? `Your role can't see this — it needs ${role} or above.` : message}</span>
      </Quiet>
    );
  }
  return (
    <Quiet icon={<TriangleAlert className="size-4 text-degraded" aria-hidden />}>
      <span className="[overflow-wrap:anywhere]">{status === 404 ? `Not found: ${message}` : message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="press mt-0.5 inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12.5px] font-medium text-fg-2 hover:border-line-strong pointer-coarse:h-10 pointer-coarse:px-3">
          <RefreshCw className="size-3" aria-hidden /> Retry
        </button>
      )}
    </Quiet>
  );
}

// One widget's crash stays inside its card (and the card keeps its edit toolbar, so it can be removed).
export class WidgetBoundary extends Component<{ children: ReactNode; icon: Icon }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(JSON.stringify({ level: 50, msg: "dashboard widget crashed", err: String(error?.message ?? error) }));
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Frame icon={this.props.icon}>
        <WidgetError error={{ message: `This widget failed to render: ${this.state.error.message}` }} onRetry={() => this.setState({ error: undefined })} />
      </Frame>
    );
  }
}
