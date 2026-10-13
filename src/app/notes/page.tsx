"use client";
// Every note on every resource, newest first: search the text, filter by tag or environment, open the resource
// (ECS resources on the overview, everything else on the cloud map). Reached from a resource's Notes tab ("All
// notes") and from tag chips; ?q=, ?tag= and ?env= are kept in the address bar so a filtered view can be shared.
import { ArrowUpRight, Map as MapIcon, StickyNote } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { Swap } from "@/components/motion";
import { NoteTags, NoteText, useNoteTags } from "@/components/notes";
import { Chip, Empty, Skeleton, TimeAgo, cx } from "@/components/ui";
import { useEnvList } from "@/lib/client/env";
import { stamp } from "@/lib/client/format";
import type { Note } from "@/lib/inventory/types";
import { NOTE_LIMITS, isEdited, mapHref, resourceHref } from "@/lib/notes";
import { SearchField, SelectField } from "../_components/fields";
import { Page, PageHeader } from "../_components/page-frame";
import { ScrollX } from "../_components/scroll-x";

const LIMIT = NOTE_LIMITS.searchResults;

export default function NotesPage() {
  const [text, setText] = useState(""); // what is typed
  const [q, setQ] = useState(""); // what is searched (debounced)
  const [tag, setTag] = useState("");
  const [env, setEnv] = useState("");
  const [ready, setReady] = useState(false);
  const envs = useEnvList().data;
  const tags = useNoteTags();

  // The address bar is only readable after hydration.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    /* eslint-disable react-hooks/set-state-in-effect */
    setText(p.get("q") ?? "");
    setQ(p.get("q") ?? "");
    setTag(p.get("tag") ?? "");
    setEnv(p.get("env") ?? "");
    setReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(tag ? { tag } : {}), ...(env ? { env } : {}) }).toString();
  useEffect(() => {
    if (!ready) return;
    const u = new URL(window.location.href);
    u.search = qs;
    window.history.replaceState(null, "", u);
  }, [ready, qs]);

  const { data, error, isLoading } = useSWR<{ notes: Note[] }>(ready ? `/api/notes?${qs}${qs ? "&" : ""}limit=${LIMIT}` : null, { keepPreviousData: true, refreshInterval: 60_000 });
  const notes = data?.notes ?? [];
  const filtered = !!(q || tag || env);
  const envLabel = (id?: string) => envs?.find((e) => e.id === id)?.label ?? id;
  // Environments people wrote notes in may include ones the ECS side doesn't know (tags, names on the cloud map).
  const envOptions = [...new Set([...(envs ?? []).map((e) => e.id), ...notes.map((n) => n.env).filter((x): x is string => !!x), ...(env ? [env] : [])])];
  const state = !ready || (isLoading && !data) ? "loading" : error && !data ? "error" : notes.length ? "list" : filtered ? "none" : "empty";

  return (
    <Page width="narrow">
      <PageHeader
        title="Notes"
        description="What people wrote about resources: changes and why, special traffic, quirks, links. Everyone signed in can read them; developers and up write them in a resource's Notes tab."
      />
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField value={text} onChange={setText} label="Search notes" placeholder="Search text, resource, key…" className="min-w-0 flex-1 sm:max-w-sm" />
          <SelectField value={env} onChange={setEnv} label="Environment" className="w-full sm:w-48">
            <option value="">All environments</option>
            {envOptions.map((id) => (
              <option key={id} value={id}>
                {envLabel(id)}
              </option>
            ))}
          </SelectField>
        </div>
        {tags.length > 0 && (
          <ScrollX>
            <div className="flex w-max items-center gap-1.5 pb-0.5" role="group" aria-label="Filter by tag">
              {[{ tag: "", count: 0 }, ...tags.slice(0, 30)].map((t) => {
                const on = tag === t.tag;
                return (
                  <button
                    key={t.tag || "all"}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTag(on && t.tag ? "" : t.tag)}
                    className={cx(
                      "press inline-flex h-7 flex-none items-center gap-1 rounded-md border px-2 text-xs pointer-coarse:h-9",
                      on ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-fg-2 hover:border-line-strong hover:text-fg",
                    )}
                  >
                    {t.tag ? `#${t.tag}` : "All tags"}
                    {t.tag && <span className="tabular-nums text-fg-3">{t.count}</span>}
                  </button>
                );
              })}
            </div>
          </ScrollX>
        )}
      </div>

      <Swap id={state}>
        {state === "loading" ? (
          <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
        ) : state === "error" ? (
          <Empty title="Could not load notes" hint={(error as Error).message} />
        ) : state === "empty" ? (
          <Empty icon={<StickyNote className="size-4" />} title="No notes yet" hint="Open any resource on the overview or the cloud map and leave a note in its Notes tab: what you changed, why, special traffic…" />
        ) : state === "none" ? (
          <Empty title="Nothing matches" hint="Clear the search or the filters to see every note." />
        ) : (
          <div className="space-y-2">
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id}>
                  <NoteCard n={n} envLabel={envLabel(n.env)} onTag={setTag} />
                </li>
              ))}
            </ul>
            <p className="pt-1 text-center text-xs text-fg-3">{notes.length >= LIMIT ? `The ${LIMIT} most recent matches — narrow the search to see older ones.` : `${notes.length} note${notes.length === 1 ? "" : "s"}`}</p>
          </div>
        )}
      </Swap>
    </Page>
  );
}

function NoteCard({ n, envLabel, onTag }: { n: Note; envLabel?: string; onTag(t: string): void }) {
  const href = resourceHref(n);
  const onMap = mapHref(n.key);
  return (
    <article className={cx("rounded-2xl border bg-panel px-4 py-3 shadow-card", n.pinned ? "border-accent/30" : "border-line")}>
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={href} className="inline-flex min-w-0 items-center gap-1 text-[15px] font-medium text-fg hover:underline pointer-coarse:-my-2 pointer-coarse:py-2">
              <span className="truncate">{n.resourceName || n.key}</span>
              <ArrowUpRight className="size-3.5 flex-none text-fg-3" aria-hidden />
            </Link>
            {n.env && <Chip mono>{envLabel ?? n.env}</Chip>}
            {n.pinned && <Chip tone="accent">pinned</Chip>}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-[12px] text-fg-3" title={n.key}>
              {n.key}
            </span>
            {href !== onMap && (
              <Link href={onMap} className="inline-flex flex-none items-center gap-0.5 text-[12px] text-fg-3 hover:text-accent pointer-coarse:-my-3 pointer-coarse:py-3" aria-label={`Show ${n.resourceName || n.key} on the cloud map`}>
                <MapIcon className="size-3" aria-hidden /> map
              </Link>
            )}
          </div>
        </div>
        <div className="flex-none text-xs text-fg-3">
          <span title={n.author}>{n.author.split("@")[0]}</span> ·{" "}
          <span title={stamp(n.createdAt)}>
            <TimeAgo at={n.createdAt} />
          </span>
          {isEdited(n) && <span title={`edited ${stamp(n.updatedAt)}`}> · edited</span>}
        </div>
      </header>
      <NoteText text={n.body} clamp={n.body.length > 500 || n.body.split("\n").length > 10} className="mt-2" />
      <NoteTags tags={n.tags} onTag={onTag} className="mt-2.5" />
    </article>
  );
}
