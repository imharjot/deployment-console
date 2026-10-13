// The agents switch and the emergency stop (master plan §3.4, §6 C2 item 4).
//
// agentsEnabled(): CONSOLE_AGENTS when set (on/off; anything else is off), else the admin's toggle (settings key
// agents:enabled, Automation → Agents), else on with the simulated account and off against a real one. While off, agent
// tokens and runs are refused (503) and the worker claims nothing.
//
// The emergency stop (settings key agents:stop → { on, by, at, reason }) blocks every agent change at once, whatever
// any policy says and whether or not a model is reachable: the registry refuses agent mutations with 423 and the worker
// leaves execute steps waiting. It always wins over the switch. Both are cached for 2 s on globalThis (the routes, the
// proxy and the worker read them from different bundles); a change made on this instance clears the cache at once.
import "server-only";
import { resolveAgentsEnabled, type AgentsSource } from "../../agents/run-state.ts";
import { writeAudit } from "../audit.ts";
import { getDb, type Db } from "../db.ts";
import { HttpError, errText } from "../errors.ts";
import { sourceKind } from "../sources.ts";
import { publish } from "./events.ts";

export const STOP_KEY = "agents:stop";
export const ENABLED_KEY = "agents:enabled";
const CACHE_MS = 2_000;

export interface StopState {
  on: boolean;
  by?: string;
  at?: number;
  reason?: string;
}

const g = globalThis as { __consoleAgentSwitch?: { stop?: { v: StopState; at: number }; enabled?: { v: string | null; at: number } } };
const cache = (g.__consoleAgentSwitch ??= {});
export const forgetAgentSwitches = () => {
  cache.stop = undefined;
  cache.enabled = undefined;
};

async function readSetting(key: string): Promise<string | null> {
  const r = await (await getDb()).get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
  return r?.value ?? null;
}
const writeSetting = (db: Db, key: string, value: string) =>
  db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);

// A switch change, audited like every write (grants.ts does the same): the intent is on the record before the change
// (one that can't be written refuses it), the setting and the "ok" result commit together (a setting that can't be
// written leaves no "ok" behind, but an "error" result next to its intent), then this instance's cache is dropped.
async function auditedSwitch(base: { action: string; user: string; ip?: string; reason?: string; params: Record<string, unknown> }, write: (db: Db) => Promise<unknown>) {
  const db = await getDb();
  const entry = { env: "", target: "agents", ...base };
  try {
    await writeAudit({ ...entry, at: Date.now(), phase: "intent" }, db);
  } catch (e) {
    throw new HttpError(503, `audit log unavailable, change refused: ${errText(e)}`);
  }
  try {
    await db.tx(async (t) => {
      await write(t);
      await writeAudit({ ...entry, at: Date.now(), phase: "result", result: "ok" }, t);
    });
  } catch (e) {
    await writeAudit({ ...entry, at: Date.now(), phase: "result", result: "error", detail: errText(e).slice(0, 300) }, db).catch(() => {});
    throw e;
  } finally {
    forgetAgentSwitches();
  }
}

function parseStop(raw: string | null): StopState {
  if (!raw) return { on: false };
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object") return { on: true, reason: "the emergency stop setting is unreadable — treated as on" };
    return {
      on: v.on !== false, // anything but an explicit false is on: a damaged row must not turn the stop off
      by: typeof v.by === "string" ? v.by : undefined,
      at: typeof v.at === "number" ? v.at : undefined,
      reason: typeof v.reason === "string" ? v.reason : undefined,
    };
  } catch {
    return { on: true, reason: "the emergency stop setting is unreadable — treated as on" };
  }
}

// A database that can't be read counts as "stopped": the stop must hold when the DB is in doubt.
export async function isEmergencyStopped(): Promise<StopState> {
  const now = Date.now();
  if (cache.stop && now - cache.stop.at < CACHE_MS) return cache.stop.v;
  let v: StopState;
  try {
    v = parseStop(await readSetting(STOP_KEY));
  } catch (e) {
    return { on: true, reason: `the console database is unavailable (${errText(e)}) — agent changes are held` };
  }
  cache.stop = { v, at: now };
  return v;
}

// Admin only (the route checks). Audited first: a stop that can't be recorded is refused, like every other change.
export async function setEmergencyStop(on: boolean, by: string, reason?: string, ip?: string): Promise<StopState> {
  const why = reason?.trim().slice(0, 500) || undefined;
  if (on && !why) throw new HttpError(400, "a reason is required to turn the emergency stop on");
  const at = Date.now();
  const state: StopState = on ? { on: true, by, at, reason: why } : { on: false, by, at, reason: why };
  const action = on ? "agents.emergency_stop" : "agents.emergency_stop_lifted";
  // The event commits with the change (people only: no agent may watch for the stop to lift).
  await auditedSwitch({ action, user: by, ip, reason: why, params: { on } }, async (t) => {
    await writeSetting(t, STOP_KEY, JSON.stringify(state));
    await publish("action", { env: "", action, target: "agents", user: by, reason: why, result: "ok", at }, { audience: { people: true }, topic: "agents", db: t });
  });
  return state;
}

export async function agentsEnabled(): Promise<{ on: boolean; source: AgentsSource }> {
  const now = Date.now();
  let setting: string | null;
  if (cache.enabled && now - cache.enabled.at < CACHE_MS) setting = cache.enabled.v;
  else {
    try {
      setting = await readSetting(ENABLED_KEY);
    } catch {
      setting = "off"; // unreadable → off (fails closed), unless CONSOLE_AGENTS says otherwise
    }
    cache.enabled = { v: setting, at: now };
  }
  return resolveAgentsEnabled({ env: process.env.CONSOLE_AGENTS, setting, source: sourceKind() });
}

// Admin only. Has no effect while CONSOLE_AGENTS is set (the response says so).
export async function setAgentsEnabled(on: boolean, by: string, ip?: string): Promise<{ on: boolean; source: AgentsSource; overridden: boolean }> {
  const action = on ? "agents.enable" : "agents.disable";
  await auditedSwitch({ action, user: by, ip, params: { enabled: on } }, async (t) => {
    await writeSetting(t, ENABLED_KEY, on ? "on" : "off");
    await publish("action", { env: "", action, target: "agents", user: by, result: "ok", at: Date.now() }, { audience: { people: true }, topic: "agents", db: t });
  });
  const now = await agentsEnabled();
  return { ...now, overridden: now.source === "env" };
}

// The registry's and the proxy's refusals, worded once.
export const AGENTS_OFF = "agents are turned off on this console";
export const STOPPED = "emergency stop is on: agents can't change anything until an admin lifts it";
