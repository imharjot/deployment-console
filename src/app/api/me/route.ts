import { principalSummary } from "@/lib/agents/identity";
import { permsOf } from "@/lib/rbac";
import { authMode, loginMethods } from "@/lib/server/auth/config";
import { userById } from "@/lib/server/auth/users";
import { handle, json, userOf } from "@/lib/server/http";
import { agentCallerOf } from "@/lib/server/ops/caller";
import { connectionToken } from "@/lib/server/connection-state";
import { sourceKind } from "@/lib/server/sources";

// `email` and `source` (the data source: aws | mock) are read by the shell, and `connection`, the token of whose data the
// page shows, which it sends with every write (src/lib/client/connection.ts); the rest drives the user menu and gates.
export const GET = handle(async (req) => {
  const user = userOf(req);
  const row = await userById(user.id);
  const mode = authMode();
  return json({
    email: user.email,
    user: { id: user.id, email: user.email, name: row?.name ?? null, role: user.role },
    perms: permsOf(user.role),
    source: sourceKind(),
    connection: connectionToken(),
    authMode: mode.ok ? mode.mode : null,
    loginMethods: loginMethods(),
    via: req.headers.get("x-console-auth-via"), // session | alb | dev | token | agent
    hasPassword: !!row?.password_hash,
    // API token callers: which token, and its mode (see /docs/automation).
    ...(req.headers.get("x-console-auth-via") === "token"
      ? { token: { id: req.headers.get("x-console-token-id"), name: req.headers.get("x-console-token-name"), mode: req.headers.get("x-console-token-mode") } }
      : {}),
    // Agent tokens: what the agent is and whom it acts for — never a secret, never more than its policy's hash.
    ...(req.headers.get("x-console-auth-via") === "agent" ? { principal: principalSummary((await agentCallerOf(req)).principal!) } : {}),
  });
});
