// How the HTTP model adapters reach a provider: the console's egress guard (safeFetch — every address checked and
// pinned for the socket, link-local and metadata addresses refused, private ones only where the plan allows) with
// redirects refused, so a 30x can't carry an API key anywhere else.
import "server-only";
import { safeFetch } from "../../../plugins/http.ts";
import type { FetchLike } from "../../../agents/inference/http-adapters.ts";

export const modelFetch: FetchLike = (url, init, opts) => safeFetch(url, { ...init, redirect: "error" }, { ...opts, maxRedirects: 0 });

// Short-lived adapter caches (Ollama's per-model capabilities, Bedrock role sessions), shared by the worker and the
// routes, which Next bundles separately.
const g = globalThis as typeof globalThis & { __consoleInferenceCache?: Map<string, { at: number; value: unknown }> };
export const inferenceCache = () => (g.__consoleInferenceCache ??= new Map());
