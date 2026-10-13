"use client";
// Notes attached to one resource (any kind), by its inventory key: what someone changed, why, special traffic.
// Rendered as plain text — line breaks kept, http(s) URLs linked, nothing else interpreted (linkify in src/lib/notes.ts).
// Everyone signed in reads; developers and up write; the author or an admin edits and deletes. Writes are optimistic
// (SWR) and roll back with a toast when the server refuses. Used by the ECS resource panel and the cloud map's panel.
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Loader2, Pencil, Pin, PinOff, StickyNote, Trash2, X } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { ApiError, postJson } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import type { Note } from "@/lib/inventory/types";
import { NOTE_LIMITS, TAG_RE, isEdited, linkify, normalizeTag, sameAuthor, sortNotes, suggestTags, type NotePatch } from "@/lib/notes";
import { roleFor } from "@/lib/rbac";
import { useConfirm } from "./confirm";
import { Swap, enter, exit } from "./motion";
import { useToast } from "./toast";
import { Button, Chip, Empty, IconButton, Skeleton, TimeAgo, cx } from "./ui";
import { useMe } from "./user-menu";

type List = { notes: Note[] };
type TagCount = { tag: string; count: number };
interface Draft {
  body: string;
  tags: string[];
  pinned: boolean;
}

export const notesUrl = (key: string) => `/api/notes?key=${encodeURIComponent(key)}`;
export const useNotes = (key: string | undefined) => useSWR<List>(key ? notesUrl(key) : null, { refreshInterval: 60_000 });
// For tab labels and badges; shares the list request with <Notes>.
export const useNoteCount = (key: string | undefined) => useNotes(key).data?.notes.length ?? 0;
export const useNoteTags = (enabled = true) => useSWR<{ tags: TagCount[] }>(enabled ? "/api/notes/tags" : null, { revalidateOnFocus: false }).data?.tags ?? [];

// PATCH / DELETE with the CSRF header (postJson covers POST only).
async function send<T>(method: "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", "x-console-csrf": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ApiError(res.status, j?.error ?? `HTTP ${res.status}`);
  return j as T;
}

const who = (email: string) => email.split("@")[0] || email;

// ---------- rendering ----------

// Plain text with line breaks; only http(s) links are live. React escapes everything else.
export function NoteText({ text, clamp, className }: { text: string; clamp?: boolean; className?: string }) {
  const parts = useMemo(() => linkify(text), [text]);
  return (
    <p className={cx("whitespace-pre-wrap text-[14px] leading-relaxed text-fg [overflow-wrap:anywhere]", clamp && "line-clamp-[10]", className)}>
      {parts.map((p, i) =>
        p.href ? (
          <a key={i} href={p.href} target="_blank" rel="noreferrer noopener" className="text-accent underline decoration-accent/35 underline-offset-2 hover:decoration-accent">
            {p.text}
          </a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </p>
  );
}

// Each tag opens every note with it: a link to /notes, or `onTag` when already there.
export function NoteTags({ tags, onTag, className }: { tags: string[]; onTag?(t: string): void; className?: string }) {
  if (!tags.length) return null;
  const chip = (t: string) => <Chip className="hover:border-line-strong hover:text-fg">#{t}</Chip>;
  return (
    <ul className={cx("flex flex-wrap gap-1.5", className)} aria-label="Tags">
      {tags.map((t) => (
        <li key={t}>
          {onTag ? (
            <button type="button" onClick={() => onTag(t)} title={`Only notes tagged ${t}`} className="rounded-md">
              {chip(t)}
            </button>
          ) : (
            <Link href={`/notes?tag=${encodeURIComponent(t)}`} title={`All notes tagged ${t}`} className="rounded-md">
              {chip(t)}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------- the panel ----------

export function Notes({ resourceKey, resourceName, env }: { resourceKey: string; resourceName: string; env?: string }) {
  const me = useMe().data;
  const { data, error, isLoading, mutate } = useNotes(resourceKey);
  const { mutate: mutateAll } = useSWRConfig();
  const toast = useToast();
  const ask = useConfirm();
  const canWrite = !!me?.perms.includes("notes");
  const isAdmin = !!me?.perms.includes("admin");
  const tagsInUse = useNoteTags(canWrite);
  const notes = data?.notes ?? [];
  const mine = (n: Note) => !!me && canWrite && (isAdmin || sameAuthor(n.author, me.user.email));
  // Other lists (search results on /notes, tag suggestions) see the change on their next look.
  const refreshOthers = () => mutateAll((k) => typeof k === "string" && k.startsWith("/api/notes") && k !== notesUrl(resourceKey));
  const fail = (title: string, e: unknown) => toast.push({ tone: "error", title, body: (e as Error).message }, 7000);

  async function create(d: Draft): Promise<boolean> {
    const now = Date.now();
    const tmp: Note = { id: `tmp-${now}`, key: resourceKey, body: d.body.trim(), tags: d.tags, pinned: d.pinned, author: me?.user.email ?? "you", createdAt: now, updatedAt: now, resourceName, env };
    try {
      await mutate(
        async (cur) => {
          const { note } = await postJson<{ note: Note }>("/api/notes", { key: resourceKey, body: d.body, tags: d.tags, pinned: d.pinned, resourceName: resourceName || undefined, env: env || undefined });
          return { notes: sortNotes([note, ...(cur?.notes ?? []).filter((x) => x.id !== tmp.id)]) };
        },
        { optimisticData: (cur) => ({ notes: sortNotes([tmp, ...(cur?.notes ?? [])]) }), rollbackOnError: true, revalidate: false },
      );
      refreshOthers();
      return true;
    } catch (e) {
      fail("Note not saved", e);
      return false;
    }
  }

  async function update(n: Note, patch: NotePatch): Promise<boolean> {
    const content = patch.body !== undefined || patch.tags !== undefined;
    const optimistic: Note = { ...n, ...patch, ...(patch.body !== undefined ? { body: patch.body.trim() } : {}), ...(content ? { updatedAt: Date.now() } : {}) };
    const swap = (list: Note[], x: Note) => sortNotes(list.map((y) => (y.id === n.id ? x : y)));
    try {
      await mutate(
        async (cur) => {
          const { note } = await send<{ note: Note }>("PATCH", `/api/notes/${n.id}`, patch);
          return { notes: swap(cur?.notes ?? [], note) };
        },
        { optimisticData: (cur) => ({ notes: swap(cur?.notes ?? [], optimistic) }), rollbackOnError: true, revalidate: false },
      );
      refreshOthers();
      return true;
    } catch (e) {
      fail(patch.pinned !== undefined && !content ? "Pin not changed" : "Note not saved", e);
      return false;
    }
  }

  function remove(n: Note) {
    ask({
      env: env ?? "",
      title: "Delete this note?",
      description: "It disappears for everyone. The audit log keeps that it existed and who deleted it, not what it said.",
      danger: true,
      expected: "yes",
      confirmLabel: "Delete note",
      run: async () => {
        const drop = (list: Note[]) => list.filter((x) => x.id !== n.id);
        await mutate(
          async (cur) => {
            await send("DELETE", `/api/notes/${n.id}`);
            return { notes: drop(cur?.notes ?? []) };
          },
          { optimisticData: (cur) => ({ notes: drop(cur?.notes ?? []) }), rollbackOnError: true, revalidate: false },
        );
        refreshOthers();
      },
    });
  }

  const disabledWhy = !me ? "Loading…" : canWrite ? undefined : `Writing notes needs the ${roleFor("notes")} role.`;
  const state = isLoading ? "loading" : error && !data ? "error" : notes.length ? "list" : "empty";
  return (
    <section aria-label={`Notes on ${resourceName || resourceKey}`} className="mx-auto w-full max-w-3xl space-y-4">
      <NoteEditor key="new" label={`New note on ${resourceName || "this resource"}`} submitLabel="Add note" tagsInUse={tagsInUse} disabledWhy={disabledWhy} onSubmit={create} clearOnSubmit />
      <Swap id={state}>
        {state === "loading" ? (
          <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}</div>
        ) : state === "error" ? (
          <Empty title="Could not load notes" hint={(error as Error).message} />
        ) : state === "empty" ? (
          <Empty icon={<StickyNote className="size-4" />} title="No notes yet" hint="Leave a note for future you: what you changed, why, special traffic…" />
        ) : (
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {notes.map((n) => (
                <motion.li key={n.id} layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: enter }} exit={{ opacity: 0, transition: exit }}>
                  <NoteItem n={n} me={me?.user.email} canEdit={mine(n)} tagsInUse={tagsInUse} onUpdate={update} onDelete={remove} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Swap>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-xs text-fg-3">
        <span>Visible to everyone signed in. Changes are audited, the text is not.</span>
        <Link href="/notes" className="inline-flex items-center gap-1 text-accent hover:underline pointer-coarse:-my-3 pointer-coarse:py-3">
          All notes <ArrowUpRight className="size-3" />
        </Link>
      </footer>
    </section>
  );
}

function NoteItem({ n, me, canEdit, tagsInUse, onUpdate, onDelete }: { n: Note; me?: string; canEdit: boolean; tagsInUse: TagCount[]; onUpdate(n: Note, p: NotePatch): Promise<boolean>; onDelete(n: Note): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null); // what was typed, when a save failed
  const [expanded, setExpanded] = useState(false);
  const pending = n.id.startsWith("tmp-");
  const long = n.body.length > 700 || n.body.split("\n").length > 10;
  const you = !!me && sameAuthor(n.author, me);
  return (
    <article className={cx("group rounded-2xl border px-4 py-3 transition-colors duration-200", n.pinned ? "border-accent/30 bg-accent-soft" : "border-line bg-panel", pending && "opacity-70")}>
      <header className="flex min-h-8 items-center gap-2 text-xs text-fg-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          {n.pinned && (
            <span className="inline-flex items-center gap-1 font-medium text-accent">
              <Pin className="size-3" aria-hidden /> Pinned ·
            </span>
          )}
          <span className="truncate font-medium text-fg-2" title={n.author}>
            {you ? "You" : who(n.author)}
          </span>
          <span aria-hidden>·</span>
          {pending ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" aria-hidden /> saving…
            </span>
          ) : (
            <span title={stamp(n.createdAt)}>
              <TimeAgo at={n.createdAt} />
            </span>
          )}
          {isEdited(n) && <span title={`edited ${stamp(n.updatedAt)}`}>· edited</span>}
        </div>
        {canEdit && !editing && !pending && (
          <div className="-my-1 -mr-2 flex flex-none items-center transition-opacity duration-150 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 pointer-coarse:opacity-100">
            <IconButton label={n.pinned ? "Unpin note" : "Pin to the top"} aria-pressed={n.pinned} onClick={() => onUpdate(n, { pinned: !n.pinned })}>
              {n.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            </IconButton>
            <IconButton label="Edit note" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
            </IconButton>
            <IconButton label="Delete note" onClick={() => onDelete(n)} className="enabled:hover:!text-down">
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
        )}
      </header>
      {editing ? (
        <div className="mt-2">
          <NoteEditor
            label="Edit note"
            submitLabel="Save"
            base={{ body: n.body, tags: n.tags, pinned: n.pinned }}
            initial={draft ?? undefined}
            tagsInUse={tagsInUse}
            autoFocus
            hidePin
            onCancel={() => {
              setDraft(null);
              setEditing(false);
            }}
            onSubmit={async (d) => {
              setEditing(false); // optimistic: the list shows the new text at once, and rolls back on error
              const ok = await onUpdate(n, { body: d.body, tags: d.tags });
              setDraft(ok ? null : d);
              if (!ok) setEditing(true);
              return ok;
            }}
          />
        </div>
      ) : (
        <>
          <NoteText text={n.body} clamp={long && !expanded} className="mt-1" />
          {long && (
            <button type="button" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded} className="mt-1 text-xs font-medium text-accent hover:underline pointer-coarse:py-2">
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
          <NoteTags tags={n.tags} className="mt-2.5" />
        </>
      )}
    </article>
  );
}

// ---------- the form (new note and edit) ----------

const FIELD =
  "w-full rounded-lg border border-line bg-panel-2 text-[14px] text-fg outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-fg-3 hover:border-line-strong focus:border-accent/70 focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-line";

// `base` is the saved note when editing (Save stays off until something differs); `initial` what the form starts with.
function NoteEditor({ label, submitLabel, base, initial = base, tagsInUse, disabledWhy, autoFocus, hidePin, clearOnSubmit, onSubmit, onCancel }: {
  label: string;
  submitLabel: string;
  base?: Draft;
  initial?: Draft;
  tagsInUse: TagCount[];
  disabledWhy?: string;
  autoFocus?: boolean;
  hidePin?: boolean;
  clearOnSubmit?: boolean;
  onSubmit(d: Draft): Promise<boolean>;
  onCancel?(): void;
}) {
  const [body, setBody] = useState(initial?.body ?? "");
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const disabled = !!disabledWhy;
  const len = body.trim().length;
  const over = len > NOTE_LIMITS.body;
  const unchanged = !!base && body.trim() === base.body && tags.join() === base.tags.join();
  const valid = len > 0 && !over && !busy && !disabled && !unchanged;

  async function submit() {
    if (!valid) return;
    const draft = { body, tags, pinned };
    setBusy(true);
    if (clearOnSubmit) {
      // Optimistic: the note shows in the list at once; the text comes back if the server refuses it.
      setBody("");
      setTags([]);
      setPinned(false);
    }
    const ok = await onSubmit(draft);
    setBusy(false);
    if (!ok && clearOnSubmit) {
      setBody((b) => b || draft.body);
      setTags((t) => (t.length ? t : draft.tags));
      setPinned(draft.pinned);
    }
    if (clearOnSubmit) area.current?.focus();
  }

  useEffect(() => {
    const el = area.current;
    if (!autoFocus || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      // Keep the surrounding panel open: Esc cancels an edit, or just leaves a half-written note.
      if (onCancel) {
        e.stopPropagation();
        onCancel();
      } else if (body) {
        e.stopPropagation();
        e.currentTarget.blur();
      }
    }
  };

  return (
    <form
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cx("space-y-2", !base && "rounded-2xl border border-line bg-panel p-3 shadow-card")}
    >
      <label htmlFor={`${id}-body`} className="sr-only">
        {label}
      </label>
      <textarea
        id={`${id}-body`}
        ref={area}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKey}
        disabled={disabled}
        rows={3}
        maxLength={NOTE_LIMITS.body + 200}
        placeholder="What did you change, and why? Special traffic, quirks, links…"
        aria-describedby={`${id}-hint`}
        aria-invalid={over || undefined}
        className={cx(FIELD, "block max-h-[50vh] min-h-[84px] resize-y px-3 py-2 leading-relaxed [field-sizing:content]", over && "!border-down/60")}
      />
      <TagInput id={`${id}-tags`} tags={tags} setTags={setTags} all={tagsInUse} disabled={disabled} />
      <div className="flex flex-wrap items-center gap-2">
        {!hidePin && (
          <button
            type="button"
            aria-pressed={pinned}
            disabled={disabled}
            onClick={() => setPinned((p) => !p)}
            className={cx(
              "press inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium pointer-coarse:h-10 disabled:opacity-45",
              pinned ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-fg-3 enabled:hover:border-line-strong enabled:hover:text-fg",
            )}
          >
            <Pin className="size-3.5" aria-hidden /> {pinned ? "Pinned" : "Pin"}
          </button>
        )}
        <span id={`${id}-hint`} className={cx("mr-auto text-[12px] tabular-nums", over ? "text-down" : "text-fg-3")} aria-live={over ? "polite" : "off"}>
          {disabled ? (disabledWhy === "Loading…" ? "" : disabledWhy) : over ? `${(len - NOTE_LIMITS.body).toLocaleString("en-US")} characters too long` : `${len.toLocaleString("en-US")} / ${NOTE_LIMITS.body.toLocaleString("en-US")}`}
          {!disabled && !over && <span className="max-sm:hidden"> · ⌘/Ctrl+Enter to save</span>}
        </span>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" size="sm" disabled={!valid} title={disabledWhy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

// Chips plus a text box: Enter, comma or space adds the typed tag (also when pasted, or typed on keyboards that send
// no key events); Backspace in an empty box removes the last one. Suggestions (tags already in use) show while the
// box or a suggestion has focus.
function TagInput({ id, tags, setTags, all, disabled }: { id: string; tags: string[]; setTags(t: string[]): void; all: TagCount[]; disabled?: boolean }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const full = tags.length >= NOTE_LIMITS.tags;
  const sugg = open && !full ? suggestTags(all, text, tags, 6) : [];

  // Adds every valid tag; returns the first one that isn't (it stays in the box to fix, with the reason below).
  const commit = (raws: string[]): string | undefined => {
    let next = tags;
    let bad: string | undefined;
    let why: string | null = null;
    for (const raw of raws) {
      const t = normalizeTag(raw);
      if (!t || next.includes(t)) continue;
      const problem = !TAG_RE.test(t) ? "Tags are 1–32 lower-case letters, digits or dashes." : next.length >= NOTE_LIMITS.tags ? `At most ${NOTE_LIMITS.tags} tags.` : null;
      if (problem) {
        bad ??= raw;
        why ??= problem;
        continue;
      }
      next = [...next, t];
    }
    if (next !== tags) setTags(next);
    setErr(why);
    return bad;
  };
  const add = (raw: string) => setText(commit([raw]) ?? "");
  const change = (v: string) => {
    if (!/[,\s]/.test(v)) {
      setText(v);
      setErr(null);
      return;
    }
    const parts = v.split(/[,\s]+/);
    const rest = parts.pop() ?? "";
    setText(commit(parts) ?? rest);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || (e.key === " " && text.trim())) {
      e.preventDefault();
      add(text);
    } else if (e.key === "Backspace" && !text && tags.length) {
      setTags(tags.slice(0, -1));
    } else if (e.key === "Escape" && (text || open)) {
      e.stopPropagation();
      setText("");
      setOpen(false);
    }
  };

  return (
    <div
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOpen(false);
        if (text) add(text);
      }}
    >
      <div
        onClick={() => input.current?.focus()}
        className={cx(FIELD, "flex min-h-9 cursor-text flex-wrap items-center gap-1.5 px-2 py-1.5 focus-within:border-accent/70 focus-within:shadow-[0_0_0_3px_var(--accent-soft)] pointer-coarse:min-h-10", disabled && "pointer-events-none opacity-60")}
      >
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-0.5 rounded-md border border-line bg-panel py-px pl-1.5 pr-0.5 text-[12px] leading-4 text-fg-2">
            #{t}
            <button type="button" onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Remove tag ${t}`} className="grid size-4 place-items-center rounded text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:size-6">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          value={text}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKey}
          disabled={disabled || full}
          placeholder={full ? `${NOTE_LIMITS.tags} tags` : tags.length ? "Add another…" : "Tags (traffic, incident…)"}
          aria-label="Tags"
          aria-invalid={!!err || undefined}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          className="h-6 min-w-24 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-3"
        />
      </div>
      {err && <p className="mt-1 text-[12px] text-down">{err}</p>}
      {sugg.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5" aria-label="Suggested tags">
          <span className="text-[12px] text-fg-3">Used before:</span>
          {sugg.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                add(t);
                input.current?.focus();
              }}
              className="press rounded-md border border-dashed border-line px-1.5 py-px text-[12px] leading-4 text-fg-3 hover:border-line-strong hover:text-fg pointer-coarse:py-1.5"
            >
              #{t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
