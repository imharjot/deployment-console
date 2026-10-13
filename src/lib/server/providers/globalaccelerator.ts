// Global Accelerator provider: Global Accelerator accelerators and their endpoints.
// Stub: it declares what it will discover (kinds, scope, the Resource Explorer types it covers) and reads nothing
// yet — c-prov-protect-edge (wave C) implements it per the provider conventions (master plan §5.0). Disabled until then.
import "server-only";
import type { Provider } from "./types.ts";

export const globalacceleratorProvider: Provider = {
  id: "globalaccelerator",
  label: "Global Accelerator",
  kinds: ["global-accelerator"],
  scope: "global",
  homeRegion: "us-west-2",
  covers: ["globalaccelerator:accelerator"],
  ttlMs: 10 * 60_000,
  read: [],
  enabled: () => ({ ok: false, why: "not implemented yet" }),
  discover: async () => ({ resources: [], links: [], mentions: [] }),
};
