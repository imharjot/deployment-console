// Anthropic Messages API connections: the adapter in src/lib/agents/inference/http-adapters.ts over the console's
// egress guard. The endpoint is api.anthropic.com unless an admin registered another one for the connection.
import "server-only";
import { createAnthropicAdapter } from "../../../agents/inference/http-adapters.ts";
import { modelFetch } from "./fetch.ts";

export const anthropicAdapter = createAnthropicAdapter({ fetch: modelFetch });
