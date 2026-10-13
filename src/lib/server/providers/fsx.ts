// FSx provider: FSx file systems (Windows, Lustre, ONTAP, OpenZFS).
// Stub: it declares what it will discover (kinds, scope, the Resource Explorer types it covers) and reads nothing
// yet — c-prov-longtail-infra (wave C) implements it per the provider conventions (master plan §5.0). Disabled until then.
import "server-only";
import type { Provider } from "./types.ts";

export const fsxProvider: Provider = {
  id: "fsx",
  label: "FSx",
  kinds: ["fsx-filesystem"],
  scope: "regional",
  covers: ["fsx:file-system"],
  ttlMs: 10 * 60_000,
  read: [],
  enabled: () => ({ ok: false, why: "not implemented yet" }),
  discover: async () => ({ resources: [], links: [], mentions: [] }),
};
