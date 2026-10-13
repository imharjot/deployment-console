// Persisted events: the replay cursor and who may see what (master plan §6 C2 item 6). Pure — the store is
// src/lib/server/agents/events.ts, the stream src/app/api/events/route.ts.
//
// Every persisted event has a sequence number, sent as the SSE `id:`. A client that reconnects with `Last-Event-ID`
// (EventSource does this by itself) or `?after=<seq>` gets what it missed — up to REPLAY_LIMIT events from the last
// REPLAY_WINDOW_MS — and then the live stream. Audiences:
//   people (session, ALB, dev): everything addressed to people (optionally above a role);
//   API tokens (dc_):           resource state and action events, and the approval events of their own requests;
//   agent tokens (da_):         only the events of their own run.
import { ROLES, type Role } from "../rbac.ts";

export const EVENT_TYPES = ["state", "action", "approval", "run", "step", "operation"] as const;
export type PersistedEventType = (typeof EVENT_TYPES)[number];
export const isEventType = (v: unknown): v is PersistedEventType => typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);

export const REPLAY_LIMIT = 500;
export const REPLAY_WINDOW_MS = 3_600_000;
export const KEEP_EVENTS_MS = 7 * 86_400_000;

export interface Audience {
  people?: boolean | { minRole: Role }; // default true
  tokens?: string[]; // API token ids that may see it (their own approval requests)
  runs?: string[]; // agent runs that may see it besides the event's own run
}

export interface EventLike {
  type: string;
  run_id: string | null;
  audience: string | null; // JSON Audience
}

export interface Viewer {
  via: "session" | "alb" | "dev" | "token" | "agent";
  role?: Role;
  tokenId?: string;
  runId?: string;
}

export function parseAudience(raw: string | null | undefined): Audience {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Audience) : { people: false };
  } catch {
    return { people: false }; // unreadable: nobody but the run itself
  }
}

const rank = (r: Role | undefined) => (r ? ROLES.indexOf(r) : -1);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function visibleTo(e: EventLike, v: Viewer): boolean {
  const a = parseAudience(e.audience);
  if (v.via === "agent") return !!v.runId && (e.run_id === v.runId || list(a.runs).includes(v.runId));
  if (v.via === "token") {
    if (e.type === "approval") return !!v.tokenId && list(a.tokens).includes(v.tokenId);
    return (e.type === "state" || e.type === "action") && a.people !== false;
  }
  if (a.people === false) return false;
  if (a.people && typeof a.people === "object") return rank(v.role) >= rank(a.people.minRole);
  return true;
}

// `Last-Event-ID` wins over `?after=`; anything that isn't a non-negative safe integer is no cursor at all.
export function parseCursor(lastEventId: string | null | undefined, after: string | null | undefined): number | undefined {
  for (const raw of [lastEventId, after]) {
    const s = raw?.trim();
    if (s && /^\d{1,16}$/.test(s)) {
      const n = Number(s);
      if (Number.isSafeInteger(n)) return n;
    }
  }
  return undefined;
}

// The SSE frame of one persisted event. Payloads are JSON on one line (JSON never contains a raw line break).
export const frame = (seq: number, type: string, payload: string | null) => `id: ${seq}\nevent: ${type}\ndata: ${payload ?? "null"}\n\n`;

// Where a live stream is. A stream reads events back in seq order, but seq order is not commit order: on Postgres a
// transaction that took seq 10 can commit after the one that took 11, so a stream that already sent 11 would never
// see 10. Every seq skipped over is remembered for GAP_GRACE_MS and looked for again on each read; a gap that is still
// empty then (a rolled-back event, or one for another run when the stream is filtered) is forgotten. Nothing is sent
// twice: an event at or below the cursor is new only while its seq is a remembered gap.
export const GAP_GRACE_MS = 15_000;
const MAX_GAPS = 1_000;

export class SeqCursor {
  last: number;
  private gaps = new Map<number, number>(); // missing seq → when it was first skipped

  constructor(last: number) {
    this.last = last;
  }

  // Where the next read starts (exclusive): before the oldest gap still worth looking for.
  from(now = Date.now()): number {
    let low = this.last;
    for (const [seq, at] of this.gaps) {
      if (now - at > GAP_GRACE_MS) this.gaps.delete(seq);
      else if (seq - 1 < low) low = seq - 1;
    }
    return low;
  }

  // Whether an event read back is new for this stream (then it moves the cursor or fills a gap).
  accept(seq: number, now = Date.now()): boolean {
    if (seq > this.last) {
      for (let m = Math.max(this.last + 1, seq - MAX_GAPS); m < seq; m++) this.gaps.set(m, now);
      if (this.gaps.size > MAX_GAPS) for (const k of [...this.gaps.keys()].sort((a, b) => a - b).slice(0, this.gaps.size - MAX_GAPS)) this.gaps.delete(k);
      this.last = seq;
      return true;
    }
    return this.gaps.delete(seq);
  }

  // A replay that had to skip (more than REPLAY_LIMIT missed): go live from `seq`, nothing older is looked for.
  skipTo(seq: number): void {
    this.last = Math.max(this.last, seq);
    this.gaps.clear();
  }

  get pendingGaps(): number {
    return this.gaps.size;
  }
}
