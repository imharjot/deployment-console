"use client";
// The embedded assistant's state in this browser tab: whether the drawer is open, the resource it was opened about, and
// the thread of questions asked in it. The thread is kept in sessionStorage, so a reload reopens the same runs and
// resumes them (their events replay from the server). Anything may start a question — the header's Ask button, a
// resource panel's "Why is this unhealthy?", the /assistant page — by calling ask(); the shell renders the drawer.
import { useSyncExternalStore } from "react";
import { ApiError, getJson, postJson } from "@/lib/client/api";
import { MAX_THREAD, checkQuestion, normalizeConnections, parseThread, pickConnection, questionToKeep, startError, type ThreadEntry } from "./model";

export interface AssistantContext {
  key?: string; // the inventory key: the run's scope
  name: string;
}

interface State {
  open: boolean;
  thread: ThreadEntry[];
  context?: AssistantContext; // follow-up questions are about this resource until it is cleared
  connectionId?: string; // the connection picked in the drawer (remembered in localStorage)
}

const THREAD_KEY = "console.assistant.thread";
const CONNECTION_KEY = "console.assistant.connection";

const read = (store: () => Storage, key: string) => {
  try {
    return store().getItem(key);
  } catch {
    return null; // storage blocked
  }
};
const write = (store: () => Storage, key: string, value: string | null) => {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    /* storage blocked or full: the thread lives for this page only */
  }
};

const SERVER: State = { open: false, thread: [] };
let state: State | undefined;
const listeners = new Set<() => void>();

function current(): State {
  if (state) return state;
  if (typeof window === "undefined") return SERVER;
  state = { open: false, thread: parseThread(read(() => sessionStorage, THREAD_KEY)), connectionId: read(() => localStorage, CONNECTION_KEY) ?? undefined };
  return state;
}

function set(patch: Partial<State>) {
  const prev = current();
  state = { ...prev, ...patch };
  if (patch.thread && patch.thread !== prev.thread) write(() => sessionStorage, THREAD_KEY, JSON.stringify(state.thread));
  for (const l of listeners) l();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

export const useAssistant = () => useSyncExternalStore(subscribe, current, () => SERVER);

export function openAssistant(context?: AssistantContext) {
  set({ open: true, ...(context ? { context } : {}) });
}
export const closeAssistant = () => set({ open: false });
export const clearContext = () => set({ context: undefined });
export const clearThread = () => set({ thread: [], context: undefined });

export function chooseConnection(id: string) {
  write(() => localStorage, CONNECTION_KEY, id);
  set({ connectionId: id });
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function patchEntry(key: string, patch: Partial<ThreadEntry>) {
  set({ thread: current().thread.map((e) => (e.key === key ? { ...e, ...patch } : e)) });
}

// The connection to ask with: the drawer's choice, else (before its picker has loaded) the same default it would show.
async function connectionToUse(): Promise<string | undefined> {
  const s = current();
  try {
    const all = normalizeConnections(await getJson<unknown>("/api/agents/connections"));
    const chosen = pickConnection(all, s.connectionId);
    return chosen?.id;
  } catch {
    return s.connectionId; // the server answers for it (and says why it can't be used)
  }
}

// Ask a question: it joins the thread at once ("Starting…") and becomes an incident-investigator run
// (POST /api/assistant → { runId }). Text that looks like a secret is refused here too, not only in the composer.
export async function ask(question: string, about?: AssistantContext): Promise<void> {
  const q = question.trim();
  const check = checkQuestion(q);
  const context = about ?? current().context;
  const entry: ThreadEntry = { key: newKey(), question: questionToKeep(q), at: Date.now(), ...(context?.key ? { resourceKey: context.key } : {}), ...(context ? { resourceName: context.name } : {}) };
  // A refused question joins the thread already refused (and without the text, when it looked like a secret).
  const refused = check.ok ? {} : { error: check.message ?? "Write a question first.", code: "refused" };
  set({ open: true, thread: [...current().thread, { ...entry, ...refused }].slice(-MAX_THREAD), ...(about ? { context: about } : {}) });
  if (!check.ok) return;
  try {
    const connectionId = await connectionToUse();
    if (connectionId && connectionId !== current().connectionId) chooseConnection(connectionId); // "the last one used" next time
    const r = await postJson<{ runId?: unknown }>("/api/assistant", { question: q, ...(entry.resourceKey ? { resourceKey: entry.resourceKey } : {}), ...(connectionId ? { connectionId } : {}) });
    const runId = typeof r?.runId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(r.runId) ? r.runId : undefined;
    if (!runId) throw new ApiError(502, "The server didn't return a run id.");
    patchEntry(entry.key, { runId });
  } catch (e) {
    const ae = e instanceof ApiError ? e : undefined;
    patchEntry(entry.key, { error: startError(ae?.status ?? 0, (e as Error)?.message ?? "Couldn't start the run.", ae?.code), code: ae?.code });
  }
}

// Ask the same question again (after a failed start).
export function retry(key: string) {
  const e = current().thread.find((x) => x.key === key);
  if (!e) return;
  set({ thread: current().thread.filter((x) => x.key !== key) });
  void ask(e.question, e.resourceName ? { key: e.resourceKey, name: e.resourceName } : undefined);
}

// Open an existing run in the drawer (the /assistant page's "Continue in the drawer"): it streams from where it is.
export function resume(run: { id: string; question: string; resourceKey?: string }) {
  const s = current();
  if (s.thread.some((e) => e.runId === run.id)) return set({ open: true });
  const entry: ThreadEntry = { key: newKey(), question: questionToKeep(run.question), runId: run.id, at: Date.now(), ...(run.resourceKey ? { resourceKey: run.resourceKey } : {}) };
  set({ open: true, thread: [...s.thread, entry].slice(-MAX_THREAD) });
}
