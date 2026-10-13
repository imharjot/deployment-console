// Test helpers for the inference contract tests: fixture files, bodies delivered in arbitrary chunks, fake fetch
// responses. Not shipped code paths — only *.test.ts files import this.
import { readFileSync } from "node:fs";

export const fixtureText = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
export const fixtureJson = <T = unknown>(name: string) => JSON.parse(fixtureText(name)) as T;

// A body that delivers `text` in chunks of `size` bytes (splitting lines, events, JSON and UTF-8 characters anywhere).
// hangAfter: never closes (an idle stream); failAfter: errors after the last chunk (a reset connection).
export function chunked(text: string | Uint8Array, size: number, o: { hangAfter?: boolean; failAfter?: Error } = {}): ReadableStream<Uint8Array> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= bytes.length) {
        if (o.failAfter) c.error(o.failAfter);
        else if (o.hangAfter) return new Promise(() => {});
        else c.close();
        return;
      }
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

export const sseResponse = (text: string, size = 7, init: ResponseInit = {}, o: { hangAfter?: boolean; failAfter?: Error } = {}) =>
  new Response(chunked(text, size, o), { status: 200, ...init, headers: { "content-type": "text/event-stream", "request-id": "req_fixture", ...(init.headers as Record<string, string> | undefined) } });

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// An SSE fixture through readSse (chunked at `size` bytes) into a wire parser, then finish().
export async function parseFixture<T>(text: string, size: number, stream: { push(ev: { event: string; data: string; id?: string }): void; finish(requestId?: string): T }): Promise<T> {
  const { readSse } = await import("../sse.ts");
  for await (const ev of readSse(chunked(text, size))) stream.push(ev);
  return stream.finish();
}

export const CHUNK_SIZES = [1, 3, 7, 16, 61, 1 << 16];
