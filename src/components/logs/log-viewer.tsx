"use client";
// Log explorer. One bounded buffer per mode; the query language filters or highlights whatever is loaded, in ~100ms
// even at 200k lines. Live tails any set of services merged by time; Search asks CloudWatch; Insights runs queries.
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, Loader2, Maximize2, Minimize2, PanelLeft, Pause, Play, Radio, ScanSearch, Search, SlidersHorizontal, Sparkles, Trash2, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getJson } from "@/lib/client/api";
import { zone } from "@/lib/client/format";
import { parseQuery } from "@/lib/logquery";
import { LogStore, type Level } from "@/lib/logstore";
import type { EnvName, LogLine, LogPage } from "@/lib/types";
import { Button, Chip, Segmented, cx } from "../ui";
import { LogList, type LoadContext, type LogListHandle, type ServiceTag } from "./log-list";
import { Facets, Histogram, InsightsPanel, MatchMode, QueryBar, type SavedLogQuery } from "./log-tools";
import { ROOMY, useMediaQuery, useNarrow } from "./use-media";
import { Select } from "@/components/select";

const POLL_MS = 2000;
const MAX_BACKOFF_MS = 15_000;
// Merged services are told apart by the design system's categorical series colours.
export const SERVICE_COLORS = Array.from({ length: 7 }, (_, i) => `var(--series-${i + 1})`);
const serviceOf = (stream: string) => stream.split("/")[1] ?? stream;

// Coalesce many store mutations into one render: next animation frame, or 150ms if frames are throttled
// (background tabs, hidden panes) — whichever comes first.
function useVersion() {
  const [v, setV] = useState(0);
  const pending = useRef<{ raf: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const bump = useCallback(() => {
    if (pending.current) return;
    const flush = () => {
      if (!pending.current) return;
      cancelAnimationFrame(pending.current.raf);
      clearTimeout(pending.current.timer);
      pending.current = null;
      setV((x) => x + 1);
    };
    pending.current = { raf: requestAnimationFrame(flush), timer: setTimeout(flush, 150) };
  }, []);
  useEffect(
    () => () => {
      if (pending.current) {
        cancelAnimationFrame(pending.current.raf);
        clearTimeout(pending.current.timer);
        pending.current = null; // otherwise a remount (StrictMode, fast refresh) leaves bump() stuck forever
      }
    },
    [],
  );
  return [v, bump] as const;
}

type Conn = "loading" | "live" | "paused" | "error";

// LogStore is a deliberately mutable buffer outside React state (200k lines must not be copied per batch).
function useTail(env: EnvName, services: string[], active: boolean, listRef: React.RefObject<LogListHandle | null>) {
  const store = useMemo(() => new LogStore(200_000), []);
  const [version, bump] = useVersion();
  const [conn, setConn] = useState<Conn>("loading");
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState(0);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The server follows at most LIMITS.logTailMaxStreams streams and says so (F26).
  const [streams, setStreams] = useState<{ tailed?: number; total?: number; note?: string }>({});
  const cursor = useRef<string | null>(null);
  const gen = useRef(0);
  const arrivals = useRef<{ t: number; n: number }[]>([]);
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  const key = services.join(",");

  useEffect(() => {
    if (!active || !key) return;
    let alive = true;
    gen.current++;
    const my = gen.current;
    store.reset();
    cursor.current = null;
    /* eslint-disable react-hooks/set-state-in-effect -- resetting UI state for the new polling target */
    setOlderCursor(null);
    setConn("loading");
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    bump();
    let timer: ReturnType<typeof setTimeout>;
    let delay = POLL_MS;
    const tick = async () => {
      if (!alive) return;
      if (document.hidden || pausedRef.current) {
        timer = setTimeout(tick, 1000);
        return;
      }
      try {
        const q = new URLSearchParams({ env, services: key, limit: cursor.current ? "10000" : "5000" });
        if (cursor.current) q.set("cursor", cursor.current);
        const page = await getJson<LogPage>(`/api/logs/tail?${q}`);
        if (!alive || my !== gen.current) return;
        const first = cursor.current === null;
        cursor.current = page.cursor;
        if (first) setOlderCursor(page.older);
        setStreams((s) => (s.tailed === page.streamsTailed && s.total === page.streamsTotal && s.note === page.note ? s : { tailed: page.streamsTailed, total: page.streamsTotal, note: page.note }));
        if (page.lines.length) {
          store.append(page.lines, page.streams);
          if (!first) arrivals.current.push({ t: Date.now(), n: page.lines.length });
          bump();
        }
        const cut = Date.now() - 10_000;
        arrivals.current = arrivals.current.filter((a) => a.t > cut);
        setRate(Math.round(arrivals.current.reduce((s, a) => s + a.n, 0) / 10));
        setConn("live");
        setError(null);
        delay = page.truncated ? 250 : POLL_MS;
      } catch (e) {
        if (!alive) return;
        setConn("error");
        setError((e as Error).message);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
      timer = setTimeout(tick, delay);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [env, key, active, store, bump]);

  const loadOlder = useCallback(async () => {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    const my = gen.current;
    try {
      const q = new URLSearchParams({ env, services: key, cursor: olderCursor, limit: "5000" });
      const page = await getJson<LogPage>(`/api/logs/older?${q}`);
      if (my !== gen.current) return;
      const n = store.prepend(page.lines, page.streams);
      setOlderCursor(n > 0 ? page.older : null);
      bump();
      requestAnimationFrame(() => listRef.current?.shift(n));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }, [olderCursor, loadingOlder, env, key, store, bump, listRef]);

  return { store, version, bump, conn: paused ? ("paused" as Conn) : conn, error, paused, setPaused, rate, loadOlder, hasOlder: !!olderCursor, loadingOlder, streams };
}

// Server-side results (CloudWatch search or Insights rows) land in their own buffer.
function useResults(env: EnvName, services: string[]) {
  const store = useMemo(() => new LogStore(200_000), []);
  const [version, bump] = useVersion();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState<{ q: string; mode: string; start: number; end: number; cursor: string } | null>(null);
  // What the last search covered: its window, the pages scanned so far and the server's note (F27).
  const [scan, setScan] = useState<{ minutes: number; pages: number; note?: string; done: boolean } | null>(null);
  const key = services.join(",");

  const search = useCallback(
    async (q: string, mode: string, minutes: number, cont?: typeof next) => {
      setBusy(true);
      setError(null);
      const end = cont?.end ?? Date.now();
      const start = cont?.start ?? end - minutes * 60_000;
      if (!cont) {
        store.reset();
        setScan(null);
        bump();
      }
      try {
        const p = new URLSearchParams({ env, services: key, q: cont?.q ?? q, mode: cont?.mode ?? mode, start: String(start), end: String(end) });
        if (cont?.cursor) p.set("cursor", cont.cursor);
        const page = await getJson<LogPage>(`/api/logs/search?${p}`);
        store.append(page.lines, page.streams);
        setNext(page.cursor ? { q: cont?.q ?? q, mode: cont?.mode ?? mode, start, end, cursor: page.cursor } : null);
        setScan((s) => ({ minutes: Math.round((end - start) / 60_000), pages: (cont ? (s?.pages ?? 0) : 0) + (page.scanned ?? 0), note: page.note, done: !page.cursor }));
        bump();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [env, key, store, bump],
  );

  const load = useCallback(
    (rows: { ts: number; msg: string; stream: string }[]) => {
      store.reset();
      const names = [...new Set(rows.map((r) => r.stream))];
      store.append(rows.map((r) => [r.ts, names.indexOf(r.stream), r.msg] as LogLine), names);
      setNext(null);
      setScan(null);
      bump();
    },
    [store, bump],
  );
  return { store, version, bump, busy, error, next, scan, search, load };
}

const RANGE_LABEL: Record<string, string> = { "15": "the last 15 minutes", "60": "the last hour", "360": "the last 6 hours", "1440": "the last 24 hours" };
const rangeLabel = (minutes: number) => RANGE_LABEL[String(minutes)] ?? `the last ${minutes} minutes`;
// The search form's windows; a saved query's minutes snap to the nearest.
const SEARCH_MINUTES = [15, 60, 360, 1440];
const snapSearch = (m: number | undefined) => String(SEARCH_MINUTES.reduce((a, b) => (Math.abs(b - (m ?? 60)) < Math.abs(a - (m ?? 60)) ? b : a), 60));

const LEVEL_OPTS = [
  { value: "0", label: "All" },
  { value: "3", label: "Info+" },
  { value: "4", label: "Warn+" },
  { value: "5", label: "Error" },
];

export function LogViewer({ env, services, compact, toolbarStart, className, initialQuery, initialMinutes, onQueryChange, onOpenSaved }: {
  env: EnvName; services: string[]; compact?: boolean; toolbarStart?: ReactNode; className?: string;
  initialQuery?: string; initialMinutes?: number; onQueryChange?(q: string): void;
  // A saved query for another environment or other services: the page switches to them (this viewer remounts).
  onOpenSaved?(q: SavedLogQuery): void;
}) {
  const [mode, setMode] = useState<"tail" | "search" | "insights">("tail");
  const [full, setFull] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [qmode, setQmode] = useState<"filter" | "highlight">("filter");
  const [minLevel, setMinLevel] = useState<Level>(0);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [pretty, setPretty] = useState(true);
  const narrow = useNarrow();
  const roomy = useMediaQuery(ROOMY);
  // null = the default for the screen: open beside the lines when there is room (and not compact), closed
  // otherwise. On phones the panel opens over the lines instead of beside them.
  const [facetsPref, setFacets] = useState<boolean | null>(null);
  const facets = facetsPref ?? (!compact && roomy);
  // Phones fold the view options (level, format, match mode, pause…) behind one toolbar button.
  const [options, setOptions] = useState(false);
  const [follow, setFollow] = useState(true);
  const [seen, setSeen] = useState(0);
  const [matchPos, setMatchPos] = useState<number | null>(null);
  const [srch, setSrch] = useState({ q: "", mode: "text", minutes: snapSearch(initialMinutes) });
  const listRef = useRef<LogListHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tail = useTail(env, services, mode === "tail", listRef);
  const results = useResults(env, services);
  const cur = mode === "tail" ? tail : results;
  const store = cur.store;
  const version = cur.version;
  const { store: tailStore, bump: tailBump } = tail;
  const { store: resStore, bump: resBump } = results;

  const parsed = useMemo(() => parseQuery(query), [query]);
  const compiled = parsed.ok ? parsed.q : null;
  useEffect(() => {
    if (!onQueryChange) return;
    const t = setTimeout(() => onQueryChange(query), 400);
    return () => clearTimeout(t);
  }, [query, onQueryChange]);

  // A saved query: here when it is for this view, otherwise the page moves to its environment and services.
  const openSaved = useCallback(
    (q: SavedLogQuery) => {
      const same = (!q.payload.env || q.payload.env === env) && (!q.payload.services?.length || q.payload.services.join(",") === services.join(","));
      if (!same && onOpenSaved) return onOpenSaved(q);
      setQuery(q.payload.query);
      setSrch((x) => ({ ...x, minutes: snapSearch(q.payload.minutes) }));
    },
    [env, services, onOpenSaved],
  );

  // Apply query + level + time window to both buffers (debounced so typing stays smooth on 200k lines).
  useEffect(() => {
    const t = setTimeout(() => {
      const qs = { q: compiled, minLevel, range, mode: qmode };
      tailStore.setQuery(qs);
      resStore.setQuery(qs);
      tailBump();
      resBump();
      setMatchPos(null);
    }, 120);
    return () => clearTimeout(t);
  }, [compiled, minLevel, range, qmode, tailStore, resStore, tailBump, resBump]);

  const multi = services.length > 1;
  const colors = useMemo(() => new Map(services.map((s, i) => [s, SERVICE_COLORS[i % SERVICE_COLORS.length]])), [services]);
  const serviceTag = useMemo<ServiceTag | undefined>(() => (multi ? (stream) => ({ name: serviceOf(stream), color: colors.get(serviceOf(stream)) ?? "var(--text-3)" }) : undefined), [multi, colors]);
  const loadContext = useCallback<LoadContext>(
    async (stream, ts) => {
      const svc = serviceOf(stream);
      const page = await getJson<LogPage & { anchor: number }>(`/api/logs/context?${new URLSearchParams({ env, service: services.includes(svc) ? svc : services[0], stream, ts: String(ts) })}`);
      return { lines: page.lines, anchor: page.anchor };
    },
    [env, services],
  );

  const total = store.visibleCount + store.dropped;
  const unseen = follow ? 0 : Math.max(0, total - seen);
  const onFollowChange = useCallback(
    (f: boolean) => {
      if (!f) setSeen(total);
      setFollow(f);
    },
    [total],
  );

  const nav = useCallback(
    (dir: 1 | -1) => {
      const rows = store.matchRows;
      if (!rows.length) return;
      const next = matchPos === null ? (dir === 1 ? 0 : rows.length - 1) : (matchPos + dir + rows.length) % rows.length;
      setMatchPos(next);
      setFollow(false);
      listRef.current?.scrollToRow(rows[next]);
    },
    [store, matchPos],
  );

  // Keyboard: "/" focuses the query, n / N jump between matches, f toggles follow.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && typeof t.closest === "function" && !!t.closest("input, textarea, select, [contenteditable]");
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "n") nav(1);
      else if (e.key === "N") nav(-1);
      else if (e.key === "f" && mode === "tail") {
        setFollow((f) => !f);
        listRef.current?.toBottom();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [nav, mode]);

  // Full screen: Esc leaves it, unless a line drawer is open (that Esc closes the drawer first).
  useEffect(() => {
    if (!full) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !root.current?.querySelector("aside") && !document.querySelector("[role=dialog][aria-modal]")) setFull(false);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [full]);

  const addTerm = useCallback((term: string) => setQuery((q) => (q.trim() ? `${q.trim()} ${term}` : term)), []);
  const activeRow = matchPos !== null ? (store.matchRows[matchPos] ?? null) : null;

  // A dot on the phone options button says a folded-away option is changing what the list shows.
  const customised = minLevel > 0 || !pretty || qmode === "highlight" || (mode === "tail" && tail.paused);

  return (
    <div
      ref={root}
      className={cx(
        "flex min-h-0 flex-col overflow-hidden border border-line bg-panel",
        full
          ? "fixed inset-0 z-[60] rounded-none border-0 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]"
          : cx("rounded-2xl", compact ? "h-full min-h-[520px]" : "h-full", className),
      )}
    >
      {/* Row 1. Phones: source · mode · options · full screen, then the query on its own line. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-2.5 py-2 md:px-3">
        {toolbarStart}
        <Segmented
          id={`logmode-${services.join("-")}`}
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "tail", label: <ModeLabel icon={<Radio className="size-3" />} label="Live" /> },
            { value: "search", label: <ModeLabel icon={<Search className="size-3" />} label="Search" /> },
            { value: "insights", label: <ModeLabel icon={<Sparkles className="size-3" />} label="Insights" /> },
          ]}
        />
        <QueryBar
          className="max-md:order-last max-md:basis-full"
          value={query}
          onChange={setQuery}
          error={parsed.ok ? null : parsed.error}
          inputRef={inputRef}
          count={store.matchRows.length}
          onNav={nav}
          matchPos={matchPos}
          mode={qmode}
          onMode={setQmode}
          saveContext={{ env, services, minutes: Number(srch.minutes) }}
          onOpenSaved={openSaved}
        />
        <Button size="sm" variant="ghost" onClick={() => setOptions((o) => !o)} aria-expanded={options} aria-label="View options" title="View options" className={cx("relative ml-auto md:hidden", options && "bg-panel-3 text-fg")}>
          <SlidersHorizontal className="size-3.5" />
          {customised && !options && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" aria-hidden />}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setFull((f) => !f)} title={full ? "Exit full screen (Esc)" : "Full screen"} aria-label={full ? "Exit full screen" : "Full screen"}>
          {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
      </div>

      {/* Row 2. Wide screens: always shown. Phones: the options fold open under the toolbar button; the Search
          form stays visible because it is the whole point of that mode. */}
      <div className={cx("flex flex-wrap items-center gap-2 border-b border-line px-2.5 py-1.5 md:px-3", !options && mode !== "search" && "max-md:hidden")}>
        <div className={cx("flex-wrap items-center gap-2 md:contents", options ? "flex w-full max-md:py-1" : "hidden")}>
          <Button size="sm" variant="ghost" onClick={() => setFacets(!facets)} aria-pressed={facets} className={facets ? "text-accent" : ""} title="Field facets" aria-label="Field facets">
            <PanelLeft className="size-3.5" />
            <span className="md:hidden">Facets</span>
          </Button>
          <MatchMode value={qmode} onChange={setQmode} className="md:hidden" />
          {mode === "tail" && (
            // Phones: beside Facets on the first line; wide screens: at the end of the row.
            <div className="ml-auto flex items-center gap-1 md:order-last">
              <Button size="sm" variant="ghost" onClick={() => tail.setPaused(!tail.paused)} title={tail.paused ? "Resume" : "Pause"} aria-label={tail.paused ? "Resume" : "Pause"}>
                {tail.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Clear view"
                aria-label="Clear view"
                onClick={() => {
                  tail.store.clear();
                  tail.bump();
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          )}
          <Segmented id={`lvl-${services.join("-")}`} size="sm" value={String(minLevel)} onChange={(v) => setMinLevel(Number(v) as Level)} options={LEVEL_OPTS} />
          <Segmented id={`fmt-${services.join("-")}`} size="sm" value={pretty ? "pretty" : "raw"} onChange={(v) => setPretty(v === "pretty")} options={[{ value: "pretty", label: "Pretty" }, { value: "raw", label: "Raw" }]} />
        </div>
        {mode === "search" && (
          <form
            className="flex w-full flex-wrap items-center gap-1.5 md:w-auto md:flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              results.search(srch.q, srch.mode, Number(srch.minutes));
            }}
          >
            <Select
              value={srch.mode}
              onChange={(v) => setSrch({ ...srch, mode: v })}
              aria-label="Search type"
              base={FIELD}
              title="Text = literal match · Pattern = CloudWatch filter pattern syntax"
              options={[
                { value: "text", label: "Text" },
                { value: "pattern", label: "CloudWatch pattern" },
              ]}
            />
            <input
              value={srch.q}
              onChange={(e) => setSrch({ ...srch, q: e.target.value })}
              aria-label="Search CloudWatch"
              placeholder={srch.mode === "pattern" ? '{ $.level >= 50 }   ?ERROR ?WARN   "slow query" -health' : "exact text to find in CloudWatch"}
              className={cx(FIELD, "min-w-0 font-mono max-md:order-first max-md:basis-full md:min-w-[220px] md:flex-1")}
            />
            <Select
              value={srch.minutes}
              onChange={(v) => setSrch({ ...srch, minutes: v })}
              aria-label="Time range"
              base={FIELD}
              options={[
                { value: "15", label: "15 min" },
                { value: "60", label: "1 hour" },
                { value: "360", label: "6 hours" },
                { value: "1440", label: "24 hours" },
              ]}
            />
            <Button size="sm" variant="primary" disabled={results.busy} className="max-md:ml-auto max-md:min-w-24">
              {results.busy ? <Loader2 className="size-3 animate-spin" /> : "Search"}
            </Button>
          </form>
        )}
      </div>

      {mode === "insights" && <InsightsPanel env={env} services={services} onLines={results.load} />}
      <Histogram store={store} version={version} range={range} onRange={setRange} height={compact || narrow ? 36 : 52} />

      <div className="relative flex min-h-0 flex-1">
        {facets && (
          <Facets
            store={store}
            version={version}
            serviceOf={serviceOf}
            className={narrow ? "absolute inset-y-0 left-0 z-20 w-[min(300px,86%)] bg-panel shadow-float" : undefined}
            onClose={narrow ? () => setFacets(false) : undefined}
            onAdd={(term) => {
              addTerm(term);
              if (narrow) setFacets(false); // show the filtered lines right away
            }}
          />
        )}
        <LogList
          ref={listRef}
          store={store}
          version={version}
          follow={mode === "tail" && follow}
          onFollowChange={onFollowChange}
          highlightRe={compiled?.highlight ?? null}
          pretty={pretty}
          serviceTag={serviceTag}
          loadContext={loadContext}
          env={env}
          activeRow={activeRow}
          onReachTop={mode === "tail" && tail.hasOlder ? tail.loadOlder : undefined}
          empty={
            mode === "tail" ? (
              tail.conn === "loading" ? <span className="flex items-center gap-2 text-xs text-fg-3"><Loader2 className="size-3.5 animate-spin" />loading latest lines…</span> : <span className="max-w-xs px-4 text-center text-xs text-fg-3">{query || minLevel || range ? "no loaded line matches — try Highlight mode, widen the window, or Search CloudWatch" : "no log lines yet"}</span>
            ) : mode === "search" && !results.busy && !results.error && results.scan && store.size === 0 ? (
              <SearchEmpty
                scan={results.scan}
                next={!!results.next}
                onContinue={() => results.search(srch.q, srch.mode, Number(srch.minutes), results.next)}
                onInsights={() => setMode("insights")}
              />
            ) : (
              <span className="max-w-xs px-4 text-center text-xs text-fg-3">{results.busy ? "searching…" : results.error ?? (mode === "search" ? "search CloudWatch over a time range" : "run an Insights query")}</span>
            )
          }
        />
        <AnimatePresence>
          {unseen > 0 && mode === "tail" && (
            <motion.button
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              onClick={() => {
                setFollow(true);
                listRef.current?.toBottom();
              }}
              className="press absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-fg shadow-float hover:bg-primary-hover pointer-coarse:py-2.5"
            >
              <ArrowDown className="size-3.5" /> {unseen.toLocaleString()} new line{unseen === 1 ? "" : "s"}
            </motion.button>
          )}
        </AnimatePresence>
        {mode === "tail" && tail.loadingOlder && (
          <div className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1 text-xs text-fg-2 shadow-card">
            <Loader2 className="size-3 animate-spin" /> loading older lines
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-[12px] text-fg-3">
        {mode === "tail" ? (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              {tail.conn === "live" && <span className="dot !size-1.5" data-anim="pulse" style={{ "--dot": "var(--up)" } as React.CSSProperties} />}
              {tail.conn === "error" && <WifiOff className="size-3 flex-none text-down" />}
              {tail.conn === "loading" && <Loader2 className="size-3 animate-spin" />}
              {tail.conn === "paused" && <Pause className="size-3" />}
              {tail.conn === "error" ? <span className="truncate text-down">{tail.error} — retrying</span> : tail.conn}
            </span>
            <span className="tabular-nums">{tail.rate.toLocaleString()} lines/s</span>
            {tail.streams.total !== undefined && tail.streams.tailed !== undefined && tail.streams.tailed < tail.streams.total && (
              <Chip tone="warn">
                <span title={tail.streams.note}>{tail.streams.tailed} of {tail.streams.total} streams</span>
              </Chip>
            )}
            {!follow && (
              <Chip>
                follow paused<span className="max-md:hidden"> · scrolled back (f)</span>
              </Chip>
            )}
          </>
        ) : (
          <>
            {results.next && store.size > 0 && (
              <button className="text-accent hover:underline pointer-coarse:py-1.5" disabled={results.busy} onClick={() => results.search(srch.q, srch.mode, Number(srch.minutes), results.next)}>
                continue scanning
              </button>
            )}
            {mode === "search" && results.scan && <span className="tabular-nums">{results.scan.pages.toLocaleString()} page{results.scan.pages === 1 ? "" : "s"} scanned{results.scan.done ? " · whole range" : ""}</span>}
            {mode === "search" && results.scan?.note && (
              // The page count is already shown; the rest (throttling) is news.
              <span className="truncate">{results.scan.note.split(" · ").filter((x) => !x.startsWith("scanned ")).join(" · ")}</span>
            )}
            {results.error && <span className="text-down">{results.error}</span>}
          </>
        )}
        {multi && (
          <span className="flex flex-wrap items-center gap-2">
            {services.map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full" style={{ background: colors.get(s) }} />
                {s}
              </span>
            ))}
          </span>
        )}
        <span className="ml-auto tabular-nums">
          <span className="max-md:hidden" title="Times are shown in your browser's time zone">{zone()} · </span>
          {store.visibleCount.toLocaleString()}
          {store.visibleCount !== store.size ? ` of ${store.size.toLocaleString()}` : ""} lines
          {store.dropped > 0 && mode === "tail" ? ` · ${store.dropped.toLocaleString()} trimmed` : ""}
          <span className="max-md:hidden"> · <span className="font-mono">/ n N f</span></span>
        </span>
      </div>
    </div>
  );
}

// Search came back empty (F27). CloudWatch searches a range a page at a time, so "nothing yet" and "nothing at all"
// are different answers: the first offers to keep scanning; both suggest Insights for wide ranges.
function SearchEmpty({ scan, next, onContinue, onInsights }: { scan: { minutes: number; pages: number }; next: boolean; onContinue(): void; onInsights(): void }) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 px-4 text-center text-xs text-fg-3">
      {next ? (
        <>
          <span>No matches in the part scanned so far ({scan.pages.toLocaleString()} page{scan.pages === 1 ? "" : "s"} of {rangeLabel(scan.minutes)}).</span>
          <Button size="sm" variant="primary" onClick={onContinue} className="pointer-coarse:min-h-10">
            <ScanSearch className="size-3.5" /> Continue scanning
          </Button>
        </>
      ) : (
        <span>No matches in {rangeLabel(scan.minutes)}.</span>
      )}
      {scan.minutes > 60 && (
        <span>
          Wide ranges are faster with{" "}
          <button className="text-accent hover:underline pointer-coarse:py-1.5" onClick={onInsights}>
            Logs Insights
          </button>
          , which scans the whole range in one query.
        </span>
      )}
    </div>
  );
}

// Mode labels collapse to their icon on phones (the name stays for screen readers).
function ModeLabel({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      <span className="max-sm:sr-only">{label}</span>
    </span>
  );
}

// Small inputs of the Search form: 28px, 40px on touch screens.
const FIELD = "h-7 rounded-md border border-line bg-panel-2 px-2 text-xs outline-none transition-colors focus:border-accent pointer-coarse:h-10";

// CI job logs reuse the same list: lines become a store with parsed timestamps.
export function StaticLog({ lines, highlight }: { lines: string[]; highlight?: string }) {
  const store = useMemo(() => {
    const s = new LogStore(200_000);
    s.append(
      lines.map((l) => {
        const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?(.*)$/.exec(l);
        return m ? [Date.parse(m[1]), 0, m[2]] : [0, 0, l];
      }),
      ["job"],
    );
    return s;
  }, [lines]);
  const [follow, setFollow] = useState(true);
  return <LogList store={store} version={lines.length} follow={follow} onFollowChange={setFollow} highlight={highlight} showStream={false} />;
}
