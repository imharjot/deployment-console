// AWS Backup provider: backup plans, vaults, what they protect and recent job results.
// Stub: it declares what it will discover (kinds, scope, the Resource Explorer types it covers) and reads nothing
// yet — c-prov-protect-edge (wave C) implements it per the provider conventions (master plan §5.0). Disabled until then.
import "server-only";
import type { Provider } from "./types.ts";

export const backupProvider: Provider = {
  id: "backup",
  label: "AWS Backup",
  kinds: ["backup-plan", "backup-vault"],
  scope: "regional",
  covers: ["backup:backup-plan", "backup:backup-vault"],
  ttlMs: 15 * 60_000,
  read: [],
  enabled: () => ({ ok: false, why: "not implemented yet" }),
  discover: async () => ({ resources: [], links: [], mentions: [] }),
};
