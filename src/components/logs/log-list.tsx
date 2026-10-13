"use client";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, Crosshair, Loader2, X } from "lucide-react";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { clock } from "@/lib/client/format";
import { LEVELS, prettyLine, sniffLevel, type LogStore } from "@/lib/logstore";
import type { LogLine } from "@/lib/types";
import { CreateTicketButton, logTicket } from "../ticket-button";
import { sheet } from "../motion";
import { copy, cx } from "../ui";
import { useNarrow } from "./use-media";

// Fixed row heights keep virtualisation to arithmetic. Phones get a slightly larger font and row, and long lines
// scroll sideways inside the list (with time + level pinned) instead of being cut off.
const ROW = 20;
const ROW_NARROW = 22;
const OVERSCAN = 30;
const MAX_RENDER_CHARS = 1500; // a 1 MB log line must not become a 1 MB DOM text node

const LEVEL_CLASS = ["text-fg-3", "text-fg-3", "text-fg-3", "text-[var(--deploying)]", "text-degraded", "text-down", "text-down font-semibold"];

// Row times are the browser's local clock; the full stamp names its zone (F71): "Oct 05, 14:02:11.120 GMT+5:30".
const fullFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short" });
export const localStamp = (ms: number) => {
  const d = new Date(ms);
  return Number.isFinite(ms) ? fullFmt.format(d).replace(/(\d{2}:\d{2}:\d{2})/, `$1.${String(d.getMilliseconds()).padStart(3, "0")}`) : "—";
};
const LEVEL_TAG = ["   ", "TRC", "DBG", "INF", "WRN", "ERR", "FTL"];
export interface LogListHandle {
  shift(rows: number): void;
  toBottom(): void;
  scrollToRow(row: number): void;
}

export type ServiceTag = (stream: string) => { name: string; color: string } | null;
export type LoadContext = (stream: string, ts: number) => Promise<{ lines: LogLine[]; anchor: number }>;

interface Props {
  store: LogStore;
  version: number;
  follow: boolean;
  onFollowChange(f: boolean): void;
  highlight?: string;
  onReachTop?: () => void;
  showStream?: boolean;
  pretty?: boolean;
  empty?: React.ReactNode;
  highlightRe?: RegExp | null;
  serviceTag?: ServiceTag;
  loadContext?: LoadContext;
  activeRow?: number | null;
  env?: string; // live logs only: enables the Ticket button in the line drawer
}

// Selection tints are layered over the list background so a pinned (sticky) prefix stays opaque.
const SELECTED = "![background:linear-gradient(var(--log-sel),var(--log-sel)),var(--log-bg)]";
const MARKED = "![background:linear-gradient(var(--log-mark),var(--log-mark)),var(--log-bg)]";

const Row = memo(function Row({ store, i, top, height, narrow, re, showStream, pretty, selected, active, tag, onSelect }: { store: LogStore; i: number; top: number; height: number; narrow: boolean; re: RegExp | null; showStream: boolean; pretty: boolean; selected: boolean; active: boolean; tag?: ServiceTag; onSelect(i: number): void }) {
  const lvl = store.level[i];
  const raw = pretty ? prettyLine(store.msg[i]) : store.msg[i];
  const msg = raw.length > MAX_RENDER_CHARS ? `${raw.slice(0, MAX_RENDER_CHARS)} …(+${raw.length - MAX_RENDER_CHARS} chars)` : raw;
  let body: React.ReactNode = msg;
  if (re) {
    const parts = msg.split(re);
    body = parts.map((p, k) => (k % 2 ? <mark key={k} className="hl">{p}</mark> : p));
  }
  const stream = store.streams[store.stream[i]] ?? "";
  const t = tag?.(stream);
  const time = clock(store.ts[i]);
  return (
    <div
      className={cx("log-row flex cursor-default gap-3 bg-[var(--log-bg)] font-mono", narrow ? "pr-4 text-[13.5px]" : "px-3 text-[13px]", selected && SELECTED, active && MARKED)}
      // Narrow rows are as wide as their text (the list scrolls sideways), so they drop size containment.
      style={narrow ? { position: "absolute", top, left: 0, minWidth: "100%", height, lineHeight: `${height}px`, contain: "layout style", overflow: "visible" } : { position: "absolute", top, left: 0, right: 0 }}
      onClick={() => onSelect(i)}
    >
      <span className={cx("flex flex-none select-none gap-3", narrow && "sticky left-0 z-[1] pl-3 pr-1 [background:inherit]")}>
        <span className="text-fg-3 tabular-nums" title={localStamp(store.ts[i])}>{narrow ? time.split(".")[0] : time}</span>
        <span className={cx("w-7", LEVEL_CLASS[lvl])}>{LEVEL_TAG[lvl]}</span>
      </span>
      {showStream &&
        (t ? (
          <span className={cx("flex-none select-none truncate", narrow ? "w-16" : "w-24")} title={stream} style={{ color: t.color }}>{t.name}</span>
        ) : (
          <span className="w-16 flex-none select-none truncate text-fg-3" title={stream}>{stream.split("/").pop()?.slice(0, 8)}</span>
        ))}
      <span className={cx(narrow ? "flex-none" : "min-w-0 flex-1 truncate", lvl >= 5 ? "text-down" : lvl === 4 ? "text-degraded" : "text-fg")}>{body}</span>
    </div>
  );
});

export const LogList = forwardRef<LogListHandle, Props>(function LogList({ store, version, follow, onFollowChange, highlight, onReachTop, showStream = true, pretty = false, empty, highlightRe, serviceTag, loadContext, activeRow = null, env }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  const rowH = narrow ? ROW_NARROW : ROW;
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [selected, setSelected] = useState<number | null>(null);
  const lastDropped = useRef(store.dropped);
  const raf = useRef(0);
  const programmatic = useRef(false);

  useImperativeHandle(ref, () => ({
    shift(rows) {
      const el = box.current;
      if (el && rows) {
        programmatic.current = true;
        el.scrollTop += rows * rowH;
      }
    },
    toBottom() {
      const el = box.current;
      if (el) {
        programmatic.current = true;
        el.scrollTop = el.scrollHeight;
      }
    },
    scrollToRow(row) {
      const el = box.current;
      if (!el) return;
      programmatic.current = true;
      el.scrollTop = Math.max(0, row * rowH - el.clientHeight / 2 + rowH);
    },
  }));

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setHeight(e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // After each batch: stick to the bottom when following; otherwise keep the same lines on screen when old ones were trimmed.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const dropped = store.dropped - lastDropped.current;
    lastDropped.current = store.dropped;
    if (follow) {
      programmatic.current = true;
      el.scrollTop = el.scrollHeight;
    } else if (dropped > 0) {
      programmatic.current = true;
      el.scrollTop = Math.max(0, el.scrollTop - dropped * rowH);
    }
    if (selected !== null && dropped > 0) setSelected((s) => (s === null || s - dropped < 0 ? null : s - dropped));
  }, [version, follow, store, selected, rowH]);

  const onScroll = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      setScrollTop(el.scrollTop);
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < rowH * 2;
      if (programmatic.current) {
        programmatic.current = false;
      } else if (atBottom !== follow) {
        onFollowChange(atBottom);
      }
      if (el.scrollTop < rowH * 10) onReachTop?.();
    });
  }, [follow, onFollowChange, onReachTop, rowH]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const select = useCallback((x: number) => setSelected(x), []);
  const count = store.visibleCount;
  // Clamp to the current content: when a filter or reset shrinks the list, the browser's scroll event (and so
  // `scrollTop`) lags a frame behind, and an unclamped window would render nothing for that frame.
  const top = Math.min(scrollTop, Math.max(0, count * rowH - height));
  const start = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
  const end = Math.min(count, Math.ceil((top + height) / rowH) + OVERSCAN);
  const re = highlightRe ?? (highlight && highlight.trim() ? new RegExp(`(${highlight.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i") : null);
  const rows: React.ReactNode[] = [];
  for (let r = start; r < end; r++) {
    const i = store.lineAt(r);
    rows.push(<Row key={store.dropped + i} store={store} i={i} top={r * rowH} height={rowH} narrow={narrow} re={re} showStream={showStream} pretty={pretty} selected={selected === i} active={activeRow === r} tag={serviceTag} onSelect={select} />);
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <div ref={box} onScroll={onScroll} className={cx("relative min-h-0 flex-1 overflow-y-auto bg-[var(--log-bg)]", narrow ? "overflow-x-auto overscroll-x-contain" : "overflow-x-hidden")} style={{ overflowAnchor: "none" }} tabIndex={0} aria-label="log lines">
        <div style={{ height: count * rowH, position: "relative" }}>{rows}</div>
        {count === 0 && <div className="absolute inset-0 grid place-items-center">{empty}</div>}
      </div>
      <AnimatePresence>{selected !== null && store.msg[selected] !== undefined && <LineDrawer key="drawer" store={store} i={selected} loadContext={loadContext} env={env} onClose={() => setSelected(null)} />}</AnimatePresence>
    </div>
  );
});

function LineDrawer({ store, i, onClose, loadContext, env }: { store: LogStore; i: number; onClose(): void; loadContext?: LoadContext; env?: string }) {
  const msg = store.msg[i];
  const stream = store.streams[store.stream[i]] ?? "";
  const [copied, setCopied] = useState(false);
  const [ctx, setCtx] = useState<{ lines: LogLine[]; anchor: number } | "loading" | { error: string } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ctx && typeof ctx === "object" && "lines" in ctx) anchorRef.current?.scrollIntoView({ block: "center" });
  }, [ctx]);
  let pretty: string | null = null;
  const t = msg.trim();
  if (t.startsWith("{") && t.length < 500_000) {
    try {
      pretty = JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      pretty = null;
    }
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    // Covers the whole list on phones; a side panel over the right of it from `md`.
    <motion.aside {...sheet} aria-label="Log line" className="absolute inset-y-0 right-0 z-20 flex w-full flex-col border-line bg-panel shadow-float md:w-[min(560px,90%)] md:border-l">
      <div className="flex items-center justify-between gap-2 border-b border-line py-2 pl-4 pr-2">
        <div className="min-w-0 text-xs">
          <div className="font-medium">{localStamp(store.ts[i])}</div>
          <div className="text-fg-3">{new Date(store.ts[i]).toISOString().replace("T", " ").replace("Z", " UTC")}</div>
          <div className="truncate font-mono text-fg-3">{LEVELS[store.level[i]] || "line"} · {store.streams[store.stream[i]]}</div>
        </div>
        <div className="flex flex-none items-center gap-1">
          {loadContext && (
            <button
              className="press inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-fg-2 hover:bg-panel-3 pointer-coarse:h-10"
              title="±100 lines around this one in its stream"
              onClick={async () => {
                setCtx("loading");
                try {
                  setCtx(await loadContext(stream, store.ts[i]));
                } catch (e) {
                  setCtx({ error: (e as Error).message });
                }
              }}
            >
              <Crosshair className="size-3.5" /> context
            </button>
          )}
          {env && <CreateTicketButton {...logTicket(msg, store.ts[i], stream, env)} env={env} target={stream.split("/")[1]} variant="ghost" className="!text-[12px]" />}
          <button
            className="press grid size-7 place-items-center rounded-md text-fg-2 hover:bg-panel-3 pointer-coarse:size-10"
            aria-label="Copy line"
            onClick={() => {
              copy(msg);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? <Check className="size-3.5 text-up" /> : <Copy className="size-3.5" />}
          </button>
          <button className="press grid size-7 place-items-center rounded-md text-fg-2 hover:bg-panel-3 pointer-coarse:size-10" onClick={onClose} aria-label="Close">
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      {ctx === null ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-[13px] leading-relaxed text-fg">{pretty ?? msg}</pre>
      ) : ctx === "loading" ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-fg-3"><Loader2 className="size-3.5 animate-spin" /> loading context…</div>
      ) : "error" in ctx ? (
        <div className="p-4 text-xs text-down">{ctx.error}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[12.5px]">
          {ctx.lines.map(([ts, , m], k) => {
            const lvl = sniffLevel(m);
            return (
              <div key={k} ref={k === ctx.anchor ? anchorRef : undefined} className={cx("flex gap-2 whitespace-pre-wrap break-all px-3 py-0.5", k === ctx.anchor ? "bg-[var(--log-mark)]" : "hover:bg-[var(--log-row-hover)]", lvl >= 5 ? "text-down" : lvl === 4 ? "text-degraded" : "text-fg-2")}>
                <span className="flex-none text-fg-3">{clock(ts)}</span>
                <span>{prettyLine(m)}</span>
              </div>
            );
          })}
        </div>
      )}
    </motion.aside>
  );
}
