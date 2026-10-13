"use client";
// One motion language for the console: quick, calm, precise. No bounce, short travel,
// exits faster than enters, and only transform and opacity are animated.
import { clsx } from "clsx";
import { AnimatePresence, animate, motion, useDragControls, useIsPresent, useReducedMotion, type MotionProps, type Transition } from "motion/react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

// ---------- tokens ----------
export const EASE = [0.32, 0.72, 0, 1] as const; // enters: fast start, long soft landing (the iOS sheet curve)
export const EASE_IN = [0.4, 0, 1, 1] as const; // exits: accelerate away
export const enter: Transition = { duration: 0.3, ease: EASE };
export const exit: Transition = { duration: 0.16, ease: EASE_IN };
export const spring: Transition = { type: "spring", visualDuration: 0.34, bounce: 0 }; // indicators, layout
export const springFast: Transition = { type: "spring", visualDuration: 0.2, bounce: 0 }; // highlights that follow the pointer

type Preset = Pick<MotionProps, "initial" | "animate" | "exit">;

export const fade: Preset = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.24, ease: EASE } },
  exit: { opacity: 0, transition: exit },
};
// Dialogs and the palette settle in from 97%.
export const pop: Preset = {
  initial: { opacity: 0, scale: 0.97, y: 6 },
  animate: { opacity: 1, scale: 1, y: 0, transition: enter },
  exit: { opacity: 0, scale: 0.985, transition: exit },
};
// Menus drop 4px from their trigger; pair with an origin-* class on the trigger side.
export const popover: Preset = {
  initial: { opacity: 0, scale: 0.97, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.2, ease: EASE } },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: EASE_IN } },
};
// Side sheets drift in from 28px instead of sliding the full width.
export const sheet: Preset = {
  initial: { opacity: 0, x: 28, scale: 0.985 },
  animate: { opacity: 1, x: 0, scale: 1, transition: { duration: 0.36, ease: EASE } },
  exit: { opacity: 0, x: 20, scale: 0.99, transition: exit },
};
const sheetLeft: Preset = {
  initial: { opacity: 0, x: -28, scale: 0.985 },
  animate: { opacity: 1, x: 0, scale: 1, transition: { duration: 0.36, ease: EASE } },
  exit: { opacity: 0, x: -20, scale: 0.99, transition: exit },
};
// Bottom sheets (phones) rise the full height; the scrim carries the fade.
export const rise: Preset = {
  initial: { y: "100%" },
  animate: { y: 0, transition: { duration: 0.44, ease: EASE } },
  exit: { y: "100%", transition: { duration: 0.24, ease: EASE_IN } },
};
// Tab / view content: overlapping crossfade with a hint of scale (transform + opacity only).
export const swap: Preset = {
  initial: { opacity: 0, scale: 0.995 },
  animate: { opacity: 1, scale: 1, transition: enter },
  exit: { opacity: 0, transition: { duration: 0.14, ease: EASE_IN } },
};

// ---------- viewport ----------
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}
// Below Tailwind's `sm`: dialogs become bottom sheets, panels go full screen.
export const usePhone = () => useMediaQuery("(max-width: 639px)");

// ---------- overlays ----------
const noop = () => () => {};
// Page-level overlays render into <body> so the route transition's transform never re-anchors `fixed`.
export function Portal({ children }: { children: ReactNode }) {
  const client = useSyncExternalStore(noop, () => true, () => false);
  return client ? createPortal(children, document.body) : null;
}

function Scrim({ onClick }: { onClick?: () => void }) {
  return <motion.div {...fade} aria-hidden className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[2px]" onClick={onClick} />;
}

// ---------- focus ----------
// Overlays are modal. While one is open the rest of the page is inert (no focus, clicks or screen-reader access),
// Tab wraps inside it, and closing hands focus back to whatever opened it. Layers stack (a confirmation over a
// sheet): only the top one is live, and each remembers exactly what it made inert so closing restores the rest.
type Layer = { root: HTMLElement; panel: HTMLElement | null; inerted: Element[] };
const layers: Layer[] = [];

const FOCUSABLE = "a[href], area[href], button, input:not([type=hidden]), select, textarea, iframe, summary, [contenteditable]:not([contenteditable=false]), [tabindex]";
const focusables = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && !el.matches(":disabled") && !el.closest("[inert]") && el.getClientRects().length > 0);

// Stays live under an overlay: aria-live regions (toasts must keep announcing and stay dismissable), Next's own
// elements (route announcer, dev overlay) and anything that doesn't render.
const keepLive = (el: Element) => el.hasAttribute("aria-live") || el.localName.startsWith("next") || ["script", "style", "link", "template", "noscript"].includes(el.localName);

function pushLayer(root: HTMLElement, panel: HTMLElement | null): Layer {
  const layer: Layer = { root, panel, inerted: [] };
  // Only what is on the page now: a popover this layer opens later (portaled to <body>) stays usable.
  for (const el of document.body.children) {
    if (el === root || el.contains(root) || el.hasAttribute("inert") || keepLive(el)) continue;
    el.setAttribute("inert", "");
    layer.inerted.push(el);
  }
  layers.push(layer);
  if (layers.length === 1) window.addEventListener("keydown", trapTab);
  return layer;
}

function popLayer(layer: Layer) {
  const i = layers.indexOf(layer);
  if (i < 0) return;
  layers.splice(i, 1);
  // Closed out of order (a sheet under a still-open confirmation): the layer above takes over keeping them inert.
  const above = layers[i];
  if (above) above.inerted.push(...layer.inerted);
  else for (const el of layer.inerted) el.removeAttribute("inert");
  if (!layers.length) window.removeEventListener("keydown", trapTab);
}

// Bubble phase on window: a field that handles Tab itself (and prevents the default) wins.
function trapTab(e: KeyboardEvent) {
  const top = layers[layers.length - 1];
  if (e.key !== "Tab" || e.defaultPrevented || !top) return;
  const a = document.activeElement;
  if (a && a !== document.body && !top.root.contains(a) && !a.closest("[inert]")) return; // in a popover the layer opened
  const items = focusables(top.root);
  let to: HTMLElement | undefined;
  if (!items.length) to = top.panel ?? top.root;
  else if (!a || !top.root.contains(a)) to = e.shiftKey ? items[items.length - 1] : items[0];
  else {
    const follows = (el: HTMLElement) => !!(a.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (e.shiftKey && !items.some((el) => el !== a && !follows(el))) to = items[items.length - 1];
    else if (!e.shiftKey && !items.some(follows)) to = items[0];
  }
  if (to) {
    e.preventDefault();
    to.focus();
  }
}

// The overlay's root element: registers the layer while present, moves focus in, and gives it back on close.
// Non-modal (`modal={false}`, the map's resource panel on desktop): the page stays live — no inert, no Tab trap, no
// scrim — but focus still moves in on open and returns to the opener on close.
// Escape closes the top modal layer only (F40): one press, one layer. A handler that already acted on the key (and
// called preventDefault) wins; a panel under a modal never sees the press.
function LayerRoot({ present, panel, modal = true, onEscape, className, children }: { present: boolean; panel?: RefObject<HTMLElement | null>; modal?: boolean; onEscape?: () => void; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Read while rendering, before this commit's autoFocus moves focus into the overlay.
  const [opener] = useState(() => document.activeElement);
  const initial = useRef<HTMLElement | null>(null);
  const escape = useRef(onEscape);
  useLayoutEffect(() => {
    escape.current = onEscape;
  });
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !present) return;
    root.inert = false;
    const layer = modal ? pushLayer(root, panel?.current ?? null) : null;
    if (!root.contains(document.activeElement)) {
      // A child's autoFocus has already run; otherwise data-autofocus, the first control, or the panel itself.
      // `initial` brings focus back to the same element when the effect re-runs (Strict Mode, Fast Refresh).
      const again = initial.current?.isConnected && root.contains(initial.current) ? initial.current : null;
      const target = again ?? root.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(root)[0] ?? panel?.current ?? root;
      target.focus({ preventScroll: true }); // the panel is still sliding in: never scroll for it
    }
    const a = document.activeElement;
    initial.current = a instanceof HTMLElement && root.contains(a) ? a : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !layer || layers[layers.length - 1] !== layer || !escape.current) return;
      e.preventDefault();
      escape.current();
    };
    if (layer) window.addEventListener("keydown", onKey);
    return () => {
      if (layer) {
        window.removeEventListener("keydown", onKey);
        popLayer(layer);
      }
      root.inert = true; // leaving: while it animates out it takes no focus (clicks already fall through)
      const now = document.activeElement;
      if (now && now !== document.body && !root.contains(now)) return; // the user already moved on
      // Back to the opener when it is still there and live; else into the overlay that is now on top.
      const top = layers[layers.length - 1];
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]") && (!top || top.root.contains(opener))) opener.focus({ preventScroll: true });
      else if (top) (top.panel ?? top.root).focus({ preventScroll: true });
    };
  }, [present, panel, opener, modal]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

// Full-viewport layer with a scrim. Must be the direct child of <AnimatePresence>. While exiting,
// clicks fall through to the page, so closing never blocks the next action. `panel` is the dialog element,
// focused when it holds nothing focusable. `modal={false}`: no scrim, and only the panel takes pointer events
// (give it `pointer-events-auto`), so the page under it keeps working.
export function Overlay({ onClose, z, className, panel, modal = true, children }: { onClose?: () => void; z: string; className?: string; panel?: RefObject<HTMLElement | null>; modal?: boolean; children: ReactNode }) {
  const present = useIsPresent();
  return (
    <Portal>
      <LayerRoot present={present} panel={panel} modal={modal} onEscape={onClose} className={clsx("fixed inset-0", z, className, (!present || !modal) && "pointer-events-none")}>
        {modal && <Scrim onClick={onClose} />}
        {children}
      </LayerRoot>
    </Portal>
  );
}

// Side sheet: the scrim fades in with its blur, the sheet drifts in from 28px and settles. `modal={false}`: no scrim
// and the page stays usable beside it (role dialog without aria-modal); the sheet handles its own Escape.
export function Sheet({ onClose, children, className, style, z = "z-50", as = "section", side = "right", modal = true, ...aria }: {
  onClose(): void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  z?: string;
  as?: "section" | "aside";
  side?: "left" | "right";
  modal?: boolean;
  role?: string;
  "aria-label"?: string;
}) {
  const M = as === "aside" ? motion.aside : motion.section;
  const panel = useRef<HTMLElement>(null);
  return (
    <Overlay onClose={onClose} z={z} panel={panel} modal={modal} className={clsx("flex", side === "right" ? "justify-end" : "justify-start")}>
      <M ref={panel} tabIndex={-1} {...(side === "right" ? sheet : sheetLeft)} {...aria} style={{ ...style, originX: side === "right" ? 1 : 0 }} className={clsx("relative outline-none", !modal && "pointer-events-auto", className)}>
        {children}
      </M>
    </Overlay>
  );
}

// A dialog: centred on larger screens, a bottom sheet on phones that can be dragged down by its handle to
// dismiss. Must be the direct child of <AnimatePresence>. `className` styles the panel (width, padding).
export function Modal({ onClose, z = "z-[90]", align = "center", className, children, ...aria }: {
  onClose?: () => void;
  z?: string;
  align?: "center" | "top";
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const phone = usePhone();
  const drag = useDragControls();
  const panel = useRef<HTMLDivElement>(null);
  return (
    <Overlay onClose={onClose} z={z} panel={panel} className={clsx("flex justify-center", phone ? "items-end" : align === "top" ? "items-start p-4 pt-[12vh]" : "items-center p-4")}>
      <motion.div
        ref={panel}
        tabIndex={-1}
        {...(phone ? rise : pop)}
        {...aria}
        role="dialog"
        aria-modal
        drag={phone && onClose ? "y" : false}
        dragListener={false}
        dragControls={drag}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.7 }}
        onDragEnd={(_, i) => (i.offset.y > 96 || i.velocity.y > 640) && onClose?.()}
        className={clsx(
          "relative flex w-full flex-col overflow-hidden border border-line bg-panel shadow-float outline-none",
          phone ? "max-h-[90dvh] rounded-t-3xl border-b-0 pb-[env(safe-area-inset-bottom)]" : "max-h-[90vh] rounded-2xl",
          className,
        )}
      >
        {phone && (
          <div onPointerDown={(e) => drag.start(e)} className="flex flex-none cursor-grab touch-none justify-center pb-1 pt-2.5" aria-hidden>
            <span className="h-1 w-9 rounded-full bg-line-strong" />
          </div>
        )}
        {children}
      </motion.div>
    </Overlay>
  );
}

// Crossfades between states of one slot (skeleton → content) without a gap or a layout jump.
export function Swap({ id, children, className, bodyClassName }: { id: string; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <div className={clsx("relative", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div key={id} {...fade} className={bodyClassName}>
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ---------- data in / out ----------
const EMPTY: ReadonlySet<string> = new Set();
type Seen = { sig: string | null; prev: Set<string> | null; fresh: ReadonlySet<string>; gen: number };
// Tracks list keys across data snapshots. `fresh` = keys that arrived since the previous snapshot
// (never on first load). A wholesale change (nothing carried over, or > 12 new) is a different dataset,
// not arrivals: it bumps `gen` instead, so callers can crossfade the whole list (key a <Swap> on it).
export function useFresh(keys: readonly string[] | undefined): { fresh: ReadonlySet<string>; gen: number } {
  const sig = keys ? keys.join("\u0001") : null;
  const [s, setS] = useState<Seen>({ sig: null, prev: null, fresh: EMPTY, gen: 0 });
  if (keys && sig !== s.sig) {
    const added = s.prev ? keys.filter((k) => !s.prev!.has(k)) : [];
    const wholesale = !!s.prev && added.length > 0 && ((added.length === keys.length && s.prev.size > 0) || added.length > 12);
    setS({ sig, prev: new Set(keys), fresh: added.length && !wholesale ? new Set(added) : EMPTY, gen: s.gen + (wholesale ? 1 : 0) });
  }
  return s;
}

const ROW = { li: motion.li, div: motion.div, tr: motion.tr } as const;

// A list row that animates in and out. Fresh rows (new data) expand into place and flash an accent
// tint; rows present on first paint fade up with a light stagger. `still` renders a plain element
// (big tables). `className` styles the inner box so the height collapse never stops at padding.
export function Row({ as = "li", fresh = false, index = 0, still = false, className, children }: {
  as?: keyof typeof ROW;
  fresh?: boolean;
  index?: number;
  still?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [arrived] = useState(fresh); // decided once, at mount
  if (still) {
    const Tag = as;
    return <Tag className={className}>{children}</Tag>;
  }
  if (as === "tr") {
    // Table rows can't collapse their height: fade and nudge in, leave at once.
    return (
      <motion.tr
        initial={{ opacity: 0, y: arrived ? -4 : 3 }}
        animate={{ opacity: 1, y: 0, transition: { ...enter, delay: arrived ? 0 : Math.min(index, 10) * 0.02 } }}
        exit={{ opacity: 0, transition: { duration: 0 } }} // a fading row that can't collapse would linger, then snap
        className={clsx(className, arrived && "row-arrive")}
      >
        {children}
      </motion.tr>
    );
  }
  const M = ROW[as];
  return (
    <M
      initial={arrived ? { opacity: 0, y: -6, height: 0, overflowY: "clip" } : { opacity: 0, y: 4 }}
      animate={arrived ? { opacity: 1, y: 0, height: "auto", transition: enter, transitionEnd: { overflowY: "visible" } } : { opacity: 1, y: 0, transition: { ...enter, delay: Math.min(index, 10) * 0.02 } }}
      exit={{ opacity: 0, height: 0, overflowY: "clip", transition: exit }}
    >
      <div className={clsx(className, arrived && "row-arrive")}>{children}</div>
    </M>
  );
}

// ---------- numbers ----------
const decimals = (v: number) => (Number.isInteger(v) ? 0 : Math.min(3, String(v).split(".")[1]?.length ?? 0));
const fmt = (n: number, d: number) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

// Tweens to each new value (tabular digits, the target's precision). Writes the DOM directly so a
// tween never re-renders React; the first value renders as-is (no count-up on load).
export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  const reduce = useReducedMotion();
  const [first] = useState(() => fmt(value, decimals(value)));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const d = decimals(value);
    const from = shown.current;
    if (reduce || from === value || !Number.isFinite(from)) {
      shown.current = value;
      el.textContent = fmt(value, d);
      return;
    }
    const c = animate(from, value, {
      duration: 0.6,
      ease: EASE,
      onUpdate: (n) => {
        shown.current = n;
        el.textContent = fmt(n, d);
      },
    });
    return () => c.stop();
  }, [value, reduce]);
  return (
    <span ref={ref} className={clsx("tabular-nums", className)}>
      {first}
    </span>
  );
}

// ---------- state changes ----------
// Counts how many times `v` has changed since mount (0 = never), for one-shot change effects.
export function useChangeCount<T>(v: T) {
  const [s, setS] = useState({ v, n: 0 });
  if (!Object.is(s.v, v)) setS({ v, n: s.n + 1 });
  return s.n;
}
