import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_FORBIDDEN_FIELDS, HUMAN_FIELDS, RUN_TOKEN_MAX_MS, agentActor, agentTokenDisplayPrefix, isAgentTokenShape, parsePrincipal, principalSummary, runTokenExpiry,
  withoutHumanFields,
} from "./identity.ts";
import type { AgentPrincipal } from "./types.ts";

const P: AgentPrincipal = { id: "agent:r1", kind: "agent", runId: "r1", delegatorId: "u1", delegatorEmail: "alice@acme.test", policyHash: "sha256:abc", mode: "propose" };

test("agent token shape: da_ + 43 base64url characters", () => {
  const t = `da_${"A".repeat(43)}`;
  assert.ok(isAgentTokenShape(t));
  assert.equal(isAgentTokenShape(`dc_${"A".repeat(43)}`), false);
  assert.equal(isAgentTokenShape(`da_${"A".repeat(42)}`), false);
  assert.equal(isAgentTokenShape(`da_${"A".repeat(42)}+`), false);
  assert.equal(isAgentTokenShape(undefined), false);
  assert.equal(agentTokenDisplayPrefix(t), "da_AAAAAAA");
});

test("run tokens never outlive the run's deadline, nor a day", () => {
  const now = 1_000_000;
  assert.equal(runTokenExpiry(now, 60_000, now + 10_000), now + 10_000);
  assert.equal(runTokenExpiry(now, 60_000, null), now + 60_000);
  assert.equal(runTokenExpiry(now, 10 * RUN_TOKEN_MAX_MS, undefined), now + RUN_TOKEN_MAX_MS);
  assert.equal(runTokenExpiry(now, 60_000, now - 1), now + 60_000, "a passed deadline doesn't make a negative ttl (the run is failed by reconciliation)");
});

test("parsePrincipal reads stored principals and refuses anything malformed", () => {
  assert.deepEqual(parsePrincipal(JSON.stringify(P)), P);
  assert.deepEqual(parsePrincipal({ ...P, agentVersion: 2, extra: "ignored" }), { ...P, agentVersion: 2 });
  assert.equal(parsePrincipal("{"), undefined);
  assert.equal(parsePrincipal({ ...P, kind: "person" }), undefined);
  assert.equal(parsePrincipal({ ...P, mode: "god" }), undefined);
  assert.equal(parsePrincipal({ ...P, delegatorId: "" }), undefined);
  assert.equal(parsePrincipal({ ...P, runId: 5 }), undefined);
  assert.equal(parsePrincipal({ ...P, agentVersion: -1 }), undefined);
  assert.equal(parsePrincipal(Object.assign(Object.create({ kind: "agent" }), { ...P, kind: undefined })), undefined, "own properties only");
  assert.equal(parsePrincipal(null), undefined);
});

test("audit actor and /api/me summary name the agent and the person, never a role or secret", () => {
  assert.equal(agentActor(P), "agent run r1 for alice@acme.test");
  assert.equal(agentActor({ ...P, runId: "0123456789abcdef" }, "ci-bot"), 'agent run 01234567 via agent token "ci-bot" for alice@acme.test');
  assert.deepEqual(principalSummary(P), { kind: "agent", runId: "r1", delegator: "alice@acme.test", mode: "propose", policyHash: "sha256:abc" });
});

test("human-only fields are never part of what an agent's grant binds", () => {
  assert.deepEqual(withoutHumanFields({ env: "staging", service: "api", confirm: "api", reason: "x", migrationAck: true }), { env: "staging", service: "api" });
  assert.ok(AGENT_FORBIDDEN_FIELDS.every((f) => (HUMAN_FIELDS as readonly string[]).includes(f)));
});
