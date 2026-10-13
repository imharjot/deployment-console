// Role-aware view models. The server enforces every action on its own; this only makes the UI honest about it:
// actions the user can't take come back disabled with a "needs <role> role" tooltip.
import "server-only";
import type { User } from "../rbac.ts";
import { gateResource } from "../rbac-view.ts";
import type { EnvOverview } from "../types.ts";
import { envInfo } from "./discovery.ts";

// Returns a copy: overviews are cached and shared between users.
export async function applyPerms(o: EnvOverview, user: User): Promise<EnvOverview> {
  const prot = (await envInfo(o.env)).protected;
  return { ...o, services: o.services.map((r) => gateResource(r, user, prot)), infra: o.infra.map((r) => gateResource(r, user, prot)) };
}
