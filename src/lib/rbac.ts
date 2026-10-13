// Roles and permissions. Pure (shared by server guards and UI). Roles are ordered: each includes the ones before it.
export const ROLES = ["viewer", "developer", "operator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export type Perm =
  | "view" // every page, logs, metrics, audit
  | "act" // restart / stop / start / switch revision on an unprotected env
  | "act:protected" // the same on a protected (production-like) env
  | "power" // start / stop EC2 hosts and databases
  | "ci:rerun" // re-run CI (except deploys to a protected env)
  | "ci:rerun:protected" // re-run a deploy workflow on a protected env's branch
  | "tickets:create"
  | "env" // reveal and edit environment variable values on an unprotected env (viewers see names only)
  | "env:protected" // the same on a protected env
  | "costs" // billing: spend, forecast, anomalies, estimates
  | "notes" // write notes on resources (everyone signed in can read them)
  | "provision" // create / delete console-created services and hosts, scale beyond start/stop, on an unprotected env
  | "provision:protected" // the same on a protected env
  | "admin"; // users, integrations, settings

const GRANTS: Record<Role, Perm[]> = {
  viewer: ["view"],
  developer: ["view", "act", "ci:rerun", "tickets:create", "env", "notes"],
  operator: ["view", "act", "act:protected", "power", "ci:rerun", "ci:rerun:protected", "tickets:create", "env", "env:protected", "costs", "provision", "notes"],
  admin: ["view", "act", "act:protected", "power", "ci:rerun", "ci:rerun:protected", "tickets:create", "env", "env:protected", "costs", "provision", "provision:protected", "notes", "admin"],
};

export interface User {
  id: string;
  email: string;
  name?: string | null;
  role: Role;
}

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);
export const permsOf = (role: Role): Perm[] => GRANTS[role] ?? [];

// `protectedEnv` upgrades "act" / "ci:rerun" / "env" / "provision" to their protected variants.
export function can(user: Pick<User, "role"> | null | undefined, perm: Perm, protectedEnv = false): boolean {
  if (!user) return false;
  const need: Perm = protectedEnv && (perm === "act" || perm === "ci:rerun" || perm === "env" || perm === "provision") ? (`${perm}:protected` as Perm) : perm;
  return permsOf(user.role).includes(need);
}

// The least role that holds a permission — for "needs operator role" hints.
export const roleFor = (perm: Perm, protectedEnv = false): Role =>
  ROLES.find((r) => can({ role: r }, perm, protectedEnv)) ?? "admin";
