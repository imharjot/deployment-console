"use client";
// Connect A → B: the ecs-connect provider's actions (server/providers/ecs-connect.ts) in the map's ActionDialog, with
// the environment's services, databases and caches to pick from. Opened from a service's panel on the map, by
// dragging from a service's handle onto another node, and from an overview service panel (which opens the map here).
import type { SelectOption } from "@/components/select";
import type { InventoryView, Resource } from "@/lib/inventory/types";
import { ActionDialog } from "./action-dialog";
import { useResourceActions } from "./data";

export const CONNECT_PROVIDER = "ecs-connect";
const TARGETS: Record<string, string> = { "ecs-service": "Services", rds: "Databases", elasticache: "Caches" };
export const isConnectTarget = (r: Pick<Resource, "kind">) => Object.hasOwn(TARGETS, r.kind);
const order = (r: Resource) => Object.keys(TARGETS).indexOf(r.kind);

// What a service can be connected to: the other services, databases and caches of its environment and region — never
// the console itself.
export function connectTargets(from: Resource, resources: readonly Resource[]): SelectOption[] {
  return resources
    .filter((x) => x.key !== from.key && !!from.env && x.env === from.env && x.region === from.region && !x.hidden && isConnectTarget(x) && x.tags?.["console:self"] !== "true")
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .map((x) => ({ value: x.key, label: x.name, text: x.name, group: TARGETS[x.kind] }));
}

export function ConnectDialog({ from, to, view, mode = "connect", onClose }: { from: Resource; to?: string; view: InventoryView; mode?: "connect" | "disconnect"; onClose(): void }) {
  const { data } = useResourceActions(from.key);
  const action = data?.actions.find((a) => a.provider === CONNECT_PROVIDER && a.id === mode);
  const env = from.env ? view.envs.find((e) => e.id === from.env) : undefined;
  if (!action) return null;
  return (
    <ActionDialog
      r={from}
      action={action}
      env={env ? { label: env.label, protected: env.protected } : undefined}
      initial={to ? { to } : undefined}
      choices={{ to: connectTargets(from, view.resources) }}
      onClose={onClose}
    />
  );
}
