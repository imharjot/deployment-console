"use client";
// One node on the cloud map. Three levels of detail follow the zoom so the plane stays legible at any scale:
// - full: icon, name, health dot, a compact line (health reason, or kind · first property) and badges
//   (idle, notes, alarm, folded children, environment when the map has no lanes);
// - mid: icon and the name only, set large enough to stay readable (up to two lines, broken only between words);
// - mini: the icon and the health colour, nothing to read (hover or focus shows a label).
// Problems carry a ring at mid and mini detail, and a group says how many of its members have one.
// Group nodes ("42 Lambda functions") look like a small stack of cards and expand on click or Enter.
// A reference to something in another account or region (R14) is dashed and says so; a resource that a complete
// read no longer listed ("not seen since … — confirming") is faded and dashed until the next read decides.
import { Puzzle, Siren, StickyNote } from "lucide-react";
import { Fragment, createElement, memo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { REF_SUFFIX, type LayoutNode } from "@/lib/inventory/layout";
import { KIND_INFO, categoryOf, type Health, type Resource } from "@/lib/inventory/types";
import { catHue } from "../hue";
import { cx } from "../ui";
import { REMOTE_TEXT, isRemote } from "./filter";
import { HEALTH, HealthDot, KIND_ICON, healthStyle, iconOf, isProblem, kindPlural, shortOf } from "./kinds";

export type Lod = "full" | "mid" | "mini";
export interface GroupInfo {
  worst: Health;
  problems: number;
  idle: number;
  notes: number;
}

export interface ChipHandlers {
  onActivate(id: string): void;
  onKey(e: ReactKeyboardEvent, id: string): void;
  onFocus(id: string): void;
  onBlur(id: string): void;
  onHover(id: string | null): void;
  register(id: string, el: HTMLElement | null): void;
}

export const FULL_NAME_CHARS = 26; // what fits beside the icon and the dot at full detail (13px, 216px chip)

export { REMOTE_TEXT, isRemote } from "./filter";
export const isVanishing = (r: Pick<Resource, "facts">) => r.facts?.vanishing === true;

export function chipMeta(r: Resource) {
  if (isRemote(r)) return REMOTE_TEXT;
  if (r.health !== "ok" && r.healthReason) return r.healthReason;
  const first = r.props[0];
  return first ? `${shortOf(r)} · ${first.value}` : shortOf(r);
}

export function nodeTitle(n: LayoutNode, r?: Resource) {
  if (r) return r.name;
  const count = n.members?.length ?? 0;
  if (n.service) {
    const ref = n.service.endsWith(REF_SUFFIX);
    const svc = ref ? n.service.slice(0, -REF_SUFFIX.length) : n.service;
    return `${count.toLocaleString()} ${ref ? "referenced " : ""}${svc} resource${count === 1 ? "" : "s"}`;
  }
  return kindPlural(n.kind, count);
}

// F41: long names lose their middle, not their end ("acme-produc…-order-events"), so both the prefix and the
// distinguishing tail stay readable.
export function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

// F41: a name may break only after - _ . / : (token boundaries), never inside a word.
export function breakable(s: string): ReactNode {
  const parts = s.split(/(?<=[-_./:])/);
  if (parts.length < 2) return s;
  return parts.map((p, i) => (
    <Fragment key={i}>
      {p}
      {i < parts.length - 1 && <wbr />}
    </Fragment>
  ));
}

function describe(n: LayoutNode, r: Resource | undefined, g: GroupInfo | undefined, envLabel: string) {
  if (g) {
    const bits = [`${nodeTitle(n)} in ${envLabel}`, "group"];
    if (g.problems) bits.push(`${g.problems} with problems`);
    if (g.idle) bits.push(`${g.idle} idle`);
    bits.push("press Enter to expand");
    return bits.join(", ");
  }
  if (!r) return n.id;
  const bits = [r.name, shortOf(r), envLabel, HEALTH[r.health].label.toLowerCase() + (r.healthReason ? `: ${r.healthReason}` : "")];
  if (isRemote(r)) bits.push(REMOTE_TEXT);
  if (r.idle) bits.push(`idle: ${r.idle.why}`);
  if (r.notes) bits.push(`${r.notes} note${r.notes === 1 ? "" : "s"}`);
  if (n.folded?.length) bits.push(`${n.folded.length} inside`);
  return bits.join(", ");
}

// Group nodes: two offset card edges behind the face.
const STACK = "[box-shadow:4px_4px_0_-1px_var(--panel-2),4px_4px_0_0_var(--border-strong),8px_8px_0_-1px_var(--panel-2),8px_8px_0_0_var(--border)]";

export const NodeChip = memo(function NodeChip({ n, r, g, lod, hot, match, ctx, selected, showEnv, envLabel, dupe, alarm, h }: {
  n: LayoutNode;
  r?: Resource;
  g?: GroupInfo;
  lod: Lod; // the mid level's name size comes from --mid-font on the plane, so zooming never re-renders chips
  hot: boolean;
  match: boolean;
  ctx: boolean;
  selected: boolean;
  showEnv: boolean;
  envLabel: string;
  dupe?: boolean; // another node in this lane has the same name: add the kind's short name
  alarm?: boolean; // a (non-scaling) alarm that watches it is in ALARM
  h: ChipHandlers;
}) {
  const Icon = r ? iconOf(r) : KIND_ICON[n.kind] ?? Puzzle;
  const health: Health = r?.health ?? g?.worst ?? "unknown";
  const problem = isProblem(health);
  const title = nodeTitle(n, r); // the real name at every zoom: "acme-production-pg" and "acme-staging-pg" never both read "acme-pg"
  const kindShort = r ? shortOf(r) : (KIND_INFO[n.kind]?.label ?? n.kind);
  const group = !!g;
  const remote = !!r && isRemote(r);
  const vanishing = !!r && isVanishing(r);
  const folded = n.folded?.length ?? 0;
  const category = r ? categoryOf(r) : (KIND_INFO[n.kind]?.category ?? "other");
  return (
    <button
      ref={(el) => h.register(n.id, el)}
      type="button"
      data-node={n.id}
      data-hot={hot || undefined}
      aria-label={describe(n, r, g, envLabel)}
      aria-expanded={group ? false : undefined}
      aria-current={selected ? "true" : undefined}
      title={`${title} · ${kindShort}`}
      onClick={() => h.onActivate(n.id)}
      onKeyDown={(e) => h.onKey(e, n.id)}
      onFocus={() => h.onFocus(n.id)}
      onBlur={() => h.onBlur(n.id)}
      onPointerEnter={(e) => e.pointerType === "mouse" && h.onHover(n.id)}
      onPointerLeave={(e) => e.pointerType === "mouse" && h.onHover(null)}
      style={{ transform: `translate(${n.x}px,${n.y}px)`, width: n.w, height: n.h, ...healthStyle(health), ...catHue(category) }}
      className={cx(
        "group/node absolute left-0 top-0 flex overflow-visible rounded-2xl border text-left",
        // F46: no opacity transition — a hover spotlight must not start thousands of transitions.
        "transition-[transform,border-color,background-color] duration-[450ms] ease-smooth",
        "focus-visible:[outline-offset:calc(3px/var(--zc,1))] focus-visible:[outline-width:calc(2px/var(--zc,1))]",
        // Spotlight: while a node or edge is in focus, everything not on its paths steps back.
        "group-data-[spot=on]/map:opacity-25 data-[hot]:!opacity-100",
        // Shadows only at full detail: hundreds of soft shadows are the most expensive thing to repaint on zoom.
        group ? cx("border-line-strong bg-panel", STACK) : cx("border-line bg-panel hover:border-line-strong", lod === "full" && "shadow-card"),
        problem && "border-[color-mix(in_srgb,var(--dot)_50%,var(--border))]",
        lod === "mini" && problem && "[border-width:calc(2px/var(--zc,1))]",
        (remote || vanishing) && "border-dashed [border-width:calc(1.5px/var(--zc,1))]",
        vanishing && "opacity-60",
        selected && "!border-accent",
        ctx && "opacity-55",
      )}
    >
      {/* Its category's hue down the left edge (full detail only: at lower zoom the icon carries it). */}
      {lod === "full" && <span aria-hidden className="pointer-events-none absolute inset-y-3 left-0 w-[3px] rounded-full bg-[var(--hue)] opacity-75" />}
      {match && <span aria-hidden className="pointer-events-none absolute -inset-[5px] rounded-[20px] border-accent/80 [border-style:solid] [border-width:calc(1.5px/var(--zc,1))]" />}
      {/* Problem ring: at mid and mini detail the reason is unreadable, so the colour has to carry it. */}
      {problem && lod !== "full" && <span aria-hidden className="pointer-events-none absolute -inset-[7px] rounded-[22px] border-[var(--dot)] [border-style:solid] [border-width:calc(2.5px/var(--zc,1))] opacity-80" />}
      {lod === "full" ? (
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-3">
          <span className="flex min-w-0 items-center gap-2">
            {createElement(Icon, { className: "hue-text size-3.5 flex-none", strokeWidth: 1.8, "aria-hidden": true })}
            <span className="min-w-0 flex-1 whitespace-nowrap text-[14px] font-medium tracking-[-0.01em] text-fg">
              {middleTruncate(title, dupe ? FULL_NAME_CHARS - kindShort.length - 3 : FULL_NAME_CHARS)}
              {dupe && <span className="font-normal text-fg-3"> · {kindShort}</span>}
            </span>
            {alarm && <Siren className="size-3 flex-none text-down" strokeWidth={1.8} aria-label="alarm" />}
            <HealthDot health={health} className="!size-2" />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 pl-[22px] text-[12px] leading-4">
            <span className={cx("min-w-0 flex-1 truncate", problem ? "text-[var(--dot)]" : health === "stopped" || remote || vanishing ? "text-fg-3" : "font-mono text-fg-3")}>
              {g ? groupLine(g) : r ? chipMeta(r) : ""}
            </span>
            {folded > 0 && <span className="flex-none rounded border border-line px-1 text-[11px] leading-[14px] text-fg-3">+{folded} inside</span>}
            {r?.idle && <span className="flex-none rounded border border-line px-1 text-[11px] leading-[14px] text-fg-3">idle</span>}
            {(r?.notes ?? g?.notes ?? 0) > 0 && (
              <span className="inline-flex flex-none items-center gap-0.5 text-[11.5px] text-fg-3">
                <StickyNote className="size-3" strokeWidth={1.6} aria-hidden />
                {r?.notes ?? g?.notes}
              </span>
            )}
            {showEnv && r?.env && <span className="max-w-[78px] flex-none truncate rounded border border-line bg-panel-2 px-1 font-mono text-[11px] leading-[14px] text-fg-2">{envLabel}</span>}
          </span>
        </span>
      ) : lod === "mid" ? (
        <span className="flex min-w-0 flex-1 items-center gap-[0.35em] px-[0.45em]" style={{ fontSize: "var(--mid-font, 20px)" }}>
          {roomForIcon(title, n.w) && createElement(Icon, { className: "hue-text flex-none", style: { width: "0.85em", height: "0.85em" }, strokeWidth: 1.8, "aria-hidden": true })}
          <span className="line-clamp-2 min-w-0 flex-1 font-medium leading-[1.12] tracking-[-0.015em] text-fg [overflow-wrap:normal]">{breakable(title)}</span>
          {g && g.problems > 0 ? <ProblemCount n={g.problems} /> : <HealthDot health={health} still className="!size-[0.42em]" />}
        </span>
      ) : (
        <span className="relative flex flex-1 items-center justify-center">
          {createElement(Icon, { className: "hue-text size-7", strokeWidth: 1.6, "aria-hidden": true })}
          {group && <span className="absolute bottom-1.5 right-3 font-mono text-[18px] font-medium text-fg-2">{n.members?.length}</span>}
          {g && g.problems > 0 ? <span className="absolute right-2 top-2 text-[18px]"><ProblemCount n={g.problems} /></span> : <HealthDot health={health} still className="absolute right-3 top-3 !size-3" />}
        </span>
      )}
    </button>
  );
});

function ProblemCount({ n }: { n: number }) {
  return <span className="flex-none rounded-full bg-[var(--dot)] px-[0.35em] text-[0.6em] font-semibold leading-[1.5] text-white tabular-nums">{n}</span>;
}

// Mid detail: the kind icon gives way when the name's longest word would not fit beside it (so words aren't split).
// (Judged at a typical mid-level size, 22px, so it doesn't change while zooming.)
function roomForIcon(title: string, w: number, fontPx = 22) {
  const longest = Math.max(...title.split(/[\s\-_./:]/).map((x) => x.length));
  return longest * 0.56 * fontPx <= w - fontPx * 2.75;
}

function groupLine(g: GroupInfo) {
  const bits = [];
  if (g.problems) bits.push(`${g.problems} with problems`);
  if (g.idle) bits.push(`${g.idle} idle`);
  return bits.length ? bits.join(" · ") : "click to expand";
}
