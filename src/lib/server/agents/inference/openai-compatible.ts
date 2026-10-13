// OpenAI-compatible chat-completions endpoints and Ollama: the adapters in src/lib/agents/inference/http-adapters.ts
// over the console's egress guard. Both need an admin-registered endpoint; a "local" connection must resolve to
// loopback or private addresses (pinned for the request) and refuses Ollama's cloud models.
import "server-only";
import { createCompatAdapter, createOllamaAdapter } from "../../../agents/inference/http-adapters.ts";
import { inferenceCache, modelFetch } from "./fetch.ts";

export const openAiCompatibleAdapter = createCompatAdapter({ fetch: modelFetch });
export const ollamaAdapter = createOllamaAdapter({ fetch: modelFetch, cache: inferenceCache() });
