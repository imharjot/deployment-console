// SageMaker provider: SageMaker endpoints and notebook instances.
// Stub: it declares what it will discover (kinds, scope, the Resource Explorer types it covers) and reads nothing
// yet — c-prov-ml (wave C) implements it per the provider conventions (master plan §5.0). Disabled until then.
import "server-only";
import type { Provider } from "./types.ts";

export const sagemakerProvider: Provider = {
  id: "sagemaker",
  label: "SageMaker",
  kinds: ["sagemaker-endpoint", "sagemaker-notebook"],
  scope: "regional",
  covers: ["sagemaker:endpoint", "sagemaker:notebook-instance"],
  ttlMs: 10 * 60_000,
  read: [],
  enabled: () => ({ ok: false, why: "not implemented yet" }),
  discover: async () => ({ resources: [], links: [], mentions: [] }),
};
