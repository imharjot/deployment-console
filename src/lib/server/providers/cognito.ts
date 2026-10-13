// Cognito user pools provider: Cognito user pools, their domains and triggers.
// Stub: it declares what it will discover (kinds, scope, the Resource Explorer types it covers) and reads nothing
// yet — c-prov-protect-edge (wave C) implements it per the provider conventions (master plan §5.0). Disabled until then.
import "server-only";
import type { Provider } from "./types.ts";

export const cognitoProvider: Provider = {
  id: "cognito",
  label: "Cognito user pools",
  kinds: ["cognito-user-pool"],
  scope: "regional",
  covers: ["cognito-idp:userpool"],
  ttlMs: 10 * 60_000,
  read: [],
  enabled: () => ({ ok: false, why: "not implemented yet" }),
  discover: async () => ({ resources: [], links: [], mentions: [] }),
};
