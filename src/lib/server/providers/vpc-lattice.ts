// VPC Lattice provider: VPC Lattice service networks, services and their targets.
// Stub: it declares what it will discover (kinds, scope, the Resource Explorer types it covers) and reads nothing
// yet — c-prov-longtail-infra (wave C) implements it per the provider conventions (master plan §5.0). Disabled until then.
import "server-only";
import type { Provider } from "./types.ts";

export const vpcLatticeProvider: Provider = {
  id: "vpc-lattice",
  label: "VPC Lattice",
  kinds: ["lattice-service-network", "lattice-service"],
  scope: "regional",
  covers: ["vpc-lattice:servicenetwork", "vpc-lattice:service"],
  ttlMs: 10 * 60_000,
  read: [],
  enabled: () => ({ ok: false, why: "not implemented yet" }),
  discover: async () => ({ resources: [], links: [], mentions: [] }),
};
