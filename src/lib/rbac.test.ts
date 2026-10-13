import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLES, can, isRole, permsOf, roleFor, type Perm, type Role } from "./rbac.ts";
import { gateResource, permForAction } from "./rbac-view.ts";
import type { ResourceView } from "./types.ts";

// The full matrix, written out so a change to GRANTS has to be made here on purpose.
const MATRIX: Record<Perm, Record<Role, boolean>> = {
  view: { viewer: true, developer: true, operator: true, admin: true },
  act: { viewer: false, developer: true, operator: true, admin: true },
  "act:protected": { viewer: false, developer: false, operator: true, admin: true },
  power: { viewer: false, developer: false, operator: true, admin: true },
  "ci:rerun": { viewer: false, developer: true, operator: true, admin: true },
  "ci:rerun:protected": { viewer: false, developer: false, operator: true, admin: true },
  "tickets:create": { viewer: false, developer: true, operator: true, admin: true },
  env: { viewer: false, developer: true, operator: true, admin: true },
  "env:protected": { viewer: false, developer: false, operator: true, admin: true },
  costs: { viewer: false, developer: false, operator: true, admin: true },
  notes: { viewer: false, developer: true, operator: true, admin: true },
  provision: { viewer: false, developer: false, operator: true, admin: true },
  "provision:protected": { viewer: false, developer: false, operator: false, admin: true },
  admin: { viewer: false, developer: false, operator: false, admin: true },
};

test("RBAC matrix: every role × permission", () => {
  for (const [perm, row] of Object.entries(MATRIX) as [Perm, Record<Role, boolean>][])
    for (const role of ROLES) assert.equal(can({ role }, perm), row[role], `${role} ${perm}`);
});

test("roles are cumulative: each role holds everything the previous one does", () => {
  for (let i = 1; i < ROLES.length; i++) for (const p of permsOf(ROLES[i - 1])) assert.ok(permsOf(ROLES[i]).includes(p), `${ROLES[i]} lacks ${p}`);
});

test("protectedEnv upgrades act and ci:rerun to their protected variants", () => {
  assert.equal(can({ role: "developer" }, "act", false), true);
  assert.equal(can({ role: "developer" }, "act", true), false);
  assert.equal(can({ role: "operator" }, "act", true), true);
  assert.equal(can({ role: "developer" }, "ci:rerun", true), false);
  assert.equal(can({ role: "operator" }, "ci:rerun", true), true);
  assert.equal(can({ role: "viewer" }, "view", true), true, "view is not env-scoped");
});

test("no user, unknown role → nothing", () => {
  assert.equal(can(null, "view"), false);
  assert.equal(can(undefined, "view"), false);
  assert.equal(can({ role: "root" as Role }, "view"), false);
  assert.equal(isRole("root"), false);
  assert.equal(isRole("operator"), true);
});

test("roleFor names the least role that holds a permission", () => {
  assert.equal(roleFor("act"), "developer");
  assert.equal(roleFor("act", true), "operator");
  assert.equal(roleFor("power"), "operator");
  assert.equal(roleFor("admin"), "admin");
});

const svc = (actions: ResourceView["actions"]): ResourceView => ({
  key: "service:api", kind: "service", env: "staging", id: "api", name: "api", subtitle: "", state: "UP", reasons: [], checkedAt: 0,
  stats: [], properties: [], actions, tabs: ["overview"],
});
const ACTIONS: ResourceView["actions"] = [
  { name: "restart", label: "Restart", enabled: true },
  { name: "stop", label: "Stop", enabled: true, danger: true },
  { name: "switch", label: "Switch", enabled: false, why: "rollout in progress" },
];

test("gateResource: viewer gets every action disabled with a role hint, and the resource goes read-only", () => {
  const r = svc(ACTIONS);
  const g = gateResource(r, { role: "viewer" }, false);
  assert.ok(g.actions.every((a) => !a.enabled && a.why === "needs developer role"));
  assert.equal(g.readOnly, true);
  assert.deepEqual(r.actions, ACTIONS, "input is not mutated (overviews are cached and shared)");
  assert.equal(r.readOnly, undefined);
});

test("gateResource: developer on a protected env needs operator; on staging keeps the original state", () => {
  assert.ok(gateResource(svc(ACTIONS), { role: "developer" }, true).actions.every((a) => a.why === "needs operator role"));
  const same = svc(ACTIONS);
  assert.equal(gateResource(same, { role: "developer" }, false), same, "untouched when allowed");
  assert.equal(gateResource(same, { role: "operator" }, true), same);
});

test("gateResource: box power needs operator even on staging", () => {
  const box = svc([{ name: "boxStart", label: "Start box", enabled: true }, { name: "boxStop", label: "Stop box", enabled: false, why: "already stopped" }]);
  assert.equal(permForAction("boxStop"), "power");
  const g = gateResource(box, { role: "developer" }, false);
  assert.ok(g.actions.every((a) => !a.enabled && a.why === "needs operator role"));
  assert.equal(g.readOnly, true);
  assert.equal(gateResource(box, { role: "operator" }, false), box);
});

test("gateResource: resources without actions are returned as-is", () => {
  const r = svc([]);
  assert.equal(gateResource(r, { role: "viewer" }, true), r);
});

test("env values: developers on unprotected envs, operators everywhere, viewers never", () => {
  assert.equal(can({ role: "developer" }, "env"), true);
  assert.equal(can({ role: "developer" }, "env", true), false);
  assert.equal(can({ role: "operator" }, "env", true), true);
  assert.equal(can({ role: "viewer" }, "env"), false);
  assert.equal(roleFor("env", true), "operator");
});
