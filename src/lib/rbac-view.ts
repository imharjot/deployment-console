// Role gating for view models: the UI renders a disabled button with a "needs <role> role" tooltip
// instead of offering an action the server will refuse. Pure; the server still enforces every action itself.
import { can, roleFor, type Perm, type User } from "./rbac.ts";
import type { ActionSpec, ResourceView } from "./types.ts";

export const permForAction = (name: ActionSpec["name"]): Perm => (name === "boxStart" || name === "boxStop" ? "power" : "act");

// Returns a new object (overviews are cached and shared between users — never mutate them).
export function gateResource(r: ResourceView, user: Pick<User, "role">, protectedEnv: boolean): ResourceView {
  let denied = 0;
  const actions = r.actions.map((a) => {
    const perm = permForAction(a.name);
    if (can(user, perm, protectedEnv)) return a;
    denied++;
    return { ...a, enabled: false, why: `needs ${roleFor(perm, protectedEnv)} role` };
  });
  if (!denied) return r;
  // Nothing left the user may do: read-only also hides the inline edit controls and revision switch buttons.
  return { ...r, actions, readOnly: denied === actions.length ? true : r.readOnly };
}
