"use client";
// The console's dropdown, in place of the browser's: a trigger that looks like the console's other fields (or whatever
// the caller puts in it, for pills), opening an animated menu on larger screens and a bottom sheet on phones. A
// highlight glides to the option under the pointer or the keys; the chosen one carries a check.
// Keys as a native select: arrows, Home/End, Page Up/Down, typing to jump (the same letter again cycles), Enter or
// Space to choose, Esc to close. ARIA: a select-only combobox; the trigger keeps focus and points at the active option
// (aria-activedescendant). The arithmetic (stepping, typeahead, placement) is in src/lib/select-rules.ts.
import { Check, ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Children, Fragment, isValidElement, useEffect, useId, useRef, useState, type FocusEventHandler, type KeyboardEvent, type ReactNode } from "react";
import { firstEnabled, lastEnabled, placeMenu, step, typeaheadMatch, type MenuPlace } from "@/lib/select-rules";
import { Modal, Portal, popover, springFast, usePhone } from "./motion";
import { cx } from "./ui";

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  text?: string; // plain text for typing to jump, when the label isn't a string
  hint?: ReactNode; // muted, after the label
  icon?: ReactNode; // before the label, in the list and on the trigger
  disabled?: boolean;
  group?: string; // a heading over consecutive options that share it
}

// For a caller that keeps writing <option> (and <optgroup>) elements: their value, content and disabled flag, and the
// group's label, as options.
export function optionsFrom(children: ReactNode, group?: string): SelectOption[] {
  const out: SelectOption[] = [];
  Children.forEach(children, (n) => {
    if (!isValidElement(n)) return;
    const p = n.props as { value?: string | number; children?: ReactNode; disabled?: boolean; label?: string };
    if (n.type === "optgroup") out.push(...optionsFrom(p.children, p.label));
    else if (n.type === Fragment) out.push(...optionsFrom(p.children, group));
    else if (n.type === "option") out.push({ value: String(p.value ?? ""), label: p.children, text: textOf(p.children), disabled: p.disabled, group });
  });
  return out;
}
const textOf = (n: ReactNode): string =>
  typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : isValidElement(n) ? textOf((n.props as { children?: ReactNode }).children) : "";

// The look of the console's form fields; callers add width or height (or replace it entirely with their own pill).
export const SELECT_FIELD =
  "flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 text-left text-[14px] text-fg outline-none transition-[border-color,box-shadow] duration-200 hover:border-line-strong focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:h-10";

export function Select<V extends string>({ value, onChange, options, placeholder = "Choose…", disabled, base = SELECT_FIELD, className, children, mono, title, id, ...aria }: {
  value: string;
  onChange: (v: V) => void;
  options: readonly SelectOption<V>[];
  placeholder?: ReactNode; // shown when no option has the value
  disabled?: boolean;
  base?: string; // the trigger's look (SELECT_FIELD); a caller's own field style replaces it
  className?: string; // added to `base`, or all the trigger's classes when `children` draws it
  children?: ReactNode | ((open: boolean) => ReactNode); // a custom trigger (pills); gets whether the menu is open
  mono?: boolean;
  title?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  onBlur?: FocusEventHandler<HTMLButtonElement>;
  autoFocus?: boolean;
}) {
  const phone = usePhone();
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-o${i}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ q: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<MenuPlace | null>(null);
  const [active, setActive] = useState(-1);
  const off = options.map((o) => !!o.disabled);
  const texts = options.map((o) => o.text ?? (typeof o.label === "string" ? o.label : o.value));
  const sel = options.findIndex((o) => o.value === value);
  const cur = sel >= 0 ? options[sel] : undefined;

  const show = (at: number) => {
    if (disabled || !options.length) return;
    setActive(at >= 0 && !off[at] ? at : firstEnabled(off));
    const headings = new Set(options.map((o) => o.group).filter(Boolean)).size;
    setPlace(placeMenu(trigger.current!.getBoundingClientRect(), { width: innerWidth, height: innerHeight }, options.length + headings));
    setOpen(true);
  };
  const hide = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    hide();
    if (o.value !== value) onChange(o.value);
  };
  // Typing within 600 ms extends the search (timed by the key events themselves).
  const jump = (e: KeyboardEvent) => {
    const q = e.timeStamp - typed.current.at < 600 ? typed.current.q + e.key : e.key;
    typed.current = { q, at: e.timeStamp };
    return typeaheadMatch(texts, off, open ? active : sel, q);
  };
  const printable = (e: KeyboardEvent) => e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;

  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (!open) {
      if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") {
        e.preventDefault();
        show(k === "ArrowUp" && sel < 0 ? lastEnabled(off) : sel);
      } else if (printable(e)) {
        const i = jump(e);
        if (i >= 0) show(i);
      }
      return;
    }
    const move = (to: number) => {
      e.preventDefault();
      setActive(to);
    };
    if (k === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hide();
    } else if (k === "Tab") hide(false);
    else if (k === "ArrowDown") move(step(off, active, 1));
    else if (k === "ArrowUp") move(step(off, active, -1));
    else if (k === "PageDown") move(step(off, active, 1, 8));
    else if (k === "PageUp") move(step(off, active, -1, 8));
    else if (k === "Home") move(firstEnabled(off));
    else if (k === "End") move(lastEnabled(off));
    else if (k === "Enter" || (k === " " && e.timeStamp - typed.current.at > 600)) {
      e.preventDefault();
      choose(active);
    } else if (printable(e)) {
      const i = jump(e);
      if (i >= 0) move(i);
    }
  };

  // The anchored menu closes on a press outside it, on scrolling anything else and on resizing; the phone sheet has
  // its own scrim and Esc.
  useEffect(() => {
    if (!open || phone) return;
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const scroll = (e: Event) => !list.current?.contains(e.target as Node) && setOpen(false);
    const resize = () => setOpen(false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [open, phone]);

  useEffect(() => {
    if (!open) return;
    if (phone) requestAnimationFrame(() => list.current?.focus({ preventScroll: true }));
    if (active >= 0) document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optId only reads the stable useId value
  }, [open, active, phone]);

  const rows = (big: boolean) => {
    let group: string | undefined;
    return options.map((o, i) => {
      const heading = o.group && o.group !== group ? o.group : undefined;
      group = o.group;
      return (
        <Fragment key={`${o.value}\u0000${i}`}>
          {heading && <div role="presentation" className="px-2.5 pb-1 pt-2.5 text-[11.5px] font-semibold uppercase tracking-wide text-fg-3 first:pt-1">{heading}</div>}
          <div
            id={optId(i)}
            role="option"
            aria-selected={i === sel}
            aria-disabled={o.disabled || undefined}
            onPointerMove={() => !o.disabled && active !== i && setActive(i)}
            onClick={() => choose(i)}
            className={cx(
              "relative flex select-none items-center gap-2 rounded-lg px-2.5",
              big ? "py-3 text-[16px]" : "py-1.5 text-[14px]",
              o.disabled ? "cursor-not-allowed text-fg-3 opacity-60" : "cursor-pointer text-fg",
              mono && "font-mono text-[13px]",
            )}
          >
            {i === active && !o.disabled && <motion.span layoutId={`${uid}-hl`} transition={springFast} className="absolute inset-0 -z-10 rounded-lg bg-panel-3" />}
            {o.icon}
            <span className="min-w-0 flex-1 truncate">
              {o.label}
              {o.hint ? <span className="ml-1.5 text-fg-3">{o.hint}</span> : null}
            </span>
            <Check className={cx("size-4 flex-none text-accent transition-opacity", i === sel ? "opacity-100" : "opacity-0")} aria-hidden />
          </div>
        </Fragment>
      );
    });
  };

  const label = aria["aria-label"];
  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={id}
        title={title}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !phone && active >= 0 ? optId(active) : undefined}
        {...aria}
        onClick={() => (open ? hide() : show(sel))}
        onKeyDown={onKey}
        className={children ? className : cx("flex min-w-0 items-center gap-2 text-left", base, mono && "font-mono text-[13px]", className)}
      >
        {children ? (typeof children === "function" ? children(open) : children) : (
          <>
            {cur?.icon}
            <span className={cx("min-w-0 flex-1 truncate", !cur && "text-fg-3")}>{cur ? cur.label : placeholder}</span>
            <ChevronDown className={cx("size-4 flex-none text-fg-3 transition-transform duration-200", open && "rotate-180")} aria-hidden />
          </>
        )}
      </button>
      {phone ? (
        <AnimatePresence>
          {open && (
            <Modal onClose={() => hide()} aria-label={label ?? "Choose an option"}>
              {label && <div className="px-5 pb-1 text-[13px] font-medium text-fg-3">{label}</div>}
              <div
                ref={list}
                id={listId}
                role="listbox"
                aria-label={label}
                tabIndex={0}
                aria-activedescendant={active >= 0 ? optId(active) : undefined}
                onKeyDown={onKey}
                className="relative isolate min-h-0 overflow-y-auto overscroll-contain px-2 pb-3 outline-none"
              >
                {rows(true)}
              </div>
            </Modal>
          )}
        </AnimatePresence>
      ) : (
        <Portal>
          <AnimatePresence>
            {open && place && (
              <motion.div
                ref={list}
                id={listId}
                role="listbox"
                aria-label={label}
                {...popover}
                initial={{ opacity: 0, scale: 0.97, y: place.from === "top" ? -4 : 4 }}
                // Presses inside keep focus on the trigger, which owns the keys and points at the active option.
                onPointerDown={(e) => e.preventDefault()}
                style={{ left: place.left, top: place.top, bottom: place.bottom, minWidth: place.minWidth, maxHeight: place.maxHeight, transformOrigin: place.from === "top" ? "top left" : "bottom left" }}
                className="fixed isolate z-[100] max-w-[min(28rem,calc(100vw-16px))] overflow-y-auto overscroll-contain rounded-xl border border-line bg-panel p-1 shadow-float"
              >
                {rows(false)}
              </motion.div>
            )}
          </AnimatePresence>
        </Portal>
      )}
    </>
  );
}
