// OpenAI Responses API connections (store: false; the console keeps the conversation): the adapter in
// src/lib/agents/inference/http-adapters.ts over the console's egress guard. The endpoint is api.openai.com unless an
// admin registered another one for the connection.
import "server-only";
import { createOpenAiAdapter } from "../../../agents/inference/http-adapters.ts";
import { modelFetch } from "./fetch.ts";

export const openAiAdapter = createOpenAiAdapter({ fetch: modelFetch });
