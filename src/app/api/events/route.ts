// Live events as Server-Sent Events, for agents and the UI: `state` (a resource changed state, from the background
// sampler), `action` (an action finished, ok or error), `approval` (a request was created, decided or ran), and for the
// agent platform `run`, `step` and `operation`. Every event is persisted (src/lib/server/agents/events.ts) and sent with
// `id: <seq>`: a client that reconnects with `Last-Event-ID` (EventSource does) or `?after=<seq>` first gets what it
// missed — up to 500 events from the last hour — then the live stream. `?run=<id>` keeps one run's events.
//
// Who sees what (src/lib/agents/events-cursor.ts): people everything addressed to people; an API token resource state
// and action events plus its own approval requests; an agent token only its own run. Live, the stream reads the store
// in seq order and looks again for any seq it skipped over for a few seconds (SeqCursor: on Postgres seq order is not
// commit order), so nothing is lost or sent twice. A cursor beyond the store's newest event (another console's
// database, or one that was reset) starts live from the newest one, with `reset: true`. A comment line every 25 s keeps
// proxies from closing the connection. Streams end after 10 minutes and the client reconnects, so every connection is
// re-authenticated regularly; a token's stream also ends at the next heartbeat (≤ 25 s) after the token is revoked,
// expires, its owner is disabled or (agents) its run ends.
import { REPLAY_LIMIT, REPLAY_WINDOW_MS, SeqCursor, frame, parseCursor, visibleTo, type Viewer } from "@/lib/agents/events-cursor";
import { agentTokenStillValid } from "@/lib/server/auth/agent-tokens";
import { tokenStillValid } from "@/lib/server/auth/api-tokens";
import { startEventBridge } from "@/lib/server/agents/event-bridge";
import { latestSeq, onEvent, readSince } from "@/lib/server/agents/events";
import { HttpError } from "@/lib/server/errors";
import { handle } from "@/lib/server/http";
import { agentCallerOf } from "@/lib/server/ops/caller";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const MAX_MS = 10 * 60_000;
const POLL_MS = 2_000; // events published by another console (or a missed nudge) arrive within this

export const GET = handle(async (req) => {
  const c = await agentCallerOf(req);
  startEventBridge(); // idempotent: the sampler, coordinator and approvals feed the persisted stream
  const q = req.nextUrl.searchParams;
  const runFilter = q.get("run") ?? undefined;
  if (runFilter !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(runFilter)) throw new HttpError(400, "run must be a run id");
  const viewer: Viewer = { via: c.via, role: c.user.role, tokenId: c.tokenId, runId: c.via === "agent" ? c.runId : undefined };
  // An agent token sees its own run only, whatever it asks for.
  const runId = c.via === "agent" ? c.runId : runFilter;
  const asked = parseCursor(req.headers.get("last-event-id"), q.get("after"));
  const newest = await latestSeq();
  // An id this store never issued: start live from its newest event, and say so.
  const reset = asked !== undefined && asked > newest;
  const cursor = new SeqCursor(asked !== undefined && !reset ? asked : newest);
  const enc = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      let pumping = false;
      let again = false;
      const write = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          close();
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // Whether the event was sent to this client (it was new, and is theirs to see).
      const deliver = (r: { seq: number; type: string; payload: string | null; run_id: string | null; audience: string | null }, now: number): boolean => {
        if (!cursor.accept(r.seq, now) || !visibleTo(r, viewer)) return false;
        write(frame(r.seq, r.type, r.payload));
        return true;
      };
      // The replay after a reconnect: what was published after the client's id, within the last hour, at most
      // REPLAY_LIMIT events (the oldest first); more than that and the rest are skipped and the stream goes live.
      // Either way — too many, or some older than the hour — the client is told it missed events (truncated).
      const replay = async () => {
        const now = Date.now();
        const since = now - REPLAY_WINDOW_MS;
        const from = cursor.last;
        const rows = await readSince(from, { runId, since, limit: REPLAY_LIMIT });
        let count = 0;
        for (const r of rows) if (deliver(r, now)) count++;
        const tooMany = rows.length >= REPLAY_LIMIT;
        const tooOld = !tooMany && ((await readSince(from, { runId, limit: 1 }))[0]?.at ?? now) < since;
        const truncated = tooMany || tooOld;
        if (tooMany) cursor.skipTo(await latestSeq());
        send("replayed", { count, through: cursor.last, truncated, at: Date.now() });
      };
      // Live: everything after the cursor (and in its remembered gaps), page by page, in seq order. The hour window
      // applies here too, so a gap left by the replay's window is never filled with older history.
      const live = async () => {
        const now = Date.now();
        let from = cursor.from(now);
        for (let page = 0; page < 20 && open; page++) {
          const rows = await readSince(from, { runId, since: now - REPLAY_WINDOW_MS, limit: REPLAY_LIMIT });
          for (const r of rows) deliver(r, now);
          if (rows.length < REPLAY_LIMIT) break;
          from = rows[rows.length - 1].seq;
        }
      };
      const pump = async (first?: () => Promise<void>) => {
        if (pumping) return void (again = true);
        pumping = true;
        try {
          if (first) await first();
          do {
            again = false;
            await live();
          } while (again && open);
        } catch {
          // the next nudge or poll tries again
        } finally {
          pumping = false;
        }
      };
      const off = onEvent(() => void pump());
      const poll = setInterval(() => void pump(), POLL_MS);
      const started = Date.now();
      const beat = setInterval(async () => {
        if (Date.now() - started > MAX_MS) return close();
        if (c.via === "token" && c.tokenId && !(await tokenStillValid(c.tokenId).catch(() => false))) return close();
        if (c.via === "agent" && c.tokenId && !(await agentTokenStillValid(c.tokenId).catch(() => false))) return close();
        write(`: ping ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);
      function close() {
        if (!open) return;
        open = false;
        clearInterval(beat);
        clearInterval(poll);
        off();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
      stop = close;
      req.signal.addEventListener("abort", close);
      write("retry: 5000\n\n");
      send("ready", { at: Date.now(), via: c.via, cursor: cursor.last, ...(runId ? { run: runId } : {}) });
      if (reset) send("replayed", { count: 0, through: cursor.last, truncated: true, reset: true, at: Date.now() });
      else if (asked !== undefined) void pump(replay);
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
});
