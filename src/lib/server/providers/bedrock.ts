// Bedrock provider: Bedrock agents, knowledge bases and provisioned throughput (names, models and status only — never
// prompts).
// Stub: it declares what it will discover (kinds, scope, the Resource Explorer types it covers) and reads nothing
// yet — c-prov-ml (wave C) implements it per the provider conventions (master plan §5.0). Disabled until then.
import "server-only";
import type { Provider } from "./types.ts";

export const bedrockProvider: Provider = {
  id: "bedrock",
  label: "Bedrock",
  kinds: ["bedrock-agent", "bedrock-knowledge-base", "bedrock-provisioned-throughput"],
  scope: "regional",
  covers: ["bedrock:agent", "bedrock:knowledge-base"],
  ttlMs: 15 * 60_000,
  read: [],
  enabled: () => ({ ok: false, why: "not implemented yet" }),
  discover: async () => ({ resources: [], links: [], mentions: [] }),
};
