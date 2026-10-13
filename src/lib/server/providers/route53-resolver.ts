// Route 53 Resolver provider: Route 53 Resolver endpoints and forwarding rules.
// Stub: it declares what it will discover (kinds, scope, the Resource Explorer types it covers) and reads nothing
// yet — c-prov-longtail-infra (wave C) implements it per the provider conventions (master plan §5.0). Disabled until then.
import "server-only";
import type { Provider } from "./types.ts";

export const route53ResolverProvider: Provider = {
  id: "route53-resolver",
  label: "Route 53 Resolver",
  kinds: ["resolver-endpoint", "resolver-rule"],
  scope: "regional",
  covers: ["route53resolver:resolver-endpoint", "route53resolver:resolver-rule"],
  ttlMs: 10 * 60_000,
  read: [],
  enabled: () => ({ ok: false, why: "not implemented yet" }),
  discover: async () => ({ resources: [], links: [], mentions: [] }),
};
