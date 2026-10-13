"use client";
// One run's record, kept current: GET /api/agents/runs/<id>, re-read whenever the event stream says the run, one of its
// steps or operations, or its approval changed. EventSource reconnects by itself and sends Last-Event-ID, so the
// server replays what was missed (then a `replayed` marker, after which the record is re-read once more): a dropped
// connection resumes where it stopped, and a stream the server refused is reopened from the last event with backoff.
// A slow poll covers a stream a proxy keeps breaking.
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { getJson } from "@/lib/client/api";
import { RUN_REFRESH_EVENTS, stillMoving, type LiveStatus } from "./rules";
import type { RunDetail } from "./types";

export const runKey = (runId: string) => `/api/agents/runs/${encodeURIComponent(runId)}`;

// The detail route answers the run itself or { run } — either is fine.
export async function fetchRun(url: string): Promise<RunDetail> {
  const j = await getJson<RunDetail | { run: RunDetail }>(url);
  return (j && typeof j === "object" && "run" in j && j.run && typeof j.run === "object" ? j.run : j) as RunDetail;
}

// Whether there is still something to follow (pure, in rules.ts).
export { stillMoving };

export function useRun(runId: string | undefined) {
  const swr = useSWR<RunDetail>(runId ? runKey(runId) : null, fetchRun, {
    refreshInterval: (r) => (stillMoving(r) ? 15_000 : 0),
    revalidateOnFocus: true,
  });
  const following = !!runId && !swr.error && stillMoving(swr.data);
  const live = useRunEvents(runId, following, () => void swr.mutate());
  return { ...swr, live, following };
}

export function useRunEvents(runId: string | undefined, enabled: boolean, onChange: () => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  });
  const on = !!runId && enabled && typeof EventSource !== "undefined";
  useEffect(() => {
    if (!on) return;
    let es: EventSource | undefined;
    let last = ""; // the last event id seen: a reopened stream resumes after it
    let backoff = 1_000;
    let t: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    // A burst of step events (a model turn with several tool calls) becomes one re-read.
    const changed = (e: Event) => {
      const id = (e as MessageEvent).lastEventId;
      if (id) last = id;
      clearTimeout(t);
      t = setTimeout(() => cb.current(), 150);
    };
    const close = () => {
      if (!es) return;
      for (const type of RUN_REFRESH_EVENTS) es.removeEventListener(type, changed);
      es.close();
      es = undefined;
    };
    const open = () => {
      if (stopped) return;
      const src = new EventSource(`/api/events?run=${encodeURIComponent(runId!)}${last ? `&after=${encodeURIComponent(last)}` : ""}`);
      es = src;
      src.onopen = () => {
        backoff = 1_000;
        setStatus("live");
      };
      // A dropped connection reconnects by itself (with Last-Event-ID). One the server refused (a transient 503, say)
      // is closed for good: reopen it from the last event, backing off from 1 s up to 30 s; the slow poll covers the gap.
      src.onerror = () => {
        if (src.readyState !== EventSource.CLOSED) return setStatus("reconnecting");
        setStatus("reconnecting");
        close();
        retry = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
      for (const type of RUN_REFRESH_EVENTS) src.addEventListener(type, changed);
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(t);
      clearTimeout(retry);
      close();
    };
  }, [on, runId]);
  return on ? status : "ended";
}
