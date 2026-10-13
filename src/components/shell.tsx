"use client";
import { AnimatePresence, motion } from "motion/react";
import { Activity, AlertTriangle, BarChart3, BookOpen, Bookmark, Bot, CircleDollarSign, Network, CheckCircle2, ChevronDown, Command, GitBranch, GitCompareArrows, Globe, Keyboard, LayoutDashboard, LayoutGrid, Lock, Menu, Moon, PanelLeftClose, PanelLeftOpen, ScrollText, Search, Settings, ShieldOff, Siren, Sparkles, StickyNote, Sun, Table2, TerminalSquare, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import useSWR from "swr";
import { loadedAt, overviewKey, useCachedOverview, useCapability, useEnv, useEnvList, useSavedViews, type EnvListItem } from "@/lib/client/env";
import { effectiveOverview, groupByRegion } from "@/lib/client/format";
import { REGION_EVENT, readRegionFilter, regionLabel, useRegionFilter, useRegions, type RegionFilter } from "@/lib/client/region";
import { STATE_RANK } from "@/lib/status";
import type { EnvName, EnvOverview, State } from "@/lib/types";
import { Modal, Row, Sheet, enter, spring, useFresh } from "./motion";
import { STATE, StateBadge, StateDot } from "./state";
import { IconButton, Kbd, LogoMark, RegionBadge, TimeAgo, cx, useClockAt, useEdgeFade } from "./ui";
import { ApprovalsBadge } from "./approvals-badge";
import { hue } from "./hue";
import { AssistantRoot } from "./assistant/root";
import { AskButton, EmergencyStopBanner } from "./assistant/status";
import { openAssistant } from "./assistant/store";
import { UserMenu } from "./user-menu";

// Every page in the sidebar, with its "g <key>" shortcut. The command palette builds its page list from these too.
// "/" opens the person's home page (a dashboard or the Incident view when they chose one); ?view=overview always opens
// the Overview, so the Overview entry links there.
export const NAV = [
  { href: "/?view=overview", label: "Overview", hue: "hue-blue", icon: LayoutGrid, key: "o" },
  { href: "/dashboards", label: "Dashboards", hue: "hue-indigo", icon: LayoutDashboard, key: "h" },
  { href: "/map", label: "Cloud map", hue: "hue-cyan", icon: Network, key: "g" },
  { href: "/resources", label: "Resources", hue: "hue-violet", icon: Table2, key: "e" },
  { href: "/metrics", label: "Metrics", hue: "hue-teal", icon: BarChart3, key: "m" },
  { href: "/logs", label: "Logs", hue: "hue-slate", icon: TerminalSquare, key: "l" },
  { href: "/ci", label: "CI", hue: "hue-orange", icon: GitBranch, key: "c" },
  { href: "/activity", label: "Activity", hue: "hue-rose", icon: Activity, key: "a" },
  { href: "/releases", label: "Releases", hue: "hue-indigo", icon: GitCompareArrows, key: "r" },
  { href: "/notes", label: "Notes", hue: "hue-pink", icon: StickyNote, key: "n" },
  { href: "/costs", label: "Costs", hue: "hue-lime", icon: CircleDollarSign, key: "b" },
  { href: "/audit", label: "Audit", hue: "hue-slate", icon: ScrollText, key: "u" },
  { href: "/assistant", label: "Assistant", hue: "hue-pink", icon: Sparkles, key: "i" }, // "g i" opens the assistant drawer; the page is its history
];
// A nav entry's page, without its query ("/?view=overview" → "/").
const pathOf = (href: string) => href.split("?")[0];

export const NAV_FOOT = [
  { href: "/automation", label: "Automation", hue: "hue-violet", icon: Bot, key: "t" },
  { href: "/settings", label: "Settings", hue: "hue-slate", icon: Settings, key: "s" },
  { href: "/docs", label: "Docs", hue: "hue-cyan", icon: BookOpen, key: "d" },
];

interface Issue {
  env: EnvName;
  envLabel: string;
  protected: boolean;
  key: string;
  name: string;
  state: State;
  reasons: string[];
  since?: number;
  kind?: string; // "env": the whole environment (not sampled lately), "box": a host that never joined
}
// Problems in every discovered environment, from the server's background sampler (one request, any number of envs).
function useIssues() {
  const data = useSWR<Issue[]>("/api/issues", { refreshInterval: 10_000, keepPreviousData: true }).data;
  const list = Array.isArray(data) ? data : []; // the header renders on every page: never crash it on a bad body
  return [...list].sort((a, b) => Number(b.protected) - Number(a.protected)).map((x) => ({ env: x.env, label: x.envLabel, prot: x.protected, whole: x.kind === "env" || x.key === "env", r: { key: x.key, name: x.name, state: x.state, reasons: x.reasons, uptime: x.since ? { since: x.since } : undefined } }));
}

function IssuesDrawer({ onClose }: { onClose(): void }) {
  const issues = useIssues();
  const { fresh } = useFresh(issues.map(({ env, r }) => `${env}:${r.key}`));
  const router = useRouter();
  const { setEnv } = useEnv();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <Sheet onClose={onClose} as="aside" z="z-[70]" aria-label="Issues" className="flex h-full w-full flex-col overflow-hidden border-l border-line bg-panel shadow-float sm:w-[440px] sm:rounded-l-2xl">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div>
          <div className="font-display text-[26px] leading-tight">Issues</div>
          <div className="mt-0.5 text-xs text-fg-3">Down, degraded or unreadable, across every environment</div>
        </div>
        <IconButton label="Close (Esc)" onClick={onClose}><X className="size-4" /></IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-3 sm:p-4">
        {!issues.length && (
          <div className="fade-in grid place-items-center gap-2 py-20 text-center">
            <CheckCircle2 className="size-6 text-up" strokeWidth={1.5} />
            <div className="font-display text-2xl">All clear</div>
            <div className="text-xs text-fg-3">Nothing is down, degraded or unknown.</div>
          </div>
        )}
        <AnimatePresence>
          {issues.map(({ env, label, prot, whole, r }, i) => (
            <Row as="div" key={`${env}:${r.key}`} index={i} fresh={fresh.has(`${env}:${r.key}`)} className="rounded-2xl">
              <button
                onClick={() => {
                  setEnv(env);
                  onClose();
                  // A whole-environment row (not sampled lately) opens the environment, not a resource panel.
                  if (whole) return router.push(`/?env=${env}`);
                  router.push(`/?env=${env}&r=${encodeURIComponent(r.key)}`);
                  setTimeout(() => window.dispatchEvent(new Event("console:open")), 60);
                }}
                className="press block w-full rounded-2xl border border-line bg-panel p-3.5 text-left hover:border-line-strong hover:bg-panel-2 [--press-scale:0.985]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cx("eyebrow inline-flex flex-none items-center gap-1", prot && "!text-down")}>
                      {prot && <Lock className="size-2.5" />}
                      {label}
                    </span>
                    <span className="truncate text-[14px] font-medium">{r.name}</span>
                  </div>
                  <StateBadge state={r.state} />
                </div>
                <div className="mt-1.5 text-xs leading-relaxed text-fg-2">{r.reasons.join(" · ")}</div>
                {r.uptime?.since && <div className="mt-1 text-[12px] text-fg-3">{STATE[r.state].label.toLowerCase()} since <TimeAgo at={r.uptime.since} /></div>}
              </button>
            </Row>
          ))}
        </AnimatePresence>
      </div>
      <div className="flex-none border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Link href="/incident" onClick={onClose} className="press inline-flex items-center gap-2 rounded-lg text-[14px] font-medium text-fg-2 hover:text-fg pointer-coarse:min-h-10">
          <Siren className="size-4 text-fg-3" strokeWidth={1.75} /> Open the incident view
        </Link>
      </div>
    </Sheet>
  );
}

// "g <key>" for every page, four to a row, from NAV itself so the help can't drift from the keys.
const PAGES = [...NAV, ...NAV_FOOT];
const GOTO: [string, string][] = Array.from({ length: Math.ceil(PAGES.length / 4) }, (_, i) => PAGES.slice(i * 4, i * 4 + 4)).map((g) => [
  g.map((n) => `g ${n.key}`).join(" · "),
  g.map((n) => (n.label === "CI" ? n.label : n.label.toLowerCase())).join(" · "),
]);
const SHORTCUTS: [string, string][] = [
  ["⌘ K", "jump to anything"],
  ["?", "this help"],
  ...GOTO,
  ["/", "focus log search"],
  ["n · N", "next / previous log match"],
  ["f", "follow live logs"],
  ["[", "collapse / expand the sidebar"],
  ["Esc", "close panel or dialog"],
];

function Shortcuts({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => (e.key === "Escape" || e.key === "?") && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <Modal onClose={onClose} z="z-[85]" aria-label="Keyboard shortcuts" className="p-5 sm:max-w-md">
      <div className="mb-3 flex items-center gap-2.5">
        <Keyboard className="size-4 text-fg-3" />
        <span className="font-display text-2xl leading-none">Shortcuts</span>
      </div>
      <table className="w-full text-[14px]">
        <tbody>
          {SHORTCUTS.map(([k, d]) => (
            <tr key={k} className="border-t border-line">
              <td className="py-2.5 pr-3 font-mono text-xs text-fg">{k}</td>
              <td className="py-2.5 text-fg-2">{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

// Unknown (no dot) unless the overview has its lists: useOverview rejects other shapes, this keeps the shell safe regardless.
const worst = (o?: EnvOverview): State | undefined =>
  o && Array.isArray(o.services) && Array.isArray(o.infra) ? [...o.services, ...o.infra].reduce<State>((w, r) => (STATE_RANK[r.state] < STATE_RANK[w] ? r.state : w), "UP") : undefined;

type EnvOpt = { value: EnvName; label: string; prot: boolean; region: string; w?: State; why?: string };

// The selected env's state (F48, R21): from its overview while a page keeps that fresh (never a request of the
// shell's own); otherwise — no overview, or one left behind by a page that no longer polls it — the sampler's state
// from /api/envs, UNKNOWN when that is stale.
function useEnvStates(env: EnvName, envs: EnvListItem[]) {
  const cached = useCachedOverview(env).data;
  const received = loadedAt(overviewKey(env));
  const now = useClockAt((n) => (cached ? effectiveOverview(cached, n, received).next : undefined));
  const eff = cached && cached.env === env && now ? effectiveOverview(cached, now, received) : undefined;
  const live = eff && eff.o === cached ? eff.o : undefined; // nothing in it stale
  const opts: EnvOpt[] = envs.map((e) => {
    if (e.id === env && live) return { value: e.id, label: e.label, prot: e.protected, region: e.region, w: worst(live) };
    if (e.stale) return { value: e.id, label: e.label, prot: e.protected, region: e.region, w: "UNKNOWN", why: e.staleReason ?? "not sampled recently" };
    return { value: e.id, label: e.label, prot: e.protected, region: e.region, w: e.worst };
  });
  return { opts, current: opts.find((o) => o.value === env) };
}

// One region filter for the whole shell (header selector, env switcher, phone menu). Every useRegionFilter() follows
// a change made anywhere (REGION_EVENT, history); the shell also re-reads it when the page changes, whose URL may
// carry another ?region= (the map and resources pages have their own selector).
type ShellRegion = { region: RegionFilter; setRegion(r: RegionFilter): void; regions: string[]; multi: boolean };
function useShellRegion(path: string): ShellRegion {
  const { region: initial, setRegion, regions, multi } = useRegionFilter();
  const [picked, setPicked] = useState<RegionFilter | null>(null);
  const list = regions.join(",");
  useEffect(() => {
    // Browser-only inputs (URL, localStorage): read after hydration and on every page change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPicked(readRegionFilter(list ? list.split(",") : []));
  }, [list, path]);
  useEffect(() => {
    // A change made anywhere: useRegionFilter has re-read it, so its value wins until the next page change.
    const follow = () => setPicked(null);
    window.addEventListener(REGION_EVENT, follow);
    window.addEventListener("popstate", follow);
    return () => {
      window.removeEventListener(REGION_EVENT, follow);
      window.removeEventListener("popstate", follow);
    };
  }, []);
  const choose = useCallback((r: RegionFilter) => setRegion(r), [setRegion]); // announces it: every instance follows
  return { region: multi ? (picked ?? initial) : "all", setRegion: choose, regions, multi };
}

function EnvSwitch({ opts, loaded, rf }: { opts: EnvOpt[]; loaded: boolean; rf: ShellRegion }) {
  const { env, setEnv } = useEnv();
  const { region, multi } = rf;
  const home = useRegions().data?.home;
  if (!opts.length) return loaded ? null : <div className="skeleton h-8 w-44 rounded-lg" aria-label="Discovering environments" />;
  // With a region chosen, only its environments (and the selected one, wherever it is).
  const shown = multi && region !== "all" ? opts.filter((o) => o.region === region || o.value === env) : opts;
  const groups = multi ? groupByRegion(shown, home) : [{ region: "", items: shown }];
  return (
    <>
      <EnvTabs groups={groups} env={env} setEnv={setEnv} />
      <EnvSelect groups={groups} opts={opts} env={env} setEnv={setEnv} />
    </>
  );
}

const EnvDot = ({ o }: { o: EnvOpt }) =>
  o.w ? (
    <span title={o.why ? `${STATE[o.w].label}: ${o.why}` : STATE[o.w].label} className="inline-flex">
      <StateDot state={o.w} className="!size-1.5" />
    </span>
  ) : (
    <span className="size-1.5 flex-none rounded-full bg-line-strong" />
  );

type Group = { region: string; items: EnvOpt[] };

// sm and up: a segmented row that scrolls sideways when there are many environments. With several regions, each
// region's environments sit together behind a region badge.
function EnvTabs({ groups, env, setEnv }: { groups: Group[]; env: EnvName; setEnv(e: EnvName): void }) {
  const ref = useEdgeFade<HTMLDivElement>();
  return (
    <div ref={ref} role="tablist" aria-label="Environment" className="edge-fade no-scrollbar relative isolate hidden max-w-[52vw] items-center overflow-x-auto rounded-[11px] border border-line bg-panel-2 p-0.5 sm:inline-flex">
      {groups.map((g, gi) => (
        <span key={g.region || "all"} role="presentation" className={cx("flex flex-none items-center", gi > 0 && "ml-1 border-l border-line pl-1")}>
          {g.region && <RegionBadge region={g.region} className="mx-1 border-transparent" />}
          {g.items.map((o) => {
            const active = env === o.value;
            return (
              <button key={o.value} role="tab" aria-selected={active} onClick={() => setEnv(o.value)} className={cx("group relative flex-none rounded-lg px-3 py-1.5 text-[14px] font-medium transition-colors duration-200", active ? "text-fg" : "text-fg-3 hover:text-fg-2")}>
                {/* The selected environment carries the champagne hairline. */}
                {active && <motion.span layoutId="env-pill" className="absolute inset-0 -z-10 rounded-lg border border-accent/45 bg-panel shadow-card dark:bg-panel-3" transition={spring} />}
                <span className="press-content flex items-center gap-2 whitespace-nowrap">
                  <EnvDot o={o} />
                  {o.label}
                  {o.prot && <Lock className="size-3 text-fg-3" aria-label="protected" />}
                </span>
              </button>
            );
          })}
        </span>
      ))}
    </div>
  );
}

// Phones: the native picker (the OS sheet is the best touch control there is), dressed as a compact pill.
function EnvSelect({ groups, opts, env, setEnv }: { groups: Group[]; opts: EnvOpt[]; env: EnvName; setEnv(e: EnvName): void }) {
  const cur = opts.find((o) => o.value === env) ?? opts[0];
  const option = (o: EnvOpt) => (
    <option key={o.value} value={o.value}>
      {o.label}
      {o.prot ? " (protected)" : ""}
    </option>
  );
  return (
    <label className="relative flex h-9 min-w-0 items-center gap-2 rounded-lg border border-accent/45 bg-panel-2 pl-3 pr-2 text-[14px] font-medium sm:hidden">
      <EnvDot o={cur} />
      <span className="truncate">{cur.label}</span>
      {cur.prot && <Lock className="size-3 flex-none text-fg-3 max-[400px]:hidden" />}
      <ChevronDown className="size-3.5 flex-none text-fg-3" />
      <select aria-label="Environment" value={env} onChange={(e) => setEnv(e.target.value)} className="absolute inset-0 cursor-pointer appearance-none opacity-0">
        {/* The region filter applies here too: one region chosen = its environments only (plus the selected one). */}
        {groups.length > 1 ? groups.map((g) => <optgroup key={g.region} label={regionLabel(g.region)}>{g.items.map(option)}</optgroup>) : groups.flatMap((g) => g.items).map(option)}
      </select>
    </label>
  );
}

// The region filter (only with more than one region). Choosing a region that doesn't hold the selected environment
// moves to that region's first one, so the page never shows an environment outside the filter.
function RegionSelect({ rf, className }: { rf: ShellRegion; className?: string }) {
  const { region, setRegion, regions, multi } = rf;
  const { env, setEnv } = useEnv();
  const envs = useEnvList().data ?? [];
  if (!multi) return null;
  const choose = (r: string) => {
    setRegion(r);
    const cur = envs.find((e) => e.id === env);
    if (r !== "all" && cur && cur.region !== r) {
      const first = envs.find((e) => e.region === r);
      if (first) setEnv(first.id);
    }
  };
  return (
    <label title={`Region: ${regionLabel(region)}`} className={cx("relative flex h-8 flex-none items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-fg-2 hover:border-line-strong pointer-coarse:h-10", className)}>
      <Globe className="size-3.5 flex-none text-fg-3" strokeWidth={1.75} />
      <span className="max-w-[9rem] truncate">{region === "all" ? "All regions" : region}</span>
      <ChevronDown className="size-3 flex-none text-fg-3" />
      <select aria-label="Region" value={region} onChange={(e) => choose(e.target.value)} className="absolute inset-0 cursor-pointer appearance-none opacity-0">
        <option value="all">All regions</option>
        {regions.map((r) => (
          <option key={r} value={r}>{regionLabel(r)}</option>
        ))}
      </select>
    </label>
  );
}

// "Read-only AWS access" (F06): the console's AWS identity can change nothing, so every action is disabled.
function ReadOnlyBadge({ className }: { className?: string }) {
  const cap = useCapability();
  if (!cap?.readOnly) return null;
  return (
    <Link
      href="/settings/permissions"
      title={cap.note ?? "The console's AWS identity can't change ECS services: actions are disabled. Settings → AWS permissions shows what is missing."}
      className={cx("press flex h-8 flex-none items-center gap-1.5 rounded-lg border border-degraded/30 px-2.5 text-xs font-medium text-degraded hover:bg-degraded/8 pointer-coarse:h-10", className)}
    >
      <ShieldOff className="size-3.5" strokeWidth={1.75} />
      <span className="hidden lg:inline">Read-only AWS access</span>
      <span className="sr-only lg:hidden">Read-only AWS access</span>
    </Link>
  );
}

// "Save this view" (the palette names it and posts it): only once the saved-items API exists.
const saveView = () => window.dispatchEvent(new Event("console:save-view"));

// Theme lives on <html data-theme> (set before paint); every useTheme() reads it, so all toggles stay in sync.
function subscribeTheme(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}
// "system": no saved choice — the OS preference, read before paint (layout.tsx).
export type ThemeChoice = "light" | "dark" | "system";
function readThemeChoice(): ThemeChoice {
  try {
    const t = localStorage.getItem("console.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}
function subscribeThemeChoice(cb: () => void) {
  window.addEventListener("console:theme", cb);
  return () => window.removeEventListener("console:theme", cb);
}
export function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"), () => "dark" as const);
  const choice = useSyncExternalStore(subscribeThemeChoice, readThemeChoice, () => "system" as const);
  const set = (c: ThemeChoice) => {
    const next = c === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : c;
    const apply = () => {
      document.documentElement.dataset.theme = next;
      try {
        if (c === "system") localStorage.removeItem("console.theme");
        else localStorage.setItem("console.theme", c);
      } catch {
        /* storage blocked */
      }
      window.dispatchEvent(new Event("console:theme"));
    };
    // Crossfade the whole page between themes instead of snapping every colour at once.
    if (next !== theme && document.startViewTransition && document.documentElement.dataset.perf !== "lite") document.startViewTransition(apply);
    else apply();
  };
  const toggle = () => set(theme === "dark" ? "light" : "dark");
  return { theme, choice, set, toggle };
}

// Sidebar width preference (per browser). Collapsed = 64px icon rail.
function subscribeSidebar(cb: () => void) {
  window.addEventListener("console:sidebar", cb);
  return () => window.removeEventListener("console:sidebar", cb);
}
function readSidebar() {
  try {
    return localStorage.getItem("console.sidebar") === "collapsed";
  } catch {
    return false;
  }
}
function setSidebar(v: boolean | ((c: boolean) => boolean)) {
  const next = typeof v === "function" ? v(readSidebar()) : v;
  try {
    localStorage.setItem("console.sidebar", next ? "collapsed" : "open");
  } catch {
    /* storage blocked */
  }
  window.dispatchEvent(new Event("console:sidebar"));
}
export function useSidebar() {
  return [useSyncExternalStore(subscribeSidebar, readSidebar, () => false), setSidebar] as const;
}

// Phones: the sidebar is hidden, so the same links (and the account menu) live in a sheet behind a header button.
function MobileNav({ onClose, subtitle, canSave, rf }: { onClose(): void; subtitle: string; canSave: boolean; rf: ShellRegion }) {
  const path = usePathname();
  const { theme, toggle } = useTheme(); // the header drops its theme button on phones to make room for the env picker
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <Sheet onClose={onClose} side="left" as="aside" z="z-[70]" aria-label="Navigation" className="flex h-full w-[min(320px,86vw)] flex-col overflow-y-auto overscroll-contain rounded-r-2xl border-r border-line bg-panel px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] shadow-float">
      <div className="mb-4 flex items-center justify-between pl-2">
        <Brand subtitle={subtitle} />
        <IconButton label="Close menu" onClick={onClose}><X className="size-4" /></IconButton>
      </div>
      <nav className="space-y-0.5">
        {PAGES.map((n, i) => {
          const active = pathOf(n.href) === "/" ? path === "/" : path.startsWith(pathOf(n.href));
          return (
            <Link
              key={n.href}
              href={n.href}
              onClick={onClose}
              aria-current={active ? "page" : undefined}
              style={{ ...(i === NAV.length ? { marginTop: 16 } : {}), ...hue(n.hue) }}
              className={cx("press flex h-11 items-center gap-3 rounded-xl px-3 text-[16px] font-medium", active ? "bg-panel-3 text-fg" : "text-fg-2 hover:bg-panel-2")}
            >
              <n.icon className={cx("size-[18px]", active ? "hue-text" : "text-fg-3")} strokeWidth={1.75} /> {n.label}
              {n.href === "/automation" && <ApprovalsBadge />}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto space-y-2 border-t border-line pt-3">
        <RegionSelect rf={rf} className="w-full justify-start" />
        {canSave && (
          <button
            onClick={() => {
              onClose();
              setTimeout(saveView, 60);
            }}
            className="press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-[15px] font-medium text-fg-2 hover:bg-panel-2"
          >
            <Bookmark className="size-4" /> Save this view
          </button>
        )}
        <button onClick={toggle} className="press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-[15px] font-medium text-fg-2 hover:bg-panel-2">
          {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />} {theme === "dark" ? "Light theme" : "Dark theme"}
        </button>
        <UserMenu collapsed={false} />
      </div>
    </Sheet>
  );
}

// The mark and wordmark. The subtitle names where the console is pointed (cloud and region), never a company.
function Brand({ subtitle, collapsed }: { subtitle: string; collapsed?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <LogoMark />
      {!collapsed && (
        <span className="fade-in min-w-0 leading-tight">
          <span className="block whitespace-nowrap text-[14px] font-semibold tracking-[-0.01em]">Deployment Console</span>
          <span className="block truncate font-mono text-[11.5px] text-fg-3">{subtitle}</span>
        </span>
      )}
    </span>
  );
}

// document.title for client pages (F43): "<page> · Deployment Console". Pages that set their own title (the docs'
// metadata, a dashboard's name) keep it: only the default or a title this effect set is replaced.
const TITLE = "Deployment Console";
const EXTRA_TITLES: [string, string][] = [["/incident", "Incident view"], ["/account", "Account"]];
function useDocumentTitle(path: string) {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (path.startsWith("/docs")) return;
    const n = PAGES.find((x) => (pathOf(x.href) === "/" ? path === "/" : path === x.href || path.startsWith(`${x.href}/`)));
    const label = n?.label ?? EXTRA_TITLES.find(([p]) => path.startsWith(p))?.[1];
    if (!label) return;
    const next = `${label} · ${TITLE}`;
    const apply = () => {
      const t = document.title;
      if (t === next || !(t === TITLE || t === "" || t === last.current)) return;
      document.title = next;
      last.current = next;
    };
    apply();
    // Next writes the layout's title after navigation; put the page's back when it does.
    const mo = new MutationObserver(apply);
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [path]);
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { env, missing, dismissMissing } = useEnv();
  const envList = useEnvList().data;
  const envs = envList ?? [];
  const envsLoaded = Array.isArray(envList);
  const { theme, toggle } = useTheme();
  const me = useSWR<{ email: string; source: string }>("/api/me", { revalidateOnFocus: false }).data;
  const { opts, current } = useEnvStates(env, envs);
  const w = current?.w;
  const issues = useIssues();
  const canSave = Array.isArray(useSavedViews().data);
  const [showIssues, setShowIssues] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [collapsed, setCollapsed] = useSidebar();
  const [mobileNav, setMobileNav] = useState(false);
  const router = useRouter();
  const info = envs.find((e) => e.id === env);
  const subtitle = info?.region ? `AWS · ${info.region}` : "AWS";
  const rf = useShellRegion(path);
  useDocumentTitle(path);

  // "?" opens help; "g" then a letter jumps to a page — "g i" asks the assistant (the drawer) instead.
  useEffect(() => {
    let g = 0;
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if ((t && typeof t.closest === "function" && t.closest("input, textarea, select, [contenteditable]")) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") setShowKeys((s) => !s);
      else if (e.key === "[") setSidebar((c) => !c);
      else if (e.key === "g" && !(Date.now() - g < 900)) g = Date.now();
      else if (Date.now() - g < 900) {
        const n = PAGES.find((x) => x.key === e.key);
        if (n?.href === "/assistant") openAssistant();
        else if (n) router.push(n.href);
        g = 0;
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [router]);

  return (
    <div className="relative flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:border focus:border-line focus:bg-panel focus:px-3 focus:py-2 focus:text-[14px] focus:font-medium focus:text-fg focus:shadow-float">
        Skip to content
      </a>
      <aside
        className={cx(
          "sticky top-0 hidden h-screen flex-none flex-col border-r border-line bg-bg py-4 transition-[width,padding] duration-300 ease-smooth md:flex",
          collapsed ? "w-16 px-2" : "w-[232px] px-3",
        )}
      >
        <Link href="/" className={cx("mb-6 flex items-center", collapsed ? "justify-center" : "px-2")} title="Deployment Console">
          <Brand subtitle={subtitle} collapsed={collapsed} />
        </Link>
        <nav className="min-h-0 space-y-px overflow-y-auto no-scrollbar">
          {PAGES.map((n, i) => {
            const active = pathOf(n.href) === "/" ? path === "/" : path.startsWith(pathOf(n.href));
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                style={{ ...(i === NAV.length ? { marginTop: 16 } : {}), ...hue(n.hue) }}
                title={collapsed ? `${n.label} (g ${n.key})` : undefined}
                className={cx("group relative flex h-8 items-center rounded-lg text-[14px] font-medium transition-colors duration-200", collapsed ? "px-0" : "px-2.5", active ? "text-fg" : "text-fg-3 hover:bg-panel-2 hover:text-fg-2")}
              >
                {active && <motion.span layoutId="nav-active" className="absolute inset-0 -z-10 rounded-lg bg-panel-3" transition={spring} />}
                {/* Content dips on press; the indicator stays full size so its slide lands cleanly. */}
                <span className={cx("press-content relative flex min-w-0 flex-1 items-center gap-2.5 [--press-scale:0.97]", collapsed && "justify-center")}>
                  {/* Each page's hue shows on its icon when it's open or pointed at; the rest stay quiet. */}
                  <n.icon className={cx("size-4 flex-none transition-colors duration-200", active ? "hue-text" : "group-hover:hue-text")} strokeWidth={1.75} />
                  {!collapsed && <span className="fade-in overflow-hidden whitespace-nowrap">{n.label}</span>}
                  {pathOf(n.href) === "/" && w && w !== "UP" && <StateDot state={w} className={cx("!size-1.5", collapsed ? "absolute -top-0.5 right-2" : "ml-auto")} />}
                  {n.href === "/automation" && <ApprovalsBadge collapsed={collapsed} />}
                </span>
              </Link>
            );
          })}
        </nav>
        <div className={cx("mt-auto space-y-2 pt-3 text-[12px] text-fg-3", collapsed ? "px-0 text-center" : "px-1")}>
          {!collapsed && me?.source === "mock" && (
            <div className="mx-1 flex items-center gap-2 rounded-lg border border-dashed border-line-strong px-2.5 py-1.5">
              <span className="dot" data-anim="hatch" style={{ "--dot": "var(--text-3)" } as React.CSSProperties} />
              Mock data source
            </div>
          )}
          <UserMenu collapsed={collapsed} />
          <div className={cx("flex items-center", collapsed ? "flex-col gap-2" : "justify-between gap-2 px-1.5")}>
            {!collapsed && <span className="min-w-0 font-mono text-[11px] [overflow-wrap:anywhere]">build {(process.env.NEXT_PUBLIC_VERSION ?? "dev").slice(0, 7)}</span>}
            <IconButton label={collapsed ? "Expand sidebar ( [ )" : "Collapse sidebar ( [ )"} onClick={() => setCollapsed(!collapsed)} className="size-7">
              {collapsed ? <PanelLeftOpen className="size-4" strokeWidth={1.75} /> : <PanelLeftClose className="size-4" strokeWidth={1.75} />}
            </IconButton>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] px-3 backdrop-blur-xl sm:gap-3 sm:px-6 max-sm:h-[calc(3.25rem+env(safe-area-inset-top))] max-sm:pt-[env(safe-area-inset-top)]">
          <IconButton label="Open menu" onClick={() => setMobileNav(true)} className="md:hidden"><Menu className="size-[18px]" strokeWidth={1.75} /></IconButton>
          <RegionSelect rf={rf} className="max-sm:hidden" />
          <EnvSwitch opts={opts} loaded={envsLoaded} rf={rf} />
          {w && (
            <span className="hidden whitespace-nowrap text-xs text-fg-3 2xl:inline" title={current?.why}>
              {info?.label ?? env} is <span style={{ color: STATE[w].color }}>{STATE[w].label.toLowerCase()}</span>
            </span>
          )}
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <ReadOnlyBadge />
            <button
              onClick={() => setShowIssues(true)}
              aria-label={issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : "All clear"}
              className={cx(
                "press relative flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium pointer-coarse:h-10 pointer-coarse:px-3",
                issues.length ? "border-down/30 text-down hover:bg-down/8" : "border-line text-fg-3 hover:text-fg-2",
              )}
            >
              {issues.length ? <AlertTriangle className="size-3.5" strokeWidth={1.75} /> : <CheckCircle2 className="size-3.5 text-up" strokeWidth={1.75} />}
              <span className="tabular-nums">{issues.length || ""}</span>
              <span className="hidden sm:inline">{issues.length ? `issue${issues.length === 1 ? "" : "s"}` : "All clear"}</span>
            </button>
            <AskButton />
            {canSave && <IconButton label="Save this view" onClick={saveView} className="hidden sm:grid"><Bookmark className="size-4" strokeWidth={1.75} /></IconButton>}
            <IconButton label="Keyboard shortcuts (?)" onClick={() => setShowKeys(true)} className="hidden sm:grid"><Keyboard className="size-4" strokeWidth={1.75} /></IconButton>
            <IconButton label="Jump to…" onClick={() => window.dispatchEvent(new Event("console:palette"))} className="sm:hidden"><Search className="size-[18px]" strokeWidth={1.75} /></IconButton>
            <button onClick={() => window.dispatchEvent(new Event("console:palette"))} className="press hidden h-8 flex-none items-center gap-2 whitespace-nowrap rounded-lg border border-line px-2.5 text-xs text-fg-3 hover:border-line-strong hover:text-fg-2 sm:flex">
              <Command className="size-3.5" strokeWidth={1.75} /> Jump to… <Kbd>⌘K</Kbd>
            </button>
            <IconButton label="Toggle theme" onClick={toggle} className="overflow-hidden max-sm:hidden">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={theme} initial={{ opacity: 0, scale: 0.6, rotate: -40 }} animate={{ opacity: 1, scale: 1, rotate: 0, transition: enter }} exit={{ opacity: 0, scale: 0.6, rotate: 40, transition: { duration: 0.14 } }} className="grid place-items-center">
                  {theme === "dark" ? <Moon className="size-4" strokeWidth={1.75} /> : <Sun className="size-4" strokeWidth={1.75} />}
                </motion.span>
              </AnimatePresence>
            </IconButton>
          </div>
        </header>
        {missing && (
          <div role="status" className="flex items-start gap-2 border-b border-degraded/25 bg-degraded/8 px-4 py-2 text-[13.5px] text-fg-2 sm:px-6">
            <AlertTriangle className="mt-0.5 size-3.5 flex-none text-degraded" strokeWidth={1.75} />
            <p className="min-w-0 flex-1 leading-5 [overflow-wrap:anywhere]">
              Environment <b className="font-medium text-fg">‘{missing}’</b> isn&apos;t available (see{" "}
              <Link href="/settings/environments" className="text-accent hover:underline">Settings → Environments</Link>). Showing {info?.label ?? env}.
            </p>
            <IconButton label="Dismiss" onClick={dismissMissing} className="-my-1 size-7"><X className="size-3.5" /></IconButton>
          </div>
        )}
        {/* Read-only, for everyone, while the agents' emergency stop is on (the Automation page has its own, with the switch). */}
        {!path.startsWith("/automation") && <EmergencyStopBanner />}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 outline-none">{children}</main>
      </div>
      <AnimatePresence>{showIssues && <IssuesDrawer onClose={() => setShowIssues(false)} />}</AnimatePresence>
      <AnimatePresence>{showKeys && <Shortcuts onClose={() => setShowKeys(false)} />}</AnimatePresence>
      <AnimatePresence>{mobileNav && <MobileNav subtitle={subtitle} canSave={canSave} rf={rf} onClose={() => setMobileNav(false)} />}</AnimatePresence>
      <AssistantRoot />
    </div>
  );
}
