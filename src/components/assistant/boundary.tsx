"use client";
// A run that can't be drawn (a server answering in a shape this build doesn't know) stays inside its own box: the drawer
// lives in the shell, so an uncaught render error there would take every page down with it.
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { Component, type ReactNode } from "react";

export class RunBoundary extends Component<{ runId: string; children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(JSON.stringify({ level: 50, msg: "assistant run view crashed", run: this.props.runId, err: String(error?.message ?? error) }));
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="space-y-2 rounded-xl border border-line bg-panel-2/50 px-3.5 py-3 text-[13.5px] leading-relaxed text-fg-2">
        <p>This run can&apos;t be shown here ({this.state.error.message}).</p>
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/automation#runs/${encodeURIComponent(this.props.runId)}`} className="font-medium text-accent hover:underline">
            Open it in Automation
          </Link>
          <button onClick={() => this.setState({ error: undefined })} className="inline-flex items-center gap-1 font-medium text-fg-3 hover:text-fg">
            <RefreshCw className="size-3" aria-hidden /> Try again
          </button>
        </div>
      </div>
    );
  }
}
