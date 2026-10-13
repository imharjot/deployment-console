import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ATTEMPTS, RUN_STATES, RUN_TRANSITIONS, STEP_STATES, TransitionError, assertRunTransition, assertStepTransition, backoffMs, canTransitionRun, canTransitionStep,
  claimableIn, interruptible, isFinalRun, isFinalStep, isPendingStep, isRunState, isStepState, parseAgentsEnv, resolveAgentsEnabled, settleExecute,
} from "./run-state.ts";
import type { RunState, StepState } from "./records.ts";

test("terminal run and step states are final: nothing moves them (except reconciliation of an unknown outcome)", () => {
  for (const from of ["succeeded", "failed", "cancelled"] as RunState[]) for (const to of RUN_STATES) assert.equal(canTransitionRun(from, to), from === to, `${from} → ${to}`);
  for (const from of ["succeeded", "failed", "cancelled", "skipped"] as StepState[]) for (const to of STEP_STATES) assert.equal(canTransitionStep(from, to), from === to, `${from} → ${to}`);
  for (const s of ["succeeded", "failed", "cancelled", "outcome_unknown"] as RunState[]) assert.ok(isFinalRun(s));
  for (const s of ["queued", "running", "waiting_approval", "waiting_external", "paused_auth", "paused_budget"] as RunState[]) assert.equal(isFinalRun(s), false);
  assert.ok(isFinalStep("outcome_unknown") && !isFinalStep("leased"));
  assert.ok(isPendingStep("queued") && isPendingStep("leased") && isPendingStep("waiting") && !isPendingStep("succeeded"));
});

test("outcome_unknown becomes succeeded or failed only through reconciliation — never by an ordinary update", () => {
  for (const to of RUN_STATES.filter((s) => s !== "outcome_unknown")) assert.equal(canTransitionRun("outcome_unknown", to), false, to);
  assert.ok(canTransitionRun("outcome_unknown", "succeeded", { reconcile: true }));
  assert.ok(canTransitionRun("outcome_unknown", "failed", { reconcile: true }));
  assert.equal(canTransitionRun("outcome_unknown", "running", { reconcile: true }), false);
  assert.ok(canTransitionStep("outcome_unknown", "succeeded", { reconcile: true }));
  assert.equal(canTransitionStep("outcome_unknown", "queued", { reconcile: true }), false, "an unknown outcome is never retried");
  assert.throws(() => assertRunTransition("outcome_unknown", "succeeded"), (e: unknown) => e instanceof TransitionError && /only a reconciliation/.test(e.message) && e.status === 409);
  assert.throws(() => assertStepTransition("succeeded", "queued"), /a step that is succeeded can't become queued/);
});

test("the transition table names only real states and a run can always be cancelled until it ends", () => {
  for (const [from, tos] of Object.entries(RUN_TRANSITIONS)) {
    assert.ok(isRunState(from));
    for (const to of tos) assert.ok(isRunState(to), `${from} → ${to}`);
    if (!isFinalRun(from as RunState)) assert.ok(canTransitionRun(from as RunState, "cancelled"), `${from} can be cancelled`);
  }
  assert.ok(canTransitionRun("running", "waiting_approval") && canTransitionRun("waiting_approval", "running"));
  assert.ok(canTransitionRun("running", "outcome_unknown") && !canTransitionRun("queued", "outcome_unknown"));
  assert.ok(canTransitionStep("leased", "outcome_unknown") && !canTransitionStep("queued", "outcome_unknown"), "only a claimed step can lose track of its change");
  assert.equal(isStepState("leased"), true);
  assert.equal(isStepState("done"), false);
});

test("claimable: ended runs keep only verify steps; paused runs make no model or tool calls but keep verifying", () => {
  for (const run of ["succeeded", "failed", "cancelled", "outcome_unknown", "paused_auth", "paused_budget"] as RunState[]) {
    assert.equal(claimableIn(run, { kind: "model" }), false, run);
    assert.equal(claimableIn(run, { kind: "verify" }), true, run);
  }
  for (const run of ["queued", "running", "waiting_approval", "waiting_external"] as RunState[]) assert.equal(claimableIn(run, { kind: "execute" }), true, run);
  assert.equal(claimableIn("running", { kind: "model" }, { cancelRequested: true }), false, "a run being cancelled starts nothing new");
  assert.equal(claimableIn("running", { kind: "verify" }, { cancelRequested: true }), true, "but keeps checking what it changed");
  assert.ok(interruptible({ kind: "model" }) && interruptible({ kind: "tool" }) && !interruptible({ kind: "execute" }) && !interruptible({ kind: "verify" }));
});

test("a paused run resumes or ends; one paused over budget stays so when its connection is revoked too", () => {
  assert.ok(canTransitionRun("paused_auth", "running") && canTransitionRun("paused_budget", "cancelled"));
  assert.equal(canTransitionRun("paused_budget", "paused_auth"), false);
  assert.equal(canTransitionRun("paused_auth", "outcome_unknown"), false, "a paused run made no change it could lose track of");
});

test("execute steps are settled by their operations: nothing submitted, in doubt, failed or succeeded", () => {
  assert.equal(settleExecute([]), "none", "no operation row: nothing reached AWS, running again is safe");
  for (const s of ["running", "queued", "outcome_unknown"]) assert.equal(settleExecute([s]), "unknown", s);
  assert.equal(settleExecute(["succeeded", "running"]), "unknown", "one in doubt makes the step in doubt");
  assert.equal(settleExecute(["failed", "outcome_unknown"]), "unknown", "a failure next to an unknown is still in doubt");
  assert.equal(settleExecute(["weird"]), "unknown", "an unexpected state fails towards verifying, never towards a retry");
  assert.equal(settleExecute(["failed"]), "failed");
  assert.equal(settleExecute(["cancelled"]), "failed");
  assert.equal(settleExecute(["succeeded", "failed"]), "failed");
  assert.equal(settleExecute(["succeeded", "succeeded"]), "succeeded");
});

test("backoff doubles from 2 s, is capped at 5 min and jitters up to 20%", () => {
  assert.equal(backoffMs(1), 2_000);
  assert.equal(backoffMs(2), 4_000);
  assert.equal(backoffMs(0), 2_000);
  assert.equal(backoffMs(30), 300_000);
  assert.equal(backoffMs(1, 1), 2_400);
  assert.equal(backoffMs(1, 5), 2_400, "jitter is clamped");
  assert.ok(MAX_ATTEMPTS >= 3);
});

test("agents switch: CONSOLE_AGENTS wins, then the admin toggle, then on with the simulated account only", () => {
  assert.deepEqual(resolveAgentsEnabled({ env: "on", setting: "off", source: "aws" }), { on: true, source: "env" });
  assert.deepEqual(resolveAgentsEnabled({ env: "off", setting: "on", source: "mock" }), { on: false, source: "env" });
  assert.deepEqual(resolveAgentsEnabled({ env: "maybe", source: "mock" }), { on: false, source: "env" }, "a typo fails closed");
  assert.deepEqual(resolveAgentsEnabled({ setting: "on", source: "aws" }), { on: true, source: "settings" });
  assert.deepEqual(resolveAgentsEnabled({ setting: "off", source: "mock" }), { on: false, source: "settings" });
  assert.deepEqual(resolveAgentsEnabled({ setting: "garbage", source: "aws" }), { on: false, source: "default" });
  assert.deepEqual(resolveAgentsEnabled({ source: "mock" }), { on: true, source: "default" });
  assert.deepEqual(resolveAgentsEnabled({ source: undefined }), { on: true, source: "default" });
  assert.deepEqual(resolveAgentsEnabled({ source: "aws" }), { on: false, source: "default" });
  assert.equal(parseAgentsEnv("  "), undefined);
  assert.equal(parseAgentsEnv("TRUE"), true);
});
