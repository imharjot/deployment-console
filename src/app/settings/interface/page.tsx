"use client";
// Settings → Interface: per-browser preferences (localStorage, applied before paint by layout.tsx) — theme, effects
// level (src/lib/client/perf.ts) and the sidebar. Nothing here is sent to the server.
import { Gauge, Monitor, Moon, PanelLeft, Sun, Zap } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { useSidebar, useTheme, type ThemeChoice } from "@/components/shell";
import { hue } from "@/components/hue";
import { Segmented } from "@/components/ui";
import { usePerfChoice, type PerfChoice } from "@/lib/client/perf";

export default function InterfaceSettings() {
  const { choice, set } = useTheme();
  const perf = usePerfChoice();
  const [collapsed, setCollapsed] = useSidebar();
  // What the device reports (0 = unknown; deviceMemory is Chromium-only, rounded and capped at 8).
  const threads = useSyncExternalStore(noop, () => navigator.hardwareConcurrency ?? 0, () => 0);
  const memory = useSyncExternalStore(noop, () => (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0, () => 0);

  return (
    <div className="stagger max-w-3xl space-y-4">
      <Row
        icon={choice === "light" ? <Sun className="size-[18px]" /> : choice === "dark" ? <Moon className="size-[18px]" /> : <Monitor className="size-[18px]" />}
        tone="hue-indigo"
        title="Theme"
        hint="System follows your device's light or dark setting each time the console opens."
      >
        <Segmented<ThemeChoice>
          id="theme"
          value={choice}
          onChange={set}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
            { value: "system", label: "System" },
          ]}
        />
      </Row>

      <Row
        icon={perf.level === "lite" ? <Gauge className="size-[18px]" /> : <Zap className="size-[18px]" />}
        tone="hue-pink"
        title="Effects"
        hint={
          <>
            <b className="font-semibold text-fg-2">Full</b>: background blur, live pulses on states that need attention and every animation.{" "}
            <b className="font-semibold text-fg-2">Lite</b>: no blur or looping animations, movement replaced by fades, and the console polls half as often — smooth on older or
            busy machines. <b className="font-semibold text-fg-2">Auto</b> picks for this device
            {threads ? ` (${threads} CPU threads${memory ? `, about ${memory} GB memory` : ""})` : ""}: {perf.detected}.
          </>
        }
      >
        <Segmented<PerfChoice>
          id="perf"
          value={perf.choice}
          onChange={perf.set}
          options={[
            { value: "auto", label: "Auto" },
            { value: "full", label: "Full" },
            { value: "lite", label: "Lite" },
          ]}
        />
      </Row>

      <Row icon={<PanelLeft className="size-[18px]" />} tone="hue-teal" title="Sidebar" hint="Collapsed shows icons only; hover them for names. Also toggled from the sidebar's own button.">
        <Segmented<"open" | "collapsed">
          id="sidebar"
          value={collapsed ? "collapsed" : "open"}
          onChange={(v) => setCollapsed(v === "collapsed")}
          options={[
            { value: "open", label: "Expanded" },
            { value: "collapsed", label: "Collapsed" },
          ]}
        />
      </Row>

      <p className="px-1 text-[13px] text-fg-3">These apply to this browser only. Text size follows your browser zoom (⌘ + / Ctrl +).</p>
    </div>
  );
}

const noop = () => () => {};

function Row({ icon, tone, title, hint, children }: { icon: ReactNode; tone: string; title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-panel p-5 shadow-card sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div className="flex min-w-0 gap-3.5">
        <span className="hue-chip grid size-10 flex-none place-items-center rounded-xl" style={hue(tone)}>{icon}</span>
        <div className="min-w-0">
          <h3 className="text-[16px] font-semibold">{title}</h3>
          <p className="mt-1 text-[14px] leading-relaxed text-fg-3">{hint}</p>
        </div>
      </div>
      <div className="flex-none">{children}</div>
    </section>
  );
}
