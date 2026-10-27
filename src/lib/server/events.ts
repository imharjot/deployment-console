// Outbound notifications. `emit()` is fire-and-forget: it never throws and never blocks the caller.
// Each enabled notify integration whose subscription matches gets the event (5 s timeout, one retry); every attempt is
// recorded in `deliveries`. The same event key is suppressed per integration for 60 s (flapping protection).
// State lives on globalThis: Next bundles instrumentation and routes separately, and both must share one cache.
import "server-only";
import { ciFailedEvent, createDeduper, describe, eventKey, newFailures, route, type ConsoleEvent, type Subscription } from "../plugins/events.ts";
import { PLUGINS } from "../plugins/registry.ts";
import type { Config, Plugin } from "../plugins/types.ts";
import type { CiRun } from "../types.ts";
import { runs } from "./ci.ts";
import { getDb } from "./db.ts";
import { knownRepos, listEnvs } from "./discovery.ts";
import { connectionState } from "./connection-state.ts";
import { errText } from "./errors.ts";
import { configOf, pruneDeliveries, readAll, recordDelivery } from "./plugins/store.ts";

// ---------- deep links ----------

const publicUrl = () => (process.env.CONSOLE_PUBLIC_URL || "http://localhost:3200").replace(/\/+$/, "");
export const consoleUrl = (path: string) => `${publicUrl()}${path.startsWith("/") ? path : `/${path}`}`;
export const serviceUrl = (env: string, id: string) => consoleUrl(`/?env=${encodeURIComponent(env)}&r=service:${encodeURIComponent(id)}`);

// ---------- delivery ----------

interface Target {
  id: string;
  enabled: boolean;
  capabilities: Plugin["capabilities"];
  subscription: Subscription;
  plugin: Plugin;
  cfg: Config;
}

const CACHE_MS = 10_000;
const TIMEOUT_MS = 5_000;
const KEEP_MS = 14 * 24 * 3600_000;

type EventsState = { targets?: { at: number; list: Promise<Target[]> }; dedupe: ReturnType<typeof createDeduper>; prunedAt: number };
const g = globalThis as { __consoleEvents?: EventsState };
const st = (g.__consoleEvents ??= { dedupe: createDeduper(60_000), prunedAt: 0 });

async function loadTargets(): Promise<Target[]> {
  const rows = await readAll();
  const out: Target[] = [];
  for (const p of PLUGINS) {
    const i = rows.get(p.id);
    if (!i?.enabled || !p.notify) continue;
    try {
      out.push({ id: p.id, enabled: true, capabilities: p.capabilities, subscription: i.subscription, plugin: p, cfg: configOf(p.fields, i.stored) });
    } catch (e) {
      console.error(JSON.stringify({ level: 40, msg: "integration config unreadable", integration: p.id, err: errText(e) }));
    }
  }
  return out;
}

function targets(): Promise<Target[]> {
  if (!st.targets || Date.now() - st.targets.at > CACHE_MS) {
    const list = loadTargets();
    st.targets = { at: Date.now(), list };
    list.catch(() => (st.targets = undefined));
  }
  return st.targets.list;
}

// Call after an integration is saved or removed so the next event sees it.
export function invalidateIntegrations() {
  st.targets = undefined;
}

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms).unref?.())]);

const summary = (e: ConsoleEvent) => describe(e).title;

async function deliver(t: Target, e: ConsoleEvent): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await withTimeout(t.plugin.notify!(t.cfg, e), TIMEOUT_MS + 500);
      await recordDelivery(t.id, e.type, true, `${summary(e)}${attempt > 1 ? " (after retry)" : ""}`).catch(() => {});
      return true;
    } catch (err) {
      await recordDelivery(t.id, e.type, false, `${summary(e)} — ${errText(err)}${attempt > 1 ? " (retry)" : ""}`).catch(() => {});
      if (attempt === 1) await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  return false;
}

async function dispatch(e: ConsoleEvent) {
  const key = eventKey(e);
  const due = route(await targets(), e).filter((t) => st.dedupe(t.id, key));
  await Promise.all(due.map((t) => deliver(t, e)));
  if (due.length && Date.now() - st.prunedAt > 3600_000) {
    st.prunedAt = Date.now();
    await pruneDeliveries(KEEP_MS);
  }
}

// The agent outbox (src/lib/server/agents/outbox.ts): delivers one event now and says which integrations failed, so
// only those are tried again later. `only` limits delivery to one integration (a retry). No dedupe: the outbox row
// itself guarantees each integration gets the event once it succeeds.
export async function deliverEvent(e: ConsoleEvent, only?: string): Promise<{ delivered: string[]; failed: string[] }> {
  const due = route(await targets(), e).filter((t) => !only || t.id === only);
  const results = await Promise.all(due.map(async (t) => [t.id, await deliver(t, e)] as const));
  return { delivered: results.filter(([, ok]) => ok).map(([id]) => id), failed: results.filter(([, ok]) => !ok).map(([id]) => id) };
}

export function emit(e: ConsoleEvent): void {
  try {
    dispatch(e).catch((err) => console.error(JSON.stringify({ level: 40, msg: "event dispatch failed", type: e.type, err: errText(err) })));
  } catch {
    /* never let a notification break the caller */
  }
}

// Admin "Send test": bypasses subscriptions and dedupe, records the attempt, and throws so the UI can show why.
export async function sendTest(p: Plugin, cfg: Config, actor: string): Promise<string> {
  const e: ConsoleEvent = { type: "test", at: Date.now(), url: consoleUrl("/settings/integrations"), message: `Sent by ${actor} from Settings → Integrations.` };
  try {
    await withTimeout(p.notify!(cfg, e), TIMEOUT_MS + 500);
  } catch (err) {
    await recordDelivery(p.id, "test", false, `Test — ${errText(err)}`).catch(() => {});
    throw err;
  }
  await recordDelivery(p.id, "test", true, `Test sent by ${actor}`);
  return "Test notification delivered";
}

// ---------- CI watcher ----------

const HWM_KEY = "events.ci.hwm"; // JSON { repo: ms } — newest completed run already considered, per repo

async function checkCi(started: number) {
  const db = await getDb();
  const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [HWM_KEY]);
  const marks = ((row && JSON.parse(row.value)) ?? {}) as Record<string, number>;
  const envs = await listEnvs();
  let changed = !row;
  for (const repo of await knownRepos()) {
    let list: CiRun[];
    try {
      list = await runs(repo, undefined);
    } catch {
      continue; // GitHub hiccup: try again next minute
    }
    // A repo seen for the first time starts at the watcher's start, so old failures are never announced.
    const { failed, hwm } = newFailures(list, marks[repo] ?? started);
    for (const r of failed) emit(ciFailedEvent(r, envs, consoleUrl("/ci")));
    if (hwm !== marks[repo]) {
      marks[repo] = hwm;
      changed = true;
    }
  }
  if (changed) await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [HWM_KEY, JSON.stringify(marks)]);
}

export function startCiWatcher() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const w = globalThis as { __consoleCiWatcher?: ReturnType<typeof setInterval> };
  if (w.__consoleCiWatcher) return;
  const started = Date.now();
  // A repo seen for the first time starts at the watcher's start or the last switch of the AWS connection, whichever is
  // later: a new account's (or the demo's) earlier failures are never announced.
  const tick = () => {
    checkCi(Math.max(started, connectionState().switchedAt ?? 0)).catch((e) => console.error(JSON.stringify({ level: 40, msg: "ci watcher failed", err: errText(e) })));
  };
  w.__consoleCiWatcher = setInterval(tick, 60_000);
  w.__consoleCiWatcher.unref?.();
  setTimeout(tick, 5_000).unref?.();
}
