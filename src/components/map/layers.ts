// The map's support layers (network, security, monitoring, delivery, other services): their labels, what each holds,
// and the person's last choice (localStorage, inside try/catch: a blocked store just means the defaults). The URL
// (?layers=) wins over the saved choice, so a shared link shows what its sender saw.
import { DEFAULT_LAYERS } from "../../lib/inventory/layout.ts";
import { CATEGORY_LABEL, SUPPORT_ORDER, type Layer } from "../../lib/inventory/types.ts";

export { DEFAULT_LAYERS };

export const LAYER_HINT: Record<Layer, string> = {
  network: "VPCs, subnets, gateways, endpoints, security groups, Cloud Map",
  security: "IAM roles, KMS keys, certificates, secrets, parameters",
  observability: "log groups, alarms, canaries, health checks, trails",
  delivery: "ECR repositories, pipelines, builds, deployments, stacks",
  other: "everything else the account holds, grouped per AWS service",
};

export const LAYERS: { id: Layer; label: string; hint: string }[] = SUPPORT_ORDER.map((id) => ({ id, label: CATEGORY_LABEL[id], hint: LAYER_HINT[id] }));

const KEY = "console.map.layers";

export function parseLayers(v: string | null | undefined): Layer[] | null {
  if (v === null || v === undefined) return null;
  if (v === "none" || v === "") return [];
  const want = v.split(",");
  return SUPPORT_ORDER.filter((l) => want.includes(l));
}

export function loadLayers(): Layer[] | null {
  try {
    return parseLayers(localStorage.getItem(KEY));
  } catch {
    return null; // storage blocked
  }
}

export function saveLayers(layers: Iterable<Layer>) {
  const list = SUPPORT_ORDER.filter((l) => new Set(layers).has(l));
  try {
    localStorage.setItem(KEY, list.join(",") || "none");
  } catch {
    /* storage blocked */
  }
}
