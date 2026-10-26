// What the console's AWS identity may do (F06): an IAM policy simulation refreshed at most every 10 minutes, plus what
// real calls taught us (a refusal or a success, remembered for 10 minutes). Rules are pure in capability-rules.ts.
// UI rule: denied disables the control with a reason, probably-denied warns, unknown shows nothing.
// The actions covered are the console's own writes (ALL_WRITE_ACTIONS) plus every cloud-map provider's declared write
// actions, which the map's action runner and the permissions routes register with watchActions(); a new set of
// actions is simulated on the next refresh. ECS service actions are simulated against a real service per cluster
// (and ecs:RunTask against its task definition): a policy scoped to services is an implicit deny for "*". There, an
// implicit deny that needed no context values in every cluster is a denial; elsewhere it is only "probably" (the
// simulation can't see service control policies, resource policies or tag conditions). A real refusal (AccessDenied)
// always wins over it.
import "server-only";
import { ALL_WRITE_ACTIONS, combine, decide, ECS_WRITE_ACTIONS, OBSERVED_TTL_MS, simulationFailureNote, VAR_REFERENCE_READS, type SimDecision } from "../capability-rules.ts";
import type { CapabilityView, CapState } from "../types.ts";
import { observeCalls } from "./aws-limiter.ts";
import { accessDeniedOf, errText } from "./errors.ts";
import { getCloud, sourceKind } from "./sources.ts";

const REFRESH_MS = 10 * 60_000;
const MAX_WATCHED = 500;

interface Store {
  simulated?: Record<string, SimDecision>;
  simulatedFor?: string; // the action list the last attempt covered
  checkedAt?: number; // last simulation attempt that produced a result
  attemptedAt?: number; // last attempt, successful or not
  note?: string;
  observed: Map<string, { deniedAt?: number; allowedAt?: number; resource?: string }>;
  watched?: Set<string>; // provider write actions (watchActions)
  refreshing?: Promise<void>;
}

// On globalThis: the SDK wrapper notes refusals from the sampler's bundle and routes read them from theirs.
const S: Store = ((globalThis as { __consoleCapability?: Store }).__consoleCapability ??= { observed: new Map() });
S.watched ??= new Set();
const watched = () => (S.watched ??= new Set());

const IAM_ACTION = /^[a-z0-9-]+:[A-Za-z0-9]+$/;

// The map's write actions (providers' `write` lists, actions' `iam`): remembered from real calls and simulated like the
// console's own. IAM actions only (Cloudflare token scopes aren't AWS's to judge). Never throws.
export function watchActions(actions: Iterable<string>): void {
  const w = watched();
  for (const a of actions) if (w.size < MAX_WATCHED && typeof a === "string" && IAM_ACTION.test(a) && !a.startsWith("cloudflare:")) w.add(a);
}

// A real call was refused (AccessDenied). Called by the central send wrapper; never throws.
export function noteDenied(action: string, resource?: string): void {
  const o = S.observed.get(action) ?? {};
  S.observed.set(action, { ...o, deniedAt: Date.now(), resource });
}

// A real call succeeded: clears a remembered refusal for that action. Never throws.
export function noteAllowed(action: string): void {
  S.observed.set(action, { allowedAt: Date.now() });
}

// The actions real calls are remembered for: the ones console writes (and reveals) need, and the map's write actions.
// Others — an inventory read that is refused, say — are the providers' business, and remembering every action AWS
// names would grow without bound.
const OBSERVED = new Set([...ALL_WRITE_ACTIONS, ...Object.values(VAR_REFERENCE_READS)]);
const remembered = (action: string) => OBSERVED.has(action) || watched().has(action);

// Every AWS call goes through the SDK wrapper (aws-limiter.ts), which reports here. A refusal names the action it
// refused (iam:PassRole inside ecs:CreateService, say); otherwise the call's own action is the one refused. Registered
// when this module loads (instrumentation.ts loads it at boot); observations are kept on globalThis like the rest.
observeCalls(({ action, error }) => {
  if (error === undefined) {
    if (remembered(action)) noteAllowed(action);
    return;
  }
  const denied = accessDeniedOf(error);
  if (!denied) return;
  const refused = denied.action ?? action;
  if (remembered(refused)) noteDenied(refused, denied.resource);
});

function stateOf(action: string, now: number): CapState {
  const o = S.observed.get(action);
  return decide({ simulated: S.simulated?.[action], deniedAt: o?.deniedAt, allowedAt: o?.allowedAt }, now, OBSERVED_TTL_MS);
}

// The capability for one console write, as the IAM actions it needs. `missing` lists the ones denied or probably denied.
export function capability(actions: readonly string[]): { state: CapState; why?: string; missing: string[] } {
  const now = Date.now();
  const states = actions.map((a) => [a, stateOf(a, now)] as const);
  const state = combine(states.map(([, s]) => s));
  const missing = states.filter(([, s]) => s === "denied" || s === "probably-denied").map(([a]) => a);
  if (state === "denied") {
    const hard = states.filter(([, s]) => s === "denied").map(([a]) => a);
    const seen = hard.some((a) => S.observed.get(a)?.deniedAt !== undefined && now - S.observed.get(a)!.deniedAt! < OBSERVED_TTL_MS);
    return { state, missing, why: `The console's AWS identity can't ${hard.join(", ")}${seen ? " (AWS refused it recently)" : " (denied by its IAM policy)"}` };
  }
  if (state === "probably-denied") return { state, missing, why: `The console's IAM policy probably doesn't allow ${missing.join(", ")}; AWS may refuse this` };
  return { state, missing };
}

// Everything simulated: the console's writes and the map's, sorted.
const wanted = () => [...new Set([...ALL_WRITE_ACTIONS, ...watched()])].sort();

// Simulate every console write at most every 10 minutes (force: now; also as soon as new actions are watched). Never
// throws: a failure becomes the note "not verified: …" and the previous result (if any) stays. The simulated account
// allows everything.
export function refreshCapability(force = false): Promise<void> {
  const now = Date.now();
  if (S.refreshing) return S.refreshing;
  const list = wanted();
  const forList = list.join(",");
  const grown = S.attemptedAt !== undefined && S.simulatedFor !== forList;
  if (!force && !grown && S.attemptedAt !== undefined && now - S.attemptedAt < REFRESH_MS) return Promise.resolve();
  S.attemptedAt = now;
  S.simulatedFor = forList; // a failed attempt waits REFRESH_MS like a good one, unless the list changes again
  const run = (async () => {
    try {
      if (sourceKind() === "mock") {
        S.simulated = Object.fromEntries(list.map((a) => [a, "allowed" as const]));
        S.checkedAt = Date.now();
        S.note = undefined;
        return;
      }
      const cloud = await getCloud();
      if (!cloud.simulate) {
        S.note = "not verified: this AWS source can't simulate IAM policies";
        return;
      }
      // Real resources to simulate against; never fatal — without them every action is simulated against "*".
      const targets = await import("./discovery.ts").then((d) => d.simulationTargetsNow()).catch(() => ({}));
      const result = await cloud.simulate(list, targets);
      const clean: Record<string, SimDecision> = {};
      for (const a of list) {
        const d = Object.hasOwn(result, a) ? result[a] : undefined;
        if (d === "allowed" || d === "implicitDeny" || d === "explicitDeny" || d === "resourceDeny") clean[a] = d;
      }
      // Nothing back: the role may not simulate its own policy. That verifies nothing (real calls still teach).
      if (!Object.keys(clean).length) {
        S.note = "not verified: the console's role can't simulate its own policy (iam:SimulatePrincipalPolicy)";
        return;
      }
      S.simulated = clean;
      S.checkedAt = Date.now();
      S.note = undefined;
    } catch (e) {
      S.note = simulationFailureNote(e as { name?: unknown; message?: unknown }, errText(e));
    }
  })();
  S.refreshing = run;
  void run.finally(() => {
    if (S.refreshing === run) S.refreshing = undefined;
  });
  return run;
}

// GET /api/capability returns this.
export function capabilityView(): CapabilityView {
  const now = Date.now();
  const actions: Record<string, CapState> = {};
  for (const a of new Set([...wanted(), ...S.observed.keys()])) actions[a] = stateOf(a, now);
  const denied = Object.keys(actions).filter((a) => actions[a] === "denied" || actions[a] === "probably-denied").sort();
  const freshObservation = [...S.observed.values()].some((o) => [o.deniedAt, o.allowedAt].some((t) => t !== undefined && now - t < OBSERVED_TTL_MS));
  const view: CapabilityView = {
    source: S.simulated ? "simulated" : freshObservation ? "observed" : "none",
    readOnly: ECS_WRITE_ACTIONS.every((a) => actions[a] === "denied" || actions[a] === "probably-denied"),
    actions,
    denied,
  };
  if (S.checkedAt !== undefined) view.checkedAt = S.checkedAt;
  if (S.note) view.note = S.note;
  return view;
}
