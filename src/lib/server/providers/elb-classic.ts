// Classic Load Balancers provider: Classic Load Balancers and their instances (kind classic-elb, never loadbalancer:
// CC-16).
// Stub: it declares what it will discover (kinds, scope, the Resource Explorer types it covers) and reads nothing
// yet — c-prov-protect-edge (wave C) implements it per the provider conventions (master plan §5.0). Disabled until then.
import "server-only";
import type { Provider } from "./types.ts";

export const elbClassicProvider: Provider = {
  id: "elb-classic",
  label: "Classic Load Balancers",
  kinds: ["classic-elb"],
  scope: "regional",
  covers: ["elasticloadbalancing:loadbalancer"],
  ttlMs: 2 * 60_000,
  read: [],
  enabled: () => ({ ok: false, why: "not implemented yet" }),
  discover: async () => ({ resources: [], links: [], mentions: [] }),
};
