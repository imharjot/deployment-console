// The AWS connection's live state and its generation, shared through globalThis: the routes and the instrumentation
// bundle (the sampler) load separate copies of every module. Every switch bumps the generation, and whatever was
// made for an earlier one is refused rather than hunted down:
// - SDK clients refuse to send and their calls in flight are aborted (aws-limiter.ts);
// - Clouds and CI sources refuse calls (retire());
// - cache fills started earlier answer their callers but are never stored (cache.ts);
// - background writers compare the generation they started with before writing.
// Then the stores read through globalThis on every use are dropped here, and each module that keeps a store in a
// module constant clears it in place from its own hook (onConnectionChange). aws-limiter.ts, cache.ts and sources.ts
// read `gen` and `ctrl` from the same globalThis object inline: their imports must not change (CODEX gotchas).
// No "server-only" import: mock.ts imports this, and tests load mock.ts without the react-server condition.
import { createHash } from "node:crypto";
import type { EffectiveConnection, SavedConnection } from "../connection-rules.ts";

export interface ConnectionState {
  gen: number;
  ctrl: AbortController; // aborted, with a ConnectionChangedError, when the generation moves on
  hooks: Map<string, () => void>; // keyed by module, so the second bundle's copy replaces the first's
  saved?: SavedConnection | null; // undefined until loadConnection() has read the console database
  effective?: EffectiveConnection; // sources.ts and regions.ts read it; undefined = the environment alone
  scope?: { key: string; since: number }; // whose data the console holds (connection.ts ensureScope)
  scopeVerifiedGen?: number; // the generation whose account AWS confirmed matches `scope` (until then the sampler retries)
  identity?: { account: string; arn: string; at: number }; // the last one AWS confirmed for this connection
  unloaded?: boolean; // the console database couldn't be read at boot: the connection is unknown (sources.ts refuses)
  switching?: boolean; // a switch is under way: no change may start (mutations.ts)
  writes?: number; // changes in flight in this process (mutations.ts), which a switch waits for
  switchedAt?: number; // the last switch, for what starts counting afresh (the CI watcher)
}

const g = globalThis as Record<string, unknown> & { __consoleConnection?: ConnectionState };
export const connectionState = (): ConnectionState => (g.__consoleConnection ??= { gen: 0, ctrl: new AbortController(), hooks: new Map() });
export const generation = (): number => connectionState().gen;

// Whose data a page shows (the scope: source, account and home region), as an opaque token: GET /api/me hands it to
// the page, which sends it with every write (x-console-connection), and http.ts refuses a write from a page loaded
// before a switch to another account or home region. "" until the console has recorded a scope.
export const connectionToken = (): string => {
  const key = connectionState().scope?.key;
  return key ? createHash("sha256").update(key).digest("base64url").slice(0, 16) : "";
};

export const connectionChanged = (): Error =>
  Object.assign(new Error("the AWS connection changed while this was being read; try again"), { name: "ConnectionChangedError", status: 503 });
export const isConnectionChanged = (e: unknown): boolean => (e as { name?: unknown } | null)?.name === "ConnectionChangedError";

// Stores their modules read through globalThis on every use: dropping them is their reset.
const DROPPED = [
  "__consoleCloud", "__consoleClouds", "__consoleCi", // sources.ts: the Clouds and the CI source, with their SDK clients
  "__consoleBilling", "__consoleCosts", "__consoleCostsInflight", // billing.ts: the source and the costs snapshot
  "__consoleEnabledRegions", // regions.ts: the account's enabled regions (all-enabled)
  "__consoleRegionErrors", // discovery.ts: regions skipped for a minute after failing
  "__consoleInventory", // inventory.ts: runs, the built map, the account id, activity metrics
  "__computeEcsHosts", "__computeEks", "__consoleEnvFilesDeniedUntil", "__ecsImagePlans", // providers' hints
];

// A module's reset for the next connection: clear what it keeps in a module constant, in place (the other bundle's
// copy holds the same object).
export function onConnectionChange(name: string, reset: () => void): void {
  connectionState().hooks.set(name, reset);
}

// The switch itself, after the new connection is in state: retire the old generation, then reset.
export function bumpGeneration(): number {
  const s = connectionState();
  const old = s.ctrl;
  s.gen++;
  s.switchedAt = Date.now();
  s.ctrl = new AbortController();
  old.abort(connectionChanged());
  for (const k of DROPPED) delete g[k];
  for (const [name, reset] of s.hooks) {
    try {
      reset();
    } catch (e) {
      console.error(JSON.stringify({ level: 50, msg: "connection switch: a module's reset failed", module: name, err: (e as Error)?.message }));
    }
  }
  return s.gen;
}

// A value rebuilt for each generation: a module-level SDK client, a credentials provider.
export function perGeneration<T>(make: () => T): () => T {
  let held: { gen: number; value: T } | undefined;
  return () => {
    const gen = generation();
    if (!held || held.gen !== gen) held = { gen, value: make() };
    return held.value;
  };
}

// `value` with its methods refusing calls (ConnectionChangedError) once the generation it was made in is over: a caller
// still holding a Cloud from before a switch can't fill the new connection's caches with the old one's data.
export function retire<T extends object>(value: T, born = generation()): T {
  return new Proxy(value, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (generation() !== born) throw connectionChanged();
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
