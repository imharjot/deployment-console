import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_TTL_MS, apiTokensEnabled, bearerToken, effectiveStatus, gate, isAgentBearer, isApiTokenShape, isTokenMode, minRole, roleAtMost, tokenDisplayPrefix, tokenNameProblem, tokenRoute,
  type TokenMode, type Via,
} from "./automation.ts";
import type { Risk } from "./server/ops/types.ts";

// The whole gate, written out so a change to it has to be made here on purpose.
test("mode gate: every mode × risk × protected for tokens", () => {
  const want: Record<TokenMode, Record<Risk, [unprotected: string, protectedEnv: string]>> = {
    read: { read: ["run", "run"], change: ["deny", "deny"], danger: ["deny", "deny"] },
    propose: { read: ["run", "run"], change: ["approve", "approve"], danger: ["approve", "approve"] },
    act: { read: ["run", "run"], change: ["run", "approve"], danger: ["approve", "approve"] },
  };
  for (const [mode, row] of Object.entries(want) as [TokenMode, Record<Risk, [string, string]>][])
    for (const [risk, [u, p]] of Object.entries(row) as [Risk, [string, string]][]) {
      assert.equal(gate(mode, risk, false, "token"), u, `${mode} ${risk} unprotected`);
      assert.equal(gate(mode, risk, true, "token"), p, `${mode} ${risk} protected`);
    }
});

test("mode gate: people always run (the role check already happened); unknown token modes are refused", () => {
  for (const via of ["session", "alb", "dev"] as Via[]) for (const risk of ["read", "change", "danger"] as Risk[]) assert.equal(gate(undefined, risk, true, via), "run");
  assert.equal(gate(undefined, "change", false, "token"), "deny");
  assert.equal(gate("admin" as TokenMode, "danger", false, "token"), "deny");
  assert.equal(gate(undefined, "read", false, "token"), "run");
});

test("tokens reach the operations API only", () => {
  for (const [m, p] of [["GET", "/api/ops"], ["POST", "/api/ops/services.restart"], ["GET", "/api/approvals"], ["GET", "/api/approvals/abc"], ["GET", "/api/events"], ["POST", "/api/mcp"], ["GET", "/api/me"], ["HEAD", "/api/me"]])
    assert.ok(tokenRoute(m, p).ok, `${m} ${p}`);
  for (const [m, p] of [
    ["GET", "/"], ["GET", "/automation"], ["GET", "/settings/users"], ["GET", "/api/users"], ["POST", "/api/users"], ["GET", "/api/tokens"], ["POST", "/api/tokens"],
    ["DELETE", "/api/tokens/x"], ["GET", "/api/integrations"], ["GET", "/api/services/prod/api/variables/reveal"], ["POST", "/api/services/prod/api/actions"],
    ["POST", "/api/ops"], ["GET", "/api/ops/services.restart"], ["POST", "/api/infra/box"], ["GET", "/api/audit"], ["POST", "/api/auth/logout"], ["GET", "/api/ops/../users"],
  ])
    assert.equal(tokenRoute(m, p).ok, false, `${m} ${p}`);
});

test("deciding an approval is refused to tokens with a specific message", () => {
  const r = tokenRoute("POST", "/api/approvals/123");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /can't approve/);
});

test("bearer header parsing: only dc_ tokens are ours", () => {
  assert.equal(bearerToken("Bearer dc_abc"), "dc_abc");
  assert.equal(bearerToken("bearer   dc_abc  "), "dc_abc");
  assert.equal(bearerToken("Bearer dc_"), "dc_");
  assert.equal(bearerToken("Bearer eyJhbGciOi"), null);
  assert.equal(bearerToken("Basic Zm9vOmJhcg=="), null);
  assert.equal(bearerToken(null), null);
  assert.equal(bearerToken(""), null);
});

test("token shape and display prefix", () => {
  const t = `dc_${"a".repeat(43)}`;
  assert.ok(isApiTokenShape(t));
  assert.equal(isApiTokenShape(`dc_${"a".repeat(42)}`), false);
  assert.equal(isApiTokenShape(`xx_${"a".repeat(43)}`), false);
  assert.equal(isApiTokenShape(`dc_${"a".repeat(42)}!`), false);
  assert.equal(tokenDisplayPrefix(t), "dc_aaaaaaa");
});

test("a token never outranks its owner", () => {
  assert.equal(minRole("admin", "developer"), "developer");
  assert.equal(minRole("viewer", "admin"), "viewer");
  assert.equal(minRole("operator", "operator"), "operator");
  assert.ok(roleAtMost("developer", "operator"));
  assert.ok(roleAtMost("operator", "operator"));
  assert.equal(roleAtMost("admin", "operator"), false);
});

test("modes and names", () => {
  assert.ok(isTokenMode("propose"));
  assert.equal(isTokenMode("write"), false);
  assert.equal(tokenNameProblem("release-bot"), undefined);
  assert.equal(tokenNameProblem("Claude Desktop @ laptop"), undefined);
  assert.match(tokenNameProblem("") ?? "", /required/);
  assert.match(tokenNameProblem("x".repeat(61)) ?? "", /60/);
  assert.match(tokenNameProblem('bad"quote') ?? "", /letters/);
  assert.match(tokenNameProblem("line\nbreak") ?? "", /letters/);
});

test("pending approvals expire after 24 hours", () => {
  const now = 1_000_000_000_000;
  assert.equal(effectiveStatus("pending", now - APPROVAL_TTL_MS + 1, now), "pending");
  assert.equal(effectiveStatus("pending", now - APPROVAL_TTL_MS, now), "expired");
  assert.equal(effectiveStatus("done", now - 10 * APPROVAL_TTL_MS, now), "done");
});

test("CONSOLE_API_TOKENS: unset or true-ish leaves tokens on; false, 0 or any typo switches them off", () => {
  const was = process.env.CONSOLE_API_TOKENS;
  try {
    delete process.env.CONSOLE_API_TOKENS;
    assert.equal(apiTokensEnabled(), true);
    process.env.CONSOLE_API_TOKENS = "false";
    assert.equal(apiTokensEnabled(), false);
    process.env.CONSOLE_API_TOKENS = "true";
    assert.equal(apiTokensEnabled(), true);
    for (const off of ["FALSE", " false ", "0", "no", "off", "flase"]) {
      process.env.CONSOLE_API_TOKENS = off;
      assert.equal(apiTokensEnabled(), false, `"${off}" must switch tokens off`);
    }
  } finally {
    if (was === undefined) delete process.env.CONSOLE_API_TOKENS;
    else process.env.CONSOLE_API_TOKENS = was;
  }
});

// Wave C (C1): agent tokens share the bearer header and the route list, but never the mode gate.
test("agents: `da_` bearer tokens are recognised, and the mode gate never lets an agent run anything", () => {
  assert.equal(bearerToken("Bearer da_abc"), "da_abc");
  assert.equal(bearerToken("bearer DA_abc"), "DA_abc"); // the shape check (isAgentTokenShape) refuses it later
  assert.equal(bearerToken("Bearer db_abc"), null);
  assert.ok(isAgentBearer("da_x") && !isAgentBearer("dc_x"));
  for (const risk of ["read", "change", "danger"] as Risk[])
    for (const mode of [undefined, "read", "propose", "act"] as (TokenMode | undefined)[])
      for (const prot of [false, true]) assert.equal(gate(mode, risk, prot, "agent"), "deny", `${mode} ${risk} ${prot}`);
  // Agent tokens reach exactly the API tokens' routes; API tokens keep their wording, agent tokens get their own.
  const routes: [string, string][] = [["GET", "/api/ops"], ["POST", "/api/ops/x.y"], ["GET", "/api/approvals"], ["GET", "/api/approvals/x"], ["GET", "/api/events"], ["POST", "/api/mcp"], ["GET", "/api/me"],
    ["POST", "/api/approvals/x"], ["GET", "/api/agents/tokens"], ["POST", "/api/agents/tokens"], ["GET", "/api/agents/runs"], ["POST", "/api/assistant"], ["GET", "/automation"]];
  for (const [m, p] of routes) assert.equal(tokenRoute(m, p, "agent").ok, tokenRoute(m, p).ok, `${m} ${p}`);
  assert.deepEqual(tokenRoute("POST", "/api/approvals/x"), { ok: false, error: "API tokens can't approve or reject requests — a person decides in the console (Automation → Approvals)." });
  assert.deepEqual(tokenRoute("POST", "/api/approvals/x", "agent"), { ok: false, error: "Agent tokens can't approve or reject requests — a person decides in the console (Automation → Approvals)." });
  assert.match((tokenRoute("GET", "/api/agents/tokens", "agent") as { error: string }).error, /^Agent tokens can only use the operations API/);
  assert.match((tokenRoute("GET", "/api/agents/tokens") as { error: string }).error, /^API tokens can only use the operations API/, "the dc_ wording is unchanged (docs/troubleshooting.md quotes it)");
});
