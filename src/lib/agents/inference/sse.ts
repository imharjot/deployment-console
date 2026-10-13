// Server-Sent Events, as the model APIs stream them (Anthropic Messages, OpenAI Responses, chat completions). Pure and
// incremental: chunks may split anywhere — inside a line, inside a UTF-8 character, between "\r" and "\n" — and the
// parser only emits an event once its blank line has arrived. Follows the WHATWG event-stream rules that matter here:
// "data" lines join with "\n", comment lines (":") are ignored, a leading BOM is dropped, CR, LF and CRLF all end a
// line, and an event without data is not dispatched.

export interface SseEvent {
  event: string; // "message" when the stream gave no event name
  data: string;
  id?: string;
}

export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;
  private started = false;
  private pendingCr = false;

  // Text in, complete events out.
  feed(chunk: string): SseEvent[] {
    if (!chunk) return [];
    let text = chunk;
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    // A "\r" ending the previous chunk already ended its line; a "\n" right after it belongs to the same line break.
    if (this.pendingCr && text.startsWith("\n")) text = text.slice(1);
    this.pendingCr = false;
    this.buf += text;
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (c !== "\n" && c !== "\r") continue;
      this.line(this.buf.slice(start, i), out);
      if (c === "\r") {
        if (i + 1 < this.buf.length) {
          if (this.buf[i + 1] === "\n") i++;
        } else this.pendingCr = true;
      }
      start = i + 1;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  // The stream ended: an unterminated last line is processed, but an event without its blank line is *not* dispatched
  // (the spec drops it — a cut-off event must never look complete).
  end(): SseEvent[] {
    if (this.buf) {
      this.line(this.buf, []);
      this.buf = "";
    }
    this.data = [];
    this.event = "";
    return [];
  }

  private line(line: string, out: SseEvent[]) {
    if (line === "") {
      if (this.data.length) out.push({ event: this.event || "message", data: this.data.join("\n"), ...(this.id !== undefined ? { id: this.id } : {}) });
      this.data = [];
      this.event = "";
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    // "retry" and unknown fields are ignored
  }
}

export class StreamIdleError extends Error {
  constructor(ms: number) {
    super(`no data for ${Math.round(ms / 1000)} s`);
    this.name = "StreamIdleError";
  }
}

export const DEFAULT_IDLE_MS = 120_000;

// Reads a byte stream into events. Stops when `signal` aborts (throws the abort) or the stream stays silent for
// `idleMs` (throws StreamIdleError); either way the body is cancelled so the connection closes.
export async function* readSse(body: ReadableStream<Uint8Array>, o: { signal?: AbortSignal; idleMs?: number } = {}): AsyncGenerator<SseEvent> {
  const parser = new SseParser();
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of readChunks(body, o)) yield* parser.feed(decoder.decode(chunk, { stream: true }));
  yield* parser.feed(decoder.decode());
  yield* parser.end();
}

// The raw chunks of a body, with the same abort and idle rules (also used for plain JSON bodies).
export async function* readChunks(body: ReadableStream<Uint8Array>, o: { signal?: AbortSignal; idleMs?: number } = {}): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const idleMs = o.idleMs ?? DEFAULT_IDLE_MS;
  let done = false;
  try {
    while (true) {
      o.signal?.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const stop = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamIdleError(idleMs)), idleMs);
        onAbort = () => reject(o.signal?.reason ?? new DOMException("aborted", "AbortError"));
        o.signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const r = await Promise.race([reader.read(), stop]);
        if (r.done) {
          done = true;
          return;
        }
        if (r.value?.byteLength) yield r.value;
      } finally {
        clearTimeout(timer);
        if (onAbort) o.signal?.removeEventListener("abort", onAbort);
      }
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// A whole (bounded) body as text: error answers and model lists. More than `max` bytes are never buffered.
export async function readBody(body: ReadableStream<Uint8Array> | null, o: { signal?: AbortSignal; idleMs?: number; max?: number } = {}): Promise<string> {
  if (!body) return "";
  const max = o.max ?? 2_000_000;
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let n = 0;
  for await (const chunk of readChunks(body, o)) {
    const part = n + chunk.byteLength > max ? chunk.subarray(0, max - n) : chunk;
    n += part.byteLength;
    text += decoder.decode(part, { stream: true });
    if (n >= max) break;
  }
  return text + decoder.decode();
}
